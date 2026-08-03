import { createHash } from "node:crypto";

import {
  runSettledPipelineOperation,
  throwIfPipelineDeadlineReached,
} from "../../../pipeline/00-orchestration/job/pipeline-cancellation";
import type { RepoSecurityInput } from "../../../pipeline/02-repo-security-screen/repo-security-screen";
import { createGitCloneCommand } from "../../../pipeline/02-repo-security-screen/repository-loading/git-clone-command";
import { runGitCloneWithTransientRetry } from "../../../pipeline/02-repo-security-screen/repository-loading/git-clone-retry";
import {
  type RepoSecurityEvidence,
  type RepoSecurityEvidenceFile,
  selectRepoSecurityDeterministicManifestFiles,
  selectRepoSecurityEvidenceFiles,
} from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-evidence";
import type {
  RepoSecurityInputLoadInput,
  RepoSecurityInputLoadResult,
  RepoSecurityInputLoader,
} from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-input-loader.interface";
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

export type RepositoryLoadingWorkspaceCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

/**
 * Executes backend-authored repository-loading commands. Implementations must
 * return the command's exit status and captured output and honor requested
 * timeouts.
 */
export type RepositoryLoadingWorkspace = PreparationWorkspace;

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
const maxConcurrentStaticReads = 4;
const repoSecurityInventoryTransportMaxBytes = 4 * 1_024 * 1_024;

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
        const statsResult = await executeRepositoryCommand(
          handle.workspace,
          `find ${shellQuote(daytonaWorkspaceDirectory)} -path ${shellQuote(`${daytonaWorkspaceDirectory}/.git`)} -prune -o -path ${shellQuote(`${daytonaWorkspaceDirectory}/node_modules`)} -prune -o -type f -printf '%P\\0%s\\0' | head -c ${repoSecurityInventoryTransportMaxBytes + 1}`,
        );
        if (statsResult.exitCode !== 0) {
          throw new Error(`Daytona repo stats failed: ${statsResult.stderr}`);
        }

        const fileStats = parseRepoSecurityInventory(statsResult.stdout);
        const deterministicManifestSelection =
          selectRepoSecurityDeterministicManifestFiles(fileStats);
        const deterministicManifestFiles = await mapWithConcurrency(
          deterministicManifestSelection.files,
          maxConcurrentStaticReads,
          (file) =>
            readStaticRepoSecurityFile({
              file,
              signal: input.signal,
              workspace: handle.workspace,
            }),
        );
        const deterministicManifestByPath = new Map(
          deterministicManifestFiles.map((file) => [file.path, file] as const),
        );
        const selection = selectRepoSecurityEvidenceFiles(fileStats);
        const newlyReadEvidenceFiles = await mapWithConcurrency(
          selection.files.filter(
            (file) => !deterministicManifestByPath.has(file.path),
          ),
          maxConcurrentStaticReads,
          (file) =>
            readStaticRepoSecurityFile({
              file,
              signal: input.signal,
              workspace: handle.workspace,
            }),
        );
        const readFilesByPath = new Map([
          ...deterministicManifestFiles.map(
            (file) => [file.path, file] as const,
          ),
          ...newlyReadEvidenceFiles.map((file) => [file.path, file] as const),
        ]);
        const evidenceFiles = selection.files.map((file) => {
          const readFile = readFilesByPath.get(file.path);
          if (readFile === undefined) {
            throw new Error(
              `Repo security evidence selection was not read: ${file.path}`,
            );
          }
          return readFile;
        });
        const evidenceByPath = new Map(
          evidenceFiles.map((file) => [file.path, file] as const),
        );
        const files = fileStats.map((file) => {
          const staticFile =
            deterministicManifestByPath.get(file.path) ??
            evidenceByPath.get(file.path);
          return input.shouldReadText(file.path) && staticFile !== undefined
            ? { path: file.path, text: staticFile.excerpt }
            : { path: file.path };
        });
        const sizeBytes = fileStats.reduce(
          (sum, file) => sum + file.sizeBytes,
          0,
        );
        await logStatsEvent(options.logger, "succeeded", {
          durationMs: Date.now() - statsStartedAt,
          fileCount: fileStats.length,
          sizeBytes,
        });

        const evidence: RepoSecurityEvidence = {
          coverage: {
            excerptBytes: evidenceFiles.reduce(
              (total, file) => total + file.excerptBytes,
              0,
            ),
            omittedEligibleFileCount:
              selection.inventory.omittedEligibleFileCount,
            omittedEligibleSizeBytes:
              selection.inventory.omittedEligibleSizeBytes,
            selectedFileCount: evidenceFiles.length,
            truncatedFileCount: evidenceFiles.filter((file) => file.truncated)
              .length,
          },
          files: evidenceFiles,
          inventory: selection.inventory,
          limits: selection.limits,
        };

        const baseline = await executeRepositoryCommand(
          handle.workspace,
          "git -C /workspace ls-files -z",
        );
        if (baseline.exitCode !== 0) {
          throw new Error(
            "Failed to inventory source-controlled submitted paths.",
          );
        }
        retained = true;
        return {
          baselineSourceControlledPaths: baseline.stdout
            .split("\0")
            .filter((path) => path.length > 0),
          preparationWorkspace: handle,
          repoSecurity: {
            evidence,
            files,
            repoStats: {
              fileCount: fileStats.length,
              sizeBytes,
            },
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

function parseRepoSecurityInventory(
  output: string,
): Array<{ path: string; sizeBytes: number }> {
  const outputBytes = Buffer.byteLength(output, "utf8");
  if (outputBytes > repoSecurityInventoryTransportMaxBytes) {
    throw new Error(
      `Repo security inventory exceeds the ${repoSecurityInventoryTransportMaxBytes}-byte transport limit.`,
    );
  }
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) {
    throw new Error("Repo security inventory returned a malformed NUL record.");
  }

  const files: Array<{ path: string; sizeBytes: number }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const path = fields[index] ?? "";
    const rawSize = fields[index + 1] ?? "";
    if (path.includes("\0") || !/^\d+$/.test(rawSize)) {
      throw new Error(
        "Repo security inventory returned an invalid file record.",
      );
    }
    const sizeBytes = Number(rawSize);
    if (!Number.isSafeInteger(sizeBytes)) {
      throw new Error("Repo security inventory returned an unsafe file size.");
    }
    files.push({ path, sizeBytes });
  }
  return files;
}

