import { runPlannedDependencyInstallWithNetworkWindow } from "../../../pipeline/03-repo-preparation/dependency-install-network-window";
import { SubmittedCodeNetworkResealError } from "../../../pipeline/03-repo-preparation/dependency-install-network-window";
import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import {
  executeSubmittedCode,
  executeSubmittedRuntime,
  syncSubmittedCodeWorkspace,
} from "../../../pipeline/03-repo-preparation/submitted-code-execution";
import { inspectSubmittedCodeToolchain } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain-inspection";
import type { SubmittedCodeToolchainPlan } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import type {
  SandboxRunner,
  SandboxValidationInput,
  SandboxValidationOutput,
} from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/sandbox-runner.interface";
import {
  boundValidationEvidence,
  validationEvidenceCaps,
} from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/validation-evidence";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";

export class DaytonaSandboxRunner implements SandboxRunner {
  private readonly releaseWorkspaceOnCleanup: boolean;
  private readonly logger: PipelineEventLogger | undefined;
  private readonly readinessPollIntervalMs: number;
  private readonly readinessTimeoutMs: number;

  constructor(
    options: {
      releaseWorkspaceOnCleanup?: boolean;
      logger?: PipelineEventLogger;
      readinessPollIntervalMs?: number;
      readinessTimeoutMs?: number;
    } = {},
  ) {
    this.releaseWorkspaceOnCleanup = options.releaseWorkspaceOnCleanup ?? false;
    this.logger = options.logger;
    this.readinessPollIntervalMs = options.readinessPollIntervalMs ?? 1_000;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  }

