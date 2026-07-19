import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import { SubmittedCodeWorkspaceSyncError } from "../../03-repo-preparation/submitted-code-execution";
import type { BrowserValidator } from "./browser-validator.interface";
import { inferInstallPlan } from "./install-plan";
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
import type { ProjectValidationResult } from "./validation-result";

export type ProjectValidationInput = {
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
};

export type ProjectValidationDependencies = {
  browserValidationTimeoutMs?: number;
  browserValidator: BrowserValidator;
  sandboxRunner: SandboxRunner;
};

const defaultBrowserValidationTimeoutMs = 60_000;

export async function validateProject(
  input: ProjectValidationInput,
  dependencies: ProjectValidationDependencies,
): Promise<ProjectValidationResult> {
  let sandboxResult: Awaited<ReturnType<SandboxRunner["runValidation"]>>;
  try {
    sandboxResult = await dependencies.sandboxRunner.runValidation({
      demoCommand: input.preparationManifest.demoCommand,
      preparationManifest: input.preparationManifest,
      ...(input.preparationWorkspace === undefined
        ? {}
        : { preparationWorkspace: input.preparationWorkspace }),
      repoUrl: input.preparationManifest.repoUrl,
      url: input.preparationManifest.url,
    });
  } catch (error) {
    const failureReason = readErrorMessage(error);
    await writeProjectValidationSandboxLog(input, {
      event: "project-validation.failed",
      failureReason,
    });
    return {
      blockedNetworkAttempts: [],
      ...(error instanceof SubmittedCodeWorkspaceSyncError
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
  const installPlan = inferInstallPlan(sandboxResult.repoFiles);
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
        warnings: installPlan.warnings,
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
        warnings: installPlan.warnings,
      };
    }

    const browserUrl =
      sandboxResult.browserUrl ?? input.preparationManifest.url;
    await writeProjectValidationSandboxLog(input, {
      browserUrl,
      event: "project-validation.browser-validation.started",
    });
    const browserValidationTimeoutMs =
      dependencies.browserValidationTimeoutMs ??
      defaultBrowserValidationTimeoutMs;
    const browserValidationUrl =
      input.preparationWorkspace === undefined
        ? browserUrl
        : input.preparationManifest.url;
    let browserResult: Awaited<ReturnType<BrowserValidator["validate"]>>;
    try {
      browserResult = await withTimeout(
        dependencies.browserValidator.validate({
          ...(input.preparationWorkspace === undefined
            ? {}
            : { preparationWorkspace: input.preparationWorkspace }),
          url: browserValidationUrl,
        }),
        browserValidationTimeoutMs,
        `Browser validation timed out after ${browserValidationTimeoutMs}ms.`,
      );
    } catch (error) {
      if (error instanceof ProjectValidationTimeoutError) {
        await writeProjectValidationSandboxLog(input, {
          browserUrl,
          event: "project-validation.browser-validation.failed",
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
          ...(sandboxResult.browserUrl === undefined
            ? {}
            : { previewUrl: sandboxResult.browserUrl }),
          status: "failed",
          warnings: installPlan.warnings,
        };
      }

      await writeProjectValidationSandboxLog(input, {
        browserUrl,
        event: "project-validation.browser-validation.failed",
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
      await writeProjectValidationSandboxLog(input, {
        blockedNetworkAttemptCount: browserNetworkAttempts.length,
        blockedNetworkAttempts: browserNetworkAttempts,
        browserUrl,
        event: "project-validation.browser-validation.failed",
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
        ...(sandboxResult.browserUrl === undefined
          ? {}
          : { previewUrl: sandboxResult.browserUrl }),
        screenshotArtifactId: browserResult.screenshotArtifactId,
        ...(browserResult.screenshot === undefined
          ? {}
          : { screenshot: browserResult.screenshot }),
        evidence: mergeValidationEvidence(
          sandboxResult.serverLog,
          browserResult.logs,
        ),
        status: "failed",
        warnings: installPlan.warnings,
      };
    }

    if (!browserResult.interactable) {
      const failureReason =
        readMakeADemoValidatorDependencyFailure(browserResult.logs) ??
        "Configured URL loaded but was not interactable.";
      await writeProjectValidationSandboxLog(input, {
        browserUrl,
        event: "project-validation.browser-validation.failed",
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
        ...(sandboxResult.browserUrl === undefined
          ? {}
          : { previewUrl: sandboxResult.browserUrl }),
        screenshotArtifactId: browserResult.screenshotArtifactId,
        ...(browserResult.screenshot === undefined
          ? {}
          : { screenshot: browserResult.screenshot }),
        evidence: mergeValidationEvidence(
          sandboxResult.serverLog,
          browserResult.logs,
        ),
        status: "failed",
        warnings: installPlan.warnings,
      };
    }

    await writeProjectValidationSandboxLog(input, {
      browserUrl,
      event: "project-validation.browser-validation.succeeded",
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
      ...(sandboxResult.browserUrl === undefined
        ? {}
        : { previewUrl: sandboxResult.browserUrl }),
      screenshotArtifactId: browserResult.screenshotArtifactId,
      status: "succeeded",
      warnings: installPlan.warnings,
    };
  } finally {
    await cleanupQuietly(sandboxResult.cleanup);
  }
}

async function writeProjectValidationSandboxLog(
  input: ProjectValidationInput,
  entry: Record<string, unknown>,
) {
  const write = input.preparationWorkspace?.workspace.writeSandboxLog?.({
    ...entry,
    repoUrl: input.preparationManifest.repoUrl,
    stage: "project-validation",
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

class ProjectValidationTimeoutError extends Error {}

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
        () => reject(new ProjectValidationTimeoutError(message)),
        timeoutMs,
      );
    }),
  ]);
}