async function readStaticRepoSecurityFile(input: {
  file: { excerptLimitBytes: number; path: string; sizeBytes: number };
  signal: AbortSignal | undefined;
  workspace: RepositoryLoadingWorkspace;
}): Promise<RepoSecurityEvidenceFile> {
  throwIfPipelineDeadlineReached(input.signal, undefined);
  const textResult = await executeRepositoryCommand(
    input.workspace,
    `head -c ${input.file.excerptLimitBytes + 1} -- ${shellQuote(`${daytonaWorkspaceDirectory}/${input.file.path}`)}`,
  );
  throwIfPipelineDeadlineReached(input.signal, undefined);
  if (textResult.exitCode !== 0) {
    throw new Error(
      `Daytona repo evidence read failed for ${input.file.path}: ${textResult.stderr}`,
    );
  }
  const received = Buffer.from(textResult.stdout, "utf8");
  const excerptBuffer = received.subarray(0, input.file.excerptLimitBytes);
  return {
    excerpt: excerptBuffer.toString("utf8"),
    excerptBytes: excerptBuffer.byteLength,
    excerptSha256: createHash("sha256").update(excerptBuffer).digest("hex"),
    path: input.file.path,
    sizeBytes: input.file.sizeBytes,
    truncated:
      input.file.sizeBytes > input.file.excerptLimitBytes ||
      received.byteLength > input.file.excerptLimitBytes,
  };
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await map(item);
      }
    },
  );
  const settlements = await Promise.allSettled(workers);
  const failure = settlements.find(
    (settlement): settlement is PromiseRejectedResult =>
      settlement.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
  return results;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
