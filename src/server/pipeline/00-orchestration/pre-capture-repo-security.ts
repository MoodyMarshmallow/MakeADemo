import {
  createDaytonaWorkspaceResetCommand,
  daytonaWorkspaceDirectory,
} from "../../shared/integrations/daytona/workspace-command";
import type { PipelineEventLogger } from "../../shared/logging/pipeline-event-logger";
import type { RepoSecurityInput } from "../02-repo-security-screen/repo-security-screen";
import { createGitCloneCommand } from "../03-repo-preparation/git-clone-command";
import { runGitCloneWithTransientRetry } from "../03-repo-preparation/git-clone-retry";
import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../03-repo-preparation/preparation-workspace.interface";

const defaultWorkspaceDestroyTimeoutMs = 30_000;
const defaultCloneAttemptTimeoutMs = 120_000;
const defaultCloneWorkspaceRetryDelaysMs = [250, 500];
const maxCloneWorkspaceRetries = 2;

export async function readRepoSecurityInput(
  provider: PreparationWorkspaceProvider,
  repoUrl: string,
  options: {
    cloneWorkspaceRetryDelaysMs?: number[];
    commitSha?: string;
    destroyTimeoutMs?: number;
    logger?: PipelineEventLogger;
  } = {},
): Promise<RepoSecurityInput> {
  const cloneWorkspaceRetryDelaysMs =
    options.cloneWorkspaceRetryDelaysMs ?? defaultCloneWorkspaceRetryDelaysMs;

  for (let attempt = 0; ; attempt += 1) {
    const handle = await provider.create();
    const cloneStartedAt = Date.now();

    try {
      await logCloneEvent(options.logger, "started", repoUrl);
      await handle.workspace.setOutboundNetworkAccess(true);
      const cloneResult = await cloneWithNetworkAccess(
        handle.workspace,
        repoUrl,
        options.commitSha,
      );
      if (cloneResult.exitCode !== 0) {
        const error = new Error(
          `Daytona git clone failed: ${[cloneResult.stderr, cloneResult.stdout].filter((line) => line.length > 0).join("\n")}`,
        );
        throw error;
      }
      await logCloneEvent(options.logger, "succeeded", repoUrl);
    } catch (error) {
      await logCloneEvent(options.logger, "failed", repoUrl, {
        durationMs: Date.now() - cloneStartedAt,
        error,
      });

      await destroyWorkspace(handle, options);
      if (
        attempt < maxCloneWorkspaceRetries &&
        isCloneWorkspaceRetryableError(error)
      ) {
        await delay(cloneWorkspaceRetryDelaysMs[attempt] ?? 0);
        continue;
      }

      throw error;
    }

    const statsStartedAt = Date.now();
    try {
      try {
        await logStatsEvent(options.logger, "started");
        const statsResult = await handle.workspace.execute(
          `find ${shellQuote(daytonaWorkspaceDirectory)} -path ${shellQuote(`${daytonaWorkspaceDirectory}/.git`)} -prune -o -path ${shellQuote(`${daytonaWorkspaceDirectory}/node_modules`)} -prune -o -type f -printf '%P\\t%s\\n'`,
        );
        if (statsResult.exitCode !== 0) {
          throw new Error(`Daytona repo stats failed: ${statsResult.stderr}`);
        }

        const fileStats = statsResult.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const [path = "", size = "0"] = line.split("\t");
            return { path, sizeBytes: Number(size) };
          });
        const files = await Promise.all(
          fileStats.map(async (file) => {
            if (!shouldReadForSecurity(file.path)) {
              return { path: file.path };
            }

            const textResult = await handle.workspace.execute(
              `cat ${shellQuote(`${daytonaWorkspaceDirectory}/${file.path}`)}`,
            );

            return {
              path: file.path,
              text: textResult.stdout,
            };
          }),
        );
        const sizeBytes = fileStats.reduce(
          (sum, file) => sum + file.sizeBytes,
          0,
        );
        await logStatsEvent(options.logger, "succeeded", {
          durationMs: Date.now() - statsStartedAt,
          fileCount: fileStats.length,
          sizeBytes,
        });

        return {
          files,
          repoStats: {
            fileCount: fileStats.length,
            sizeBytes,
          },
        };
      } catch (error) {
        await logStatsEvent(options.logger, "failed", {
          durationMs: Date.now() - statsStartedAt,
          error,
        });
        throw error;
      }
    } finally {
      await destroyWorkspace(handle, options);
    }
  }
}

async function destroyWorkspace(
  handle: PreparationWorkspaceHandle,
  options: { destroyTimeoutMs?: number; logger?: PipelineEventLogger },
) {
  const timeoutMs =
    options.destroyTimeoutMs ?? defaultWorkspaceDestroyTimeoutMs;
  const startedAt = Date.now();
  await logDestroyEvent(options.logger, "started", handle.id);
  const result = await runDestroyWithTimeout(handle.destroy(), timeoutMs);
  await logDestroyEvent(options.logger, result.status, handle.id, {
    durationMs: Date.now() - startedAt,
    ...(result.status === "failed" ? { error: result.error } : {}),
    ...(result.status === "timeout" ? { timeoutMs } : {}),
  });

  if (result.status === "failed") {
    throw result.error;
  }
}

async function runDestroyWithTimeout(
  destroyPromise: Promise<void>,
  timeoutMs: number,
): Promise<
  { error: unknown; status: "failed" } | { status: "succeeded" | "timeout" }
> {
  destroyPromise.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      destroyPromise.then(
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

async function cloneWithNetworkAccess(
  workspace: PreparationWorkspace,
  repoUrl: string,
  commitSha: string | undefined,
) {
  try {
    return await runGitCloneWithTransientRetry({
      clone: () =>
        workspace.execute(
          createGitCloneCommand({
            ...(commitSha === undefined ? {} : { commitSha }),
            destinationPath: daytonaWorkspaceDirectory,
            repoUrl,
            resetCommand: createDaytonaWorkspaceResetCommand(),
          }),
          { timeoutMs: defaultCloneAttemptTimeoutMs },
        ),
      retryThrownErrors: false,
    });
  } finally {
    await workspace.setOutboundNetworkAccess(false);
  }
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

async function logDestroyEvent(
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
        event: `repo-security-screen.workspace_destroy.${status}`,
        externalCall: "daytona.workspace_destroy",
        stage: "repo-security-screen",
        workspaceId,
      },
      `Daytona workspace destroy ${status}.`,
    );
  } catch {
    // Logging must never interrupt Repo Security Screen execution.
  }
}

async function logCloneEvent(
  logger: PipelineEventLogger | undefined,
  status: "failed" | "started" | "succeeded",
  repoUrl: string,
  metadata: { durationMs?: number; error?: unknown } = {},
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

function shouldReadForSecurity(path: string): boolean {
  return path === "package.json" || path.endsWith(".sh");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