  async runValidation(
    input: SandboxValidationInput & {
      preparationManifest: PreparationManifest;
      preparationWorkspace?: PreparationWorkspaceHandle;
    },
  ): Promise<SandboxValidationOutput> {
    if (input.preparationWorkspace === undefined) {
      throw new Error("Daytona validation requires the prepared workspace.");
    }

    const handle = input.preparationWorkspace;
    const refreshedToolchain = await inspectSubmittedCodeToolchain(
      handle.workspace,
    );
    if (refreshedToolchain.mode === "unsupported") {
      throw new Error(
        `Submitted code toolchain is unsupported (${refreshedToolchain.code}): ${refreshedToolchain.reason}`,
      );
    }
    handle.toolchainPlan = refreshedToolchain.plan;
    requireToolchainPlan(handle, "Daytona validation");
    const writeSandboxLog = (entry: Record<string, unknown>) =>
      writeSandboxLogBestEffort({
        entry: {
          ...sanitizeSandboxLogEntry(entry),
          level: readValidationLogLevel(entry),
          repoUrl: input.repoUrl,
          stage: "project-validation",
          workspaceId: input.preparationManifest.workspaceId,
        },
        logger: this.logger,
        stage: "project-validation",
        write: (logEntry) => handle.workspace.writeSandboxLog?.(logEntry),
      });

    try {
      await writeSandboxLog({ event: "project-validation.started" });
      await syncSubmittedCodeWorkspace(handle.workspace);
      await writeSandboxLog({ event: "project-validation.repo-files.started" });
      const repoFilesResult = await executeSubmittedCode(
        handle.workspace,
        "find /workspace -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort",
      );
      const repoFiles = repoFilesResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      await writeSandboxLog({
        event: "project-validation.repo-files.succeeded",
        repoFileCount: repoFiles.length,
      });
      const installResult =
        input.preparationManifest.dependencyInstall === "not-required"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : await this.runDependencyInstall({
              handle,
              writeSandboxLog,
            });
      if (input.preparationManifest.dependencyInstall === "not-required") {
        await writeSandboxLog({
          event: "project-validation.dependency-install.skipped",
          reason: "manifest-not-required",
        });
      } else if (installResult.exitCode !== 0) {
        await this.cleanup(handle);
        return {
          blockedNetworkAttempts: [],
          failureKind: "dependency-install-failed",
          failureReason: "Dependency installation failed inside the sandbox.",
          logs: [
            ...collectLogs(repoFilesResult),
            ...collectLogs(installResult),
          ],
          repoFiles,
          runtimeExitCode: installResult.exitCode,
        };
      }
      await writeSandboxLog({
        command: input.demoCommand,
        event: "project-validation.demo-command.started",
        url: input.url,
      });
      await executeSubmittedCode(
        handle.workspace,
        createStopDemoCommand(input.demoCommand),
      );
      const runtimeResult = await executeDemoStart(handle, input.demoCommand);
      await writeSandboxLog({
        event: "project-validation.demo-command.launched",
        exitCode: runtimeResult.exitCode,
        stdout: runtimeResult.stdout,
      });
      await writeSandboxLog({
        event: "project-validation.demo-readiness.started",
        url: input.url,
      });
      const readinessResult = await waitForDemoReadiness({
        execute: (command) => executeSubmittedCode(handle.workspace, command),
        pollIntervalMs: this.readinessPollIntervalMs,
        timeoutMs: this.readinessTimeoutMs,
        url: input.url,
      });
      if (readinessResult.exitCode !== 0) {
        await writeSandboxLog({
          event: "project-validation.demo-readiness.failed",
          stderr: readinessResult.stderr,
          stdout: readinessResult.stdout,
          url: input.url,
        });
        const demoStateResult = await executeSubmittedCode(
          handle.workspace,
          createDemoProcessStateCommand(),
        );
        const demoLogsResult = await readDemoServerLog(handle);
        await writeDemoServerLog(writeSandboxLog, demoLogsResult.stdout);
        const serverLog = boundValidationEvidence(
          demoLogsResult.stdout,
          validationEvidenceCaps.server,
        ).text;

        return {
          blockedNetworkAttempts: [],
          cleanup: () => this.cleanup(handle),
          failureKind: readDemoProcessFailureKind(demoStateResult.stdout),
          failureReason: readDemoProcessFailureReason(demoStateResult.stdout),
          logs: [
            ...collectLogs(repoFilesResult),
            ...collectLogs(installResult),
            ...collectLogs(runtimeResult),
            ...collectLogs(readinessResult),
            ...collectLogs(demoStateResult),
          ],
          repoFiles,
          runtimeExitCode:
            parseDemoProcessState(demoStateResult.stdout).exitCode ?? 1,
          ...(serverLog.length === 0 ? {} : { serverLog }),
        };
      }
      await writeSandboxLog({
        event: "project-validation.demo-readiness.succeeded",
        url: input.url,
      });
      await writeSandboxLog({
        event: "project-validation.fresh-capture-baseline.started",
      });
      const baselineResult = await executeSubmittedCode(
        handle.workspace,
        createFreshCaptureBaselineCommand(),
      );
      if (baselineResult.exitCode !== 0) {
        await writeSandboxLog({
          event: "project-validation.fresh-capture-baseline.failed",
          stderr: baselineResult.stderr,
          stdout: baselineResult.stdout,
        });
        return {
          blockedNetworkAttempts: [],
          cleanup: () => this.cleanup(handle),
          failureKind: "fresh-capture-baseline-failed",
          failureReason: "Fresh Capture baseline could not be created.",
          logs: [
            ...collectLogs(repoFilesResult),
            ...collectLogs(installResult),
            ...collectLogs(runtimeResult),
            ...collectLogs(readinessResult),
            ...collectLogs(baselineResult),
          ],
          repoFiles,
          runtimeExitCode: 1,
        };
      }
      await writeSandboxLog({
        event: "project-validation.fresh-capture-baseline.created",
      });
      const demoLogsResult = await readDemoServerLog(handle);
      await writeDemoServerLog(writeSandboxLog, demoLogsResult.stdout);
      await writeSandboxLog({
        event: "project-validation.browser-preview.started",
        port: readPortFromLocalUrl(input.url),
        url: input.url,
      });
      const browserUrl = await createBrowserPreviewUrl({
        localUrl: input.url,
        workspace: handle.workspace,
      });
      await writeSandboxLog({
        browserUrl,
        event: "project-validation.browser-preview.created",
      });

      return {
        blockedNetworkAttempts: [],
        browserUrl,
        cleanup: () => this.cleanup(handle),
        logs: [
          ...collectLogs(repoFilesResult),
          ...collectLogs(installResult),
          ...collectLogs(runtimeResult),
          ...collectLogs(readinessResult),
        ],
        ...(demoLogsResult.stdout.length === 0
          ? {}
          : {
              serverLog: boundValidationEvidence(
                demoLogsResult.stdout,
                validationEvidenceCaps.server,
              ).text,
            }),
        localUrl: input.url,
        previewUrl: browserUrl,
        repoFiles,
        runtimeExitCode: runtimeResult.exitCode,
      };
    } catch (error) {
      if (error instanceof SubmittedCodeNetworkResealError) {
        await handle.release();
      }
      await this.cleanup(handle);
      throw error;
    }
  }

