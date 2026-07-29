import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import {
  SubmittedCodeToolchainProvisioningError,
  SubmittedCodeWorkspaceSyncError,
} from "../../03-repo-preparation/submitted-code-execution";
import type { SubmittedCodeNodeReleaseCatalog } from "../../03-repo-preparation/submitted-code-node-release-catalog.interface";
import { inspectSubmittedCodeToolchain } from "../../03-repo-preparation/submitted-code-toolchain-inspection";
import type { BrowserValidator } from "./browser-validator.interface";
import {
  type NetworkAttempt,
  findRuntimeBoundaryViolations,
} from "./network-isolation-policy";
import type { SandboxRunner } from "./sandbox-runner.interface";
import {
  boundValidationEvidence,
  boundValidationLogs,
  validationEvidenceCaps,
} from "./validation-evidence";
import type { DemoRuntimePreflightResult } from "./validation-result";

export type DemoRuntimePreflightInput = {
  preparationManifest: PreparationManifest;
  /** Retained workspace carrying the authoritative catalog runtime selection. */
  preparationWorkspace: PreparationWorkspaceHandle;
};

export type DemoRuntimePreflightDependencies = {
  browserValidationTimeoutMs?: number;
  browserValidator: BrowserValidator;
  nodeReleaseCatalog: SubmittedCodeNodeReleaseCatalog;
  sandboxRunner: SandboxRunner;
};

const defaultBrowserValidationTimeoutMs = 60_000;

