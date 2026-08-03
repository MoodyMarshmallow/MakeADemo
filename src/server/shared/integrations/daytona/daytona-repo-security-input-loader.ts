import {
  runSettledPipelineOperation,
  throwIfPipelineDeadlineReached,
} from "../../../pipeline/00-orchestration/job/pipeline-cancellation";
import type { RepoSecurityInput } from "../../../pipeline/02-repo-security-screen/repo-security-screen";
import { createGitCloneCommand } from "../../../pipeline/02-repo-security-screen/repository-loading/git-clone-command";
import { runGitCloneWithTransientRetry } from "../../../pipeline/02-repo-security-screen/repository-loading/git-clone-retry";
import type {
  RepoSecurityInputLoadInput,
  RepoSecurityInputLoadResult,
  RepoSecurityInputLoader,
} from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-input-loader.interface";
import { runRepoSecurityScanners } from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-scanners";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";
import {
  DaytonaSdkPreparationWorkspaceProvider,
  type DaytonaSdkPreparationWorkspaceProviderOptions,
} from "./daytona-sdk-preparation-workspace-provider";
import {
  createDaytonaWorkspaceResetCommand,
  daytonaGitCaBundleCandidates,
  daytonaWorkspaceDirectory,
} from "./workspace-command";

/**
 * Executes backend-authored repository-loading commands. Implementations must
 * return the command's exit status and captured output and honor requested
 * timeouts.
 */
type RepositoryLoadingWorkspace = PreparationWorkspace;

/**
 * Owns one repository-loading workspace with a stable provider identifier.
 * `release` must be safe to call repeatedly and must settle only after the
 * workspace has been released or the release failure is known.
 */
export type RepositoryLoadingWorkspaceHandle = PreparationWorkspaceHandle;

/**
 * Creates a fresh, independently releasable repository-loading workspace for
 * each call. Implementations must not return a previously released handle.
 */
export interface RepositoryLoadingWorkspaceProvider {
  create(): Promise<RepositoryLoadingWorkspaceHandle>;
}

export type DaytonaRepoSecurityInputLoaderOptions = Pick<
  DaytonaSdkPreparationWorkspaceProviderOptions,
  "apiKey" | "sandboxLogSinks" | "snapshot"
> & {
  cloneWorkspaceRetryDelaysMs?: number[];
  logger?: PipelineEventLogger;
  provider?: RepositoryLoadingWorkspaceProvider;
  releaseTimeoutMs?: number;
};

const defaultWorkspaceReleaseTimeoutMs = 30_000;
const defaultCloneAttemptTimeoutMs = 120_000;
const defaultCloneWorkspaceRetryDelaysMs = [250, 500];
const maxCloneWorkspaceRetries = 2;

/** Daytona adapter for the Repo Security Screen's static input-loading seam. */
export class DaytonaRepoSecurityInputLoader implements RepoSecurityInputLoader {
  private readonly options: DaytonaRepoSecurityInputLoaderOptions;
  private readonly provider: RepositoryLoadingWorkspaceProvider;

  constructor(options: DaytonaRepoSecurityInputLoaderOptions = {}) {
    this.options = options;
    this.provider =
      options.provider ??
      new DaytonaSdkPreparationWorkspaceProvider({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.sandboxLogSinks === undefined
          ? {}
          : { sandboxLogSinks: options.sandboxLogSinks }),
        ...(options.snapshot === undefined
          ? {}
          : { snapshot: options.snapshot }),
      });
  }

  load(
    input: RepoSecurityInputLoadInput,
  ): Promise<RepoSecurityInputLoadResult> {
    return loadDaytonaRepoSecurityInput(this.provider, input, this.options);
  }
}

async function loadDaytonaRepoSecurityInput(
  provider: RepositoryLoadingWorkspaceProvider,
  input: RepoSecurityInputLoadInput,
  options: DaytonaRepoSecurityInputLoaderOptions,
): Promise<RepoSecurityInputLoadResult> {
  let activeHandle: RepositoryLoadingWorkspaceHandle | undefined;
  const operation = loadDaytonaRepoSecurityInputOperation(
    provider,
    input,
    options,
    (handle) => {
      activeHandle = handle;
    },
  );
  return await runSettledPipelineOperation({
    deadlineAt: input.deadlineAt,
    onCancel: async () => {
      await activeHandle?.workspace.cancelActiveCommands?.();
    },
    operation,
    signal: input.signal,
  });
}