  private async cleanup(handle: PreparationWorkspaceHandle): Promise<void> {
    if (this.releaseWorkspaceOnCleanup) {
      await handle.release();
    }
  }

  private async runDependencyInstall(input: {
    handle: PreparationWorkspaceHandle;
    writeSandboxLog: (entry: Record<string, unknown>) => Promise<void>;
  }): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    const toolchainPlan = requireToolchainPlan(
      input.handle,
      "Daytona validation",
    );
    if (toolchainPlan.install === undefined) {
      const blocker = toolchainPlan.installBlocker;
      throw new Error(
        `Daytona validation cannot install dependencies (${blocker?.code ?? "missing_immutable_install"}): ${blocker?.reason ?? "No catalog-owned immutable install is available."}`,
      );
    }
    await input.writeSandboxLog({
      argv: toolchainPlan.install.argv,
      event: "project-validation.dependency-install.started",
      executable: toolchainPlan.install.executable,
    });
    const installResult = await runPlannedDependencyInstallWithNetworkWindow({
      toolchainPlan,
      workspace: input.handle.workspace,
    });
    if (installResult.exitCode !== 0) {
      await input.writeSandboxLog({
        argv: toolchainPlan.install.argv,
        event: "project-validation.dependency-install.failed",
        executable: toolchainPlan.install.executable,
        exitCode: installResult.exitCode,
        stderr: installResult.stderr,
        stdout: installResult.stdout,
      });
      return installResult;
    }
    await input.writeSandboxLog({
      argv: toolchainPlan.install.argv,
      event: "project-validation.dependency-install.succeeded",
      executable: toolchainPlan.install.executable,
      exitCode: installResult.exitCode,
    });
    return installResult;
  }
}

export async function restartPreparedDemoForFreshCapture(input: {
  preparationManifest: PreparationManifest;
  preparationWorkspace: PreparationWorkspaceHandle;
  readinessPollIntervalMs?: number;
  readinessTimeoutMs?: number;
}): Promise<{ browserUrl: string }> {
  const refreshedToolchain = await inspectSubmittedCodeToolchain(
    input.preparationWorkspace.workspace,
  );
  if (refreshedToolchain.mode === "unsupported") {
    throw new Error(
      `Submitted code toolchain is unsupported (${refreshedToolchain.code}): ${refreshedToolchain.reason}`,
    );
  }
  input.preparationWorkspace.toolchainPlan = refreshedToolchain.plan;
  requireToolchainPlan(input.preparationWorkspace, "Fresh Footage Capture");
  const writeSandboxLog = (entry: Record<string, unknown>) =>
    writeSandboxLogBestEffort({
      entry: {
        ...entry,
        repoUrl: input.preparationManifest.repoUrl,
        stage: "footage-capture",
        workspaceId: input.preparationManifest.workspaceId,
      },
      stage: "footage-capture",
      write: (logEntry) =>
        input.preparationWorkspace.workspace.writeSandboxLog?.(logEntry),
    });

  await writeSandboxLog({
    command: input.preparationManifest.demoCommand,
    event: "footage-capture.fresh-state.restart.started",
    url: input.preparationManifest.url,
  });
  await executeSubmittedCode(
    input.preparationWorkspace.workspace,
    createStopDemoCommand(input.preparationManifest.demoCommand),
  );
  const restoreResult = await executeSubmittedCode(
    input.preparationWorkspace.workspace,
    createFreshCaptureRestoreCommand(),
  );
  if (restoreResult.exitCode !== 0) {
    await writeSandboxLog({
      event: "footage-capture.fresh-state.restore.failed",
      stderr: restoreResult.stderr,
      stdout: restoreResult.stdout,
    });
    throw new Error("Fresh Footage Capture baseline could not be restored.");
  }
  await writeSandboxLog({
    event: "footage-capture.fresh-state.restore.succeeded",
  });
  const runtimeResult = await executeDemoStart(
    input.preparationWorkspace,
    input.preparationManifest.demoCommand,
  );
  await writeSandboxLog({
    event: "footage-capture.fresh-state.restart.launched",
    exitCode: runtimeResult.exitCode,
    stdout: runtimeResult.stdout,
  });
  const readinessResult = await waitForDemoReadiness({
    execute: (command) =>
      executeSubmittedCode(input.preparationWorkspace.workspace, command),
    pollIntervalMs: input.readinessPollIntervalMs ?? 1_000,
    timeoutMs: input.readinessTimeoutMs ?? 30_000,
    url: input.preparationManifest.url,
  });
  if (runtimeResult.exitCode !== 0 || readinessResult.exitCode !== 0) {
    await writeSandboxLog({
      event: "footage-capture.fresh-state.restart.failed",
      runtimeExitCode: runtimeResult.exitCode,
      stderr: readinessResult.stderr,
      stdout: readinessResult.stdout,
      url: input.preparationManifest.url,
    });
    throw new Error("Fresh Footage Capture state did not become ready.");
  }

  const browserUrl = await createBrowserPreviewUrl({
    localUrl: input.preparationManifest.url,
    workspace: input.preparationWorkspace.workspace,
  });
  await writeSandboxLog({
    browserUrl,
    event: "footage-capture.fresh-state.restart.succeeded",
  });

  return { browserUrl };
}