export async function runDemoRuntimePreflight(
  input: DemoRuntimePreflightInput,
  dependencies: DemoRuntimePreflightDependencies,
): Promise<DemoRuntimePreflightResult> {
  let sandboxResult: Awaited<ReturnType<SandboxRunner["runValidation"]>>;
  try {
    let inspectedToolchain: Awaited<
      ReturnType<typeof inspectSubmittedCodeToolchain>
    >;
    try {
      inspectedToolchain = await inspectSubmittedCodeToolchain(
        input.preparationWorkspace.workspace,
        dependencies.nodeReleaseCatalog,
      );
    } catch (error) {
      throw new SubmittedToolchainInspectionError(error);
    }
    if (inspectedToolchain.mode === "unsupported") {
      throw new Error(inspectedToolchain.reason);
    }
    input.preparationWorkspace.toolchainPlan = inspectedToolchain.plan;
    sandboxResult = await dependencies.sandboxRunner.runValidation({
      demoCommand: input.preparationManifest.demoCommand,
      preparationManifest: input.preparationManifest,
      preparationWorkspace: input.preparationWorkspace,
      repoUrl: input.preparationManifest.repoUrl,
      url: input.preparationManifest.url,
    });
  } catch (error) {
    const failureReason = readErrorMessage(error);
    await writeDemoRuntimePreflightSandboxLog(input, {
      event: "demo-runtime-preflight.failed",
      failureReason,
    });
    return {
      blockedNetworkAttempts: [],
      ...(error instanceof SubmittedCodeWorkspaceSyncError
        ? { failureKind: error.failureKind }
        : error instanceof SubmittedCodeToolchainProvisioningError
          ? { failureKind: error.failureKind }
          : error instanceof SubmittedToolchainInspectionError
            ? { failureKind: error.failureKind }
            : { failureKind: "sandbox-execution-failed" }),
      failureReason: boundValidationEvidence(
        failureReason,
        validationEvidenceCaps.failureReason,
      ).text,
      logs: boundValidationLogs([failureReason]),
      status: "failed",
      warnings: [],
    };
  }
  const toolchainWarnings =
    input.preparationWorkspace.toolchainPlan.warnings?.map(
      ({ reason, source, value }) =>
        boundToolchainWarning(`${reason} (${source}: ${value})`),
    ) ?? [];
  const blockedNetworkAttempts = findRuntimeBoundaryViolations(
    sandboxResult.blockedNetworkAttempts,
  );

  try {
    if (blockedNetworkAttempts.length > 0) {
      const failureReason = formatRuntimeNetworkFailureReason(
        blockedNetworkAttempts,
      );
      return {
        blockedNetworkAttempts,
        failureKind: "runtime-network-blocked",
        failureReason,
        logs: boundValidationLogs(sandboxResult.logs),
        status: "failed",
        warnings: toolchainWarnings,
      };
    }

    if (sandboxResult.runtimeExitCode !== 0) {
      return {
        blockedNetworkAttempts: [],
        ...(sandboxResult.failureKind === undefined
          ? {}
          : { failureKind: sandboxResult.failureKind }),
        ...(sandboxResult.failureReason === undefined
          ? {}
          : {
              failureReason: boundValidationEvidence(
                sandboxResult.failureReason,
                validationEvidenceCaps.failureReason,
              ).text,
            }),
        ...(sandboxResult.serverLog === undefined
          ? {}
          : {
              evidence: {
                serverLog: boundValidationEvidence(
                  sandboxResult.serverLog,
                  validationEvidenceCaps.server,
                ),
              },
            }),
        failureReason: boundValidationEvidence(
          sandboxResult.failureReason ??
            "Demo command failed inside the sandbox.",
          validationEvidenceCaps.failureReason,
        ).text,
        logs: boundValidationLogs(sandboxResult.logs),
        status: "failed",
        warnings: toolchainWarnings,
      };
    }

    const browserUrl =
      sandboxResult.browserUrl ?? input.preparationManifest.url;
    await writeDemoRuntimePreflightSandboxLog(input, {
      browserUrl,
      event: "demo-runtime-preflight.browser-validation.started",
    });
    const browserValidationTimeoutMs =
      dependencies.browserValidationTimeoutMs ??
      defaultBrowserValidationTimeoutMs;
    const browserValidationUrl = input.preparationManifest.url;
    let browserResult: Awaited<ReturnType<BrowserValidator["validate"]>>;
    try {
      browserResult = await withTimeout(
        dependencies.browserValidator.validate({
          preparationWorkspace: input.preparationWorkspace,
          url: browserValidationUrl,
        }),
        browserValidationTimeoutMs,
        `Browser validation timed out after ${browserValidationTimeoutMs}ms.`,
      );
    } catch (error) {
      if (error instanceof DemoRuntimePreflightTimeoutError) {
        await writeDemoRuntimePreflightSandboxLog(input, {
          browserUrl,
          event: "demo-runtime-preflight.browser-validation.failed",
          failureReason: error.message,
        });
        return {
          blockedNetworkAttempts: [],
          browserUrl,
          failureKind: "browser-validation-timeout",
          failureReason: boundValidationEvidence(
            error.message,
            validationEvidenceCaps.failureReason,
          ).text,
          logs: boundValidationLogs([...sandboxResult.logs, error.message]),
          localUrl: browserValidationUrl,
          ...(sandboxResult.previewUrl === undefined
            ? {}
            : { previewUrl: sandboxResult.previewUrl }),
          status: "failed",
          warnings: toolchainWarnings,
        };
      }

      await writeDemoRuntimePreflightSandboxLog(input, {
        browserUrl,
        event: "demo-runtime-preflight.browser-validation.failed",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const browserNetworkAttempts = findRuntimeBoundaryViolations(
      browserResult.blockedNetworkAttempts ?? [],
    );

    if (browserNetworkAttempts.length > 0) {
      const failureReason = formatRuntimeNetworkFailureReason(
        browserNetworkAttempts,
      );
      await writeDemoRuntimePreflightSandboxLog(input, {
        blockedNetworkAttemptCount: browserNetworkAttempts.length,
        blockedNetworkAttempts: browserNetworkAttempts,
        browserUrl,
        event: "demo-runtime-preflight.browser-validation.failed",
        failureReason,
        screenshotArtifactId: browserResult.screenshotArtifactId,
        ...(browserResult.screenshot === undefined
          ? {}
          : { screenshot: browserResult.screenshot }),
        evidence: mergeValidationEvidence(
          sandboxResult.serverLog,
          browserResult.logs,
        ),
      });
      return {
        blockedNetworkAttempts: browserNetworkAttempts,
        browserUrl,
        failureKind: "runtime-network-blocked",
        failureReason,
        logs: boundValidationLogs([
          ...sandboxResult.logs,
          ...browserResult.logs,
        ]),
        localUrl: browserValidationUrl,
        ...(sandboxResult.previewUrl === undefined
          ? {}
          : { previewUrl: sandboxResult.previewUrl }),
        screenshotArtifactId: browserResult.screenshotArtifactId,
        ...(browserResult.screenshot === undefined
          ? {}
          : { screenshot: browserResult.screenshot }),
        evidence: mergeValidationEvidence(
          sandboxResult.serverLog,
          browserResult.logs,
        ),
        status: "failed",
        warnings: toolchainWarnings,
      };
    }

    if (!browserResult.interactable) {
      const failureReason =
        readMakeADemoValidatorDependencyFailure(browserResult.logs) ??
        "Configured URL loaded but was not interactable.";
      await writeDemoRuntimePreflightSandboxLog(input, {
        browserUrl,
        event: "demo-runtime-preflight.browser-validation.failed",
        failureReason,
        screenshotArtifactId: browserResult.screenshotArtifactId,
        ...(browserResult.screenshot === undefined
          ? {}
          : { screenshot: browserResult.screenshot }),
        evidence: mergeValidationEvidence(
          sandboxResult.serverLog,
          browserResult.logs,
        ),
      });
      return {
        blockedNetworkAttempts: [],
        browserUrl,
        failureKind:
          browserResult.failureKind ??
          (readMakeADemoValidatorDependencyFailure(browserResult.logs) ===
          undefined
            ? "browser-not-interactable"
            : "validator-dependency-failed"),
        failureReason: boundValidationEvidence(
          failureReason,
          validationEvidenceCaps.failureReason,
        ).text,
        logs: boundValidationLogs([
          ...sandboxResult.logs,
          ...browserResult.logs,
        ]),
        localUrl: browserValidationUrl,
        ...(sandboxResult.previewUrl === undefined
          ? {}
          : { previewUrl: sandboxResult.previewUrl }),
        screenshotArtifactId: browserResult.screenshotArtifactId,
        ...(browserResult.screenshot === undefined
          ? {}
          : { screenshot: browserResult.screenshot }),
        evidence: mergeValidationEvidence(
          sandboxResult.serverLog,
          browserResult.logs,
        ),
        status: "failed",
        warnings: toolchainWarnings,
      };
    }

    await writeDemoRuntimePreflightSandboxLog(input, {
      browserUrl,
      event: "demo-runtime-preflight.browser-validation.succeeded",
      screenshotArtifactId: browserResult.screenshotArtifactId,
      ...(browserResult.screenshot === undefined
        ? {}
        : { screenshot: browserResult.screenshot }),
    });
    return {
      blockedNetworkAttempts: [],
      browserUrl,
      logs: boundValidationLogs([...sandboxResult.logs, ...browserResult.logs]),
      localUrl: browserValidationUrl,
      ...(sandboxResult.previewUrl === undefined
        ? {}
        : { previewUrl: sandboxResult.previewUrl }),
      screenshotArtifactId: browserResult.screenshotArtifactId,
      status: "succeeded",
      warnings: toolchainWarnings,
    };
  } finally {
    await cleanupQuietly(sandboxResult.cleanup);
  }
}

class SubmittedToolchainInspectionError extends Error {
  readonly failureKind = "submitted-toolchain-inspection-failed" as const;

  constructor(cause: unknown) {
    super(readErrorMessage(cause), { cause });
    this.name = "SubmittedToolchainInspectionError";
  }
}

function boundToolchainWarning(value: string): string {
  return value
    .replaceAll(
      /(^|[?&;\s])((?:token|api[_-]?key|secret|password)=)[^\s&;]+/gi,
      "$1$2***",
    )
    .slice(0, 1_000);
}

async function writeDemoRuntimePreflightSandboxLog(
  input: DemoRuntimePreflightInput,
  entry: Record<string, unknown>,
) {
  const write = input.preparationWorkspace.workspace.writeSandboxLog?.({
    ...entry,
    level:
      entry.level === "debug" ||
      entry.level === "error" ||
      entry.level === "info" ||
      entry.level === "warn"
        ? entry.level
        : typeof entry.event === "string" && entry.event.includes("failed")
          ? "warn"
          : "info",
    repoUrl: input.preparationManifest.repoUrl,
    stage: "demo-runtime-preflight",
    workspaceId: input.preparationManifest.workspaceId,
  });
  if (write === undefined) {
    return;
  }

  void write.catch(() => {});
}

async function cleanupQuietly(cleanup: (() => Promise<void>) | undefined) {
  try {
    await cleanup?.();
  } catch {
    // Preserve the validation result or error that triggered cleanup.
  }
}

class DemoRuntimePreflightTimeoutError extends Error {}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readMakeADemoValidatorDependencyFailure(logs: string[]) {
  for (const log of logs) {
    const match = /MakeADemo validator dependency failure:[^\n]*/.exec(log);
    if (match !== null) {
      return match[0];
    }
  }

  return undefined;
}

function formatRuntimeNetworkFailureReason(attempts: NetworkAttempt[]): string {
  const baseReason =
    "Runtime network communication across the sandbox boundary is not allowed.";
  const locations = attempts.map((attempt) => attempt.url ?? attempt.host);
  if (locations.length === 0) {
    return baseReason;
  }

  return `${baseReason} Blocked runtime network attempts: ${locations.join(", ")}.`;
}

function mergeValidationEvidence(
  serverLog: string | undefined,
  browserLogs: string[],
) {
  return {
    ...(serverLog === undefined
      ? {}
      : {
          serverLog: boundValidationEvidence(
            serverLog,
            validationEvidenceCaps.server,
          ),
        }),
    ...(browserLogs.length === 0
      ? {}
      : {
          browser: boundValidationEvidence(
            browserLogs.join("\n"),
            validationEvidenceCaps.browser,
          ),
        }),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new DemoRuntimePreflightTimeoutError(message)),
        timeoutMs,
      );
    }),
  ]);
}