async function loadDaytonaRepoSecurityInputOperation(
  provider: RepositoryLoadingWorkspaceProvider,
  input: RepoSecurityInputLoadInput,
  options: DaytonaRepoSecurityInputLoaderOptions,
  setActiveHandle: (
    handle: RepositoryLoadingWorkspaceHandle | undefined,
  ) => void,
): Promise<RepoSecurityInputLoadResult> {
  const cloneWorkspaceRetryDelaysMs =
    options.cloneWorkspaceRetryDelaysMs ?? defaultCloneWorkspaceRetryDelaysMs;

  for (let attempt = 0; ; attempt += 1) {
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    const handle = await provider.create();
    setActiveHandle(handle);
    const cloneStartedAt = Date.now();

    try {
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
      await logCloneEvent(options.logger, "started", input.repoUrl);
      if (input.repoVisibility === "private") {
        throw new Error(
          "Private repository source access requires a server-bound GitHub installation grant.",
        );
      }
      const cloneResult = await clone(
        handle.workspace,
        input.repoUrl,
        input.commitSha,
      );
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
      if (cloneResult.exitCode !== 0) {
        const error = new Error(
          `Daytona git clone failed: ${[cloneResult.stderr, cloneResult.stdout].filter((line) => line.length > 0).join("\n")}`,
        );
        throw error;
      }
      await logCloneEvent(options.logger, "succeeded", input.repoUrl);
    } catch (error) {
      const retryable =
        input.signal?.aborted !== true &&
        (input.deadlineAt === undefined || Date.now() < input.deadlineAt) &&
        attempt < maxCloneWorkspaceRetries &&
        isCloneWorkspaceRetryableError(error);
      await logCloneEvent(options.logger, "failed", input.repoUrl, {
        durationMs: Date.now() - cloneStartedAt,
        error,
        level: retryable ? "warn" : "error",
      });

      try {
        await releaseWorkspace(handle, options);
      } finally {
        setActiveHandle(undefined);
      }
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
      if (retryable) {
        await delay(cloneWorkspaceRetryDelaysMs[attempt] ?? 0);
        continue;
      }

      throw error;
    }

    const statsStartedAt = Date.now();
    let retained = false;
    try {
      try {
        throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
        await logStatsEvent(options.logger, "started");
        const scannerReports = await runRepoSecurityScanners(
          {
            executeRepositoryCommand: (command, commandOptions) =>
              executeRepositoryCommand(
                handle.workspace,
                command,
                commandOptions,
              ),
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
        throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);

        const baseline = await executeRepositoryCommand(
          handle.workspace,
          "git -C /workspace ls-files -z",
        );
        if (baseline.exitCode !== 0) {
          throw new Error(
            "Failed to inventory source-controlled submitted paths.",
          );
        }
        const baselineSourceControlledPaths = baseline.stdout
          .split("\0")
          .filter((path) => path.length > 0);
        await logStatsEvent(options.logger, "succeeded", {
          durationMs: Date.now() - statsStartedAt,
          fileCount: baselineSourceControlledPaths.length,
        });
        retained = true;
        return {
          baselineSourceControlledPaths,
          preparationWorkspace: handle,
          repoSecurity: { scannerReports },
        };
      } catch (error) {
        await logStatsEvent(options.logger, "failed", {
          durationMs: Date.now() - statsStartedAt,
          error,
        });
        throw error;
      }
    } finally {
      if (!retained) {
        try {
          await releaseWorkspace(handle, options);
        } finally {
          setActiveHandle(undefined);
        }
      }
    }
  }
}

async function releaseWorkspace(
  handle: RepositoryLoadingWorkspaceHandle,
  options: { releaseTimeoutMs?: number; logger?: PipelineEventLogger },
) {
  const timeoutMs =
    options.releaseTimeoutMs ?? defaultWorkspaceReleaseTimeoutMs;
  const startedAt = Date.now();
  await logReleaseEvent(options.logger, "started", handle.id);
  const result = await runReleaseWithTimeout(handle.release(), timeoutMs);
  await logReleaseEvent(options.logger, result.status, handle.id, {
    durationMs: Date.now() - startedAt,
    ...(result.status === "failed" ? { error: result.error } : {}),
    ...(result.status === "timeout" ? { timeoutMs } : {}),
  });

  if (result.status === "failed") {
    throw result.error;
  }
}

async function runReleaseWithTimeout(
  releasePromise: Promise<void>,
  timeoutMs: number,
): Promise<
  { error: unknown; status: "failed" } | { status: "succeeded" | "timeout" }
> {
  releasePromise.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      releasePromise.then(
        () => ({ status: "succeeded" }) as const,
        (error: unknown) => ({ error, status: "failed" }) as const,
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function clone(
  workspace: RepositoryLoadingWorkspace,
  repoUrl: string,
  commitSha: string,
) {
  return await runGitCloneWithTransientRetry({
    clone: () =>
      executeRepositoryCommand(
        workspace,
        createGitCloneCommand({
          caBundleCandidates: [...daytonaGitCaBundleCandidates],
          commitSha,
          destinationPath: daytonaWorkspaceDirectory,
          repoUrl,
          resetCommand: createDaytonaWorkspaceResetCommand(),
        }),
        { timeoutMs: defaultCloneAttemptTimeoutMs },
      ),
    retryThrownErrors: false,
  });
}

function executeRepositoryCommand(
  workspace: RepositoryLoadingWorkspace,
  command: string,
  options?: { timeoutMs?: number },
) {
  if (workspace.executeRepositoryCommand === undefined) {
    throw new Error("Unprivileged repository command execution is required.");
  }
  return workspace.executeRepositoryCommand(command, options);
}

async function logStatsEvent(
  logger: PipelineEventLogger | undefined,
  status: "failed" | "started" | "succeeded",
  metadata: {
    durationMs?: number;
    error?: unknown;
    fileCount?: number;
    sizeBytes?: number;
  } = {},
) {
  if (logger === undefined) {
    return;
  }

  try {
    await logger[status === "failed" ? "error" : "info"](
      {
        ...(metadata.durationMs === undefined
          ? {}
          : { durationMs: metadata.durationMs }),
        ...(metadata.error === undefined
          ? {}
          : {
              errorMessage: readErrorMessage(metadata.error),
              errorType:
                metadata.error instanceof Error
                  ? metadata.error.name
                  : typeof metadata.error,
            }),
        ...(metadata.fileCount === undefined
          ? {}
          : { fileCount: metadata.fileCount }),
        ...(metadata.sizeBytes === undefined
          ? {}
          : { sizeBytes: metadata.sizeBytes }),
        event: `repo-security-screen.stats.${status}`,
        externalCall: "daytona.repo_stats",
        stage: "repo-security-screen",
      },
      `Daytona repo stats ${status}.`,
    );
  } catch {
    // Logging must never interrupt Repo Security Screen execution.
  }
}

async function logReleaseEvent(
  logger: PipelineEventLogger | undefined,
  status: "failed" | "started" | "succeeded" | "timeout",
  workspaceId: string,
  metadata: { durationMs?: number; error?: unknown; timeoutMs?: number } = {},
) {
  if (logger === undefined) {
    return;
  }

  const level =
    status === "failed" ? "error" : status === "timeout" ? "warn" : "info";

  try {
    await logger[level](
      {
        ...(metadata.durationMs === undefined
          ? {}
          : { durationMs: metadata.durationMs }),
        ...(metadata.error === undefined
          ? {}
          : {
              errorMessage: readErrorMessage(metadata.error),
              errorType:
                metadata.error instanceof Error
                  ? metadata.error.name
                  : typeof metadata.error,
            }),
        ...(metadata.timeoutMs === undefined
          ? {}
          : { timeoutMs: metadata.timeoutMs }),
        event: `repo-security-screen.workspace_release.${status}`,
        externalCall: "daytona.workspace_release",
        stage: "repo-security-screen",
        workspaceId,
      },
      `Daytona workspace release ${status}.`,
    );
  } catch {
    // Logging must never interrupt Repo Security Screen execution.
  }
}

async function logCloneEvent(
  logger: PipelineEventLogger | undefined,
  status: "failed" | "started" | "succeeded",
  repoUrl: string,
  metadata: {
    durationMs?: number;
    error?: unknown;
    level?: "error" | "warn";
  } = {},
) {
  if (logger === undefined) {
    return;
  }

  try {
    await logger[status === "failed" ? (metadata.level ?? "error") : "info"](
      {
        ...(metadata.durationMs === undefined
          ? {}
          : { durationMs: metadata.durationMs }),
        ...(metadata.error === undefined
          ? {}
          : {
              errorMessage: readErrorMessage(metadata.error),
              errorType:
                metadata.error instanceof Error
                  ? metadata.error.name
                  : typeof metadata.error,
            }),
        event: `repo-security-screen.clone.${status}`,
        externalCall: "daytona.git_clone",
        repoUrl,
        stage: "repo-security-screen",
      },
      `Daytona clone ${status}.`,
    );
  } catch {
    // Logging must never interrupt Repo Security Screen execution.
  }
}

function isCloneWorkspaceRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === "DaytonaConnectionError") {
    return true;
  }

  return /Daytona command did not finish within \d+ms|socket connection was closed|econnreset|connection reset|econnrefused|connection refused|etimedout|timed out|timeout/i.test(
    readErrorMessage(error),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