async function executeDemoStart(
  handle: PreparationWorkspaceHandle,
  demoCommand: string,
) {
  const plan = requireToolchainPlan(handle, "Demo runtime startup");
  return await executeSubmittedRuntime(handle.workspace, {
    command: createStartDemoScript(demoCommand),
    plan,
  });
}

function requireToolchainPlan(
  handle: PreparationWorkspaceHandle,
  seam: string,
): SubmittedCodeToolchainPlan {
  if (handle.toolchainPlan === undefined) {
    throw new Error(`${seam} requires an authoritative toolchain plan.`);
  }
  return handle.toolchainPlan;
}

async function writeDemoServerLog(
  writeSandboxLog: (entry: Record<string, unknown>) => Promise<void>,
  output: string,
): Promise<void> {
  if (output.length === 0) {
    return;
  }

  await writeSandboxLog({
    event: "project-validation.demo-server-log",
    level: "debug",
    log: boundValidationEvidence(output, validationEvidenceCaps.server).text,
  });
}

async function writeSandboxLogBestEffort(input: {
  entry: Record<string, unknown>;
  logger?: PipelineEventLogger | undefined;
  stage: string;
  write: (entry: Record<string, unknown>) => Promise<void> | undefined;
}): Promise<void> {
  try {
    void input.write(input.entry)?.catch((error) => {
      warnSandboxLogWriteFailed(input, error);
    });
  } catch (error) {
    warnSandboxLogWriteFailed(input, error);
  }
}

function readValidationLogLevel(entry: Record<string, unknown>) {
  if (
    entry.level === "debug" ||
    entry.level === "error" ||
    entry.level === "info" ||
    entry.level === "warn"
  ) {
    return entry.level;
  }
  const event = typeof entry.event === "string" ? entry.event : "";
  if (event.includes("demo-server-log")) {
    return "debug";
  }
  return event.includes("failed") ? "warn" : "info";
}

function sanitizeSandboxLogEntry(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeSandboxLogValue(entry, "") as Record<string, unknown>;
}

function sanitizeSandboxLogValue(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (/data:image\/|screenshot:|^[A-Za-z0-9+/]{512,}={0,2}$/i.test(value)) {
      return "[binary diagnostic omitted]";
    }
    return boundValidationEvidence(
      value,
      key === "log" ? validationEvidenceCaps.server : 2 * 1024,
    ).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSandboxLogValue(item, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeSandboxLogValue(nestedValue, nestedKey),
      ]),
    );
  }
  return value;
}

function warnSandboxLogWriteFailed(
  input: {
    entry: Record<string, unknown>;
    logger?: PipelineEventLogger | undefined;
    stage: string;
  },
  error: unknown,
): void {
  try {
    void input.logger
      ?.warn(
        {
          error: readErrorMessage(error),
          event: "sandbox-log-write-failed",
          failedEvent:
            typeof input.entry.event === "string"
              ? input.entry.event
              : undefined,
          stage: input.stage,
          workspaceComponent: "sandbox-log",
        },
        "Sandbox progress log write failed.",
      )
      .catch(() => undefined);
  } catch {
    // Preserve validation and capture behavior if the fallback logger also fails.
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectLogs(result: { stderr: string; stdout: string }): string[] {
  return [result.stdout, result.stderr].filter((line) => line.length > 0);
}

export function createStartDemoScript(
  demoCommand: string,
  workspacePath = "/workspace",
  stateDirectory = "/tmp",
  sessionCommand = "setsid",
): string {
  const exitCodePath = `${stateDirectory}/makeademo-demo.exit-code`;
  const logPath = `${stateDirectory}/makeademo-demo.log`;
  const pidPath = `${stateDirectory}/makeademo-demo.pid`;
  const sessionPrefix = sessionCommand.length === 0 ? "" : `${sessionCommand} `;
  return `cd ${shellQuote(workspacePath)} && rm -f ${shellQuote(exitCodePath)} && nohup ${sessionPrefix}sh -c ${shellQuote(`sh -c ${shellQuote(`exec ${demoCommand}`)}; status=$?; echo "$status" > ${shellQuote(exitCodePath)}; exit "$status"`)} > ${shellQuote(logPath)} 2>&1 & echo $! > ${shellQuote(pidPath)} && echo $!`;
}

function createDemoProcessStateCommand(): string {
  return 'if test -f /tmp/makeademo-demo.exit-code && grep -Eq "^[0-9]+$" /tmp/makeademo-demo.exit-code; then echo exited:$(cat /tmp/makeademo-demo.exit-code); elif test -f /tmp/makeademo-demo.pid && kill -0 "$(cat /tmp/makeademo-demo.pid 2>/dev/null)" >/dev/null 2>&1; then echo running; else echo exited; fi';
}

function readDemoProcessFailureKind(
  output: string,
): "demo-process-exited" | "demo-readiness-timeout" {
  return output.trim().startsWith("running")
    ? "demo-readiness-timeout"
    : "demo-process-exited";
}

export function parseDemoProcessState(output: string): {
  exitCode?: number;
  running: boolean;
} {
  const match = /^exited:(\d+)\s*$/.exec(output.trim());
  if (match?.[1] !== undefined) {
    return { exitCode: Number(match[1]), running: false };
  }
  return { running: output.trim() === "running" };
}

function readDemoProcessFailureReason(output: string): string {
  const state = parseDemoProcessState(output);
  return state.exitCode === undefined
    ? "Demo URL did not become ready inside the sandbox."
    : `Demo process exited with code ${state.exitCode} before becoming ready.`;
}

async function readDemoServerLog(handle: PreparationWorkspaceHandle) {
  return await executeSubmittedCode(
    handle.workspace,
    "if test -f /tmp/makeademo-demo.log; then tail -c 16384 /tmp/makeademo-demo.log; fi",
  );
}

function createStopDemoCommand(demoCommand: string): string {
  return `sh -lc ${shellQuote(
    [
      "kill_demo_pid() {",
      '  pid="$1"',
      '  if test -n "$pid" && kill -0 "$pid" >/dev/null 2>&1; then',
      '    kill -- -"$pid" >/dev/null 2>&1 || true',
      '    kill "$pid" >/dev/null 2>&1 || true',
      "  fi",
      "}",
      "if test -f /tmp/makeademo-demo.pid; then",
      '  kill_demo_pid "$(cat /tmp/makeademo-demo.pid 2>/dev/null)"',
      "  rm -f /tmp/makeademo-demo.pid",
      "fi",
      `demo_command=${shellQuote(demoCommand)}`,
      "for cmdline_path in /proc/[0-9]*/cmdline; do",
      '  test -r "$cmdline_path" || continue',
      '  pid="${cmdline_path#/proc/}"',
      '  pid="${pid%/cmdline}"',
      '  test "$pid" != "$$" || continue',
      "  cmdline=$(tr '\\0' ' ' < \"$cmdline_path\" 2>/dev/null || true)",
      '  case "$cmdline" in',
      '    *"/workspace"*"$demo_command"*|*"/workspace"*"apps/makeademo-demo/server.ts"*) kill_demo_pid "$pid" ;;',
      "  esac",
      "done",
    ].join("\n"),
  )}`;
}

function createFreshCaptureBaselineCommand(): string {
  const excludeArguments = freshCapturePreservedPathPatterns
    .map((pattern) => `--exclude=${shellQuote(pattern)}`)
    .join(" ");

  return `sh -lc ${shellQuote(`mkdir -p /workspace/.makeademo && tar ${excludeArguments} -czf /workspace/.makeademo/fresh-capture-baseline.tgz -C /workspace .`)}`;
}

function createFreshCaptureRestoreCommand(): string {
  const preservedPathPredicates = freshCapturePreservedPathPatterns
    .map((pattern) => `! -path ${shellQuote(toWorkspacePathPattern(pattern))}`)
    .join(" ");
  const findWorkspace = `find /workspace -mindepth 1 ${preservedPathPredicates}`;

  return `sh -lc ${shellQuote(
    [
      "test -f /workspace/.makeademo/fresh-capture-baseline.tgz",
      `${findWorkspace} ! -type d -exec rm -f {} +`,
      `${findWorkspace} -depth -type d -empty -exec rmdir {} +`,
      "tar -xzf /workspace/.makeademo/fresh-capture-baseline.tgz -C /workspace",
    ].join(" && "),
  )}`;
}

const freshCapturePreservedPathPatterns = [
  "./.makeademo",
  "./.makeademo/*",
  "./node_modules",
  "./node_modules/*",
  "./*/node_modules",
  "./*/node_modules/*",
  "./.npm",
  "./.npm/*",
  "./*/.npm",
  "./*/.npm/*",
  "./.pnpm-store",
  "./.pnpm-store/*",
  "./*/.pnpm-store",
  "./*/.pnpm-store/*",
  "./.yarn/cache",
  "./.yarn/cache/*",
  "./*/.yarn/cache",
  "./*/.yarn/cache/*",
  "./.cache",
  "./.cache/*",
  "./*/.cache",
  "./*/.cache/*",
  "./.vite",
  "./.vite/*",
  "./*/.vite",
  "./*/.vite/*",
  "./.turbo",
  "./.turbo/*",
  "./*/.turbo",
  "./*/.turbo/*",
  "./.next/cache",
  "./.next/cache/*",
  "./*/.next/cache",
  "./*/.next/cache/*",
];

function toWorkspacePathPattern(tarPattern: string): string {
  return `/workspace/${tarPattern.slice(2)}`;
}

async function waitForDemoReadiness(input: {
  execute: PreparationWorkspaceHandle["workspace"]["execute"];
  pollIntervalMs: number;
  timeoutMs: number;
  url: string;
}) {
  const attempts = Math.max(
    1,
    Math.ceil(input.timeoutMs / Math.max(1, input.pollIntervalMs)),
  );
  let lastResult = {
    exitCode: 1,
    stderr: "",
    stdout: `Demo URL did not become ready: ${input.url}`,
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = await input.execute(createDemoReadinessCommand(input.url));
    if (lastResult.exitCode === 0) {
      return lastResult;
    }

    if (input.pollIntervalMs > 0 && attempt < attempts - 1) {
      await delay(input.pollIntervalMs);
    }
  }

  return {
    exitCode: 1,
    stderr: lastResult.stderr,
    stdout:
      lastResult.stdout.length > 0
        ? lastResult.stdout
        : `Demo URL did not become ready: ${input.url}`,
  };
}

function createDemoReadinessCommand(url: string): string {
  return `node -e ${shellQuote("fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));")} ${shellQuote(url)}`;
}

function readPortFromLocalUrl(url: string): number {
  const parsedUrl = new URL(url);
  if (parsedUrl.port.length > 0) {
    return Number(parsedUrl.port);
  }

  return parsedUrl.protocol === "https:" ? 443 : 80;
}

async function createBrowserPreviewUrl(input: {
  localUrl: string;
  workspace: PreparationWorkspaceHandle["workspace"];
}): Promise<string> {
  const localUrl = new URL(input.localUrl);
  const previewUrl = new URL(
    await input.workspace.getPreviewUrl(readPortFromLocalUrl(input.localUrl)),
  );
  previewUrl.pathname = localUrl.pathname;
  previewUrl.search = localUrl.search;
  previewUrl.hash = localUrl.hash;

  return previewUrl.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
