import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCommand } from "package-manager-detector/commands";

import { Daytona } from "@daytona/sdk";

import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceDownloadFile,
  PreparationWorkspaceExecuteOptions,
  PreparationWorkspaceLogEntry,
  PreparationWorkspaceUploadFile,
  PreparationWorkspaceUploadOptions,
  SubmittedProjectExecutionRequest,
  SubmittedProjectRuntimeRequest,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { submittedCodeToolchainCatalog } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import { resolveSubmittedProjectCwd } from "../../../pipeline/03-repo-preparation/submitted-project-root";
import {
  type PipelineEventLogger,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../../logging/pipeline-event-logger";

type DaytonaSdkClient = {
  create(
    input?: unknown,
    options?: { timeout?: number },
  ): Promise<DaytonaSdkSandbox>;
  delete(sandbox: DaytonaSdkSandbox): Promise<void>;
  get?(idOrName: string): Promise<DaytonaSdkSandbox>;
};

type DaytonaSdkSandbox = {
  archive(): Promise<void>;
  fs: {
    downloadFiles(
      files: Array<{ destination: string; source: string }>,
      timeoutSec?: number,
    ): Promise<Array<{ error?: string; source: string }>>;
    uploadFiles(
      files: Array<{ destination: string; source: string }>,
    ): Promise<void>;
    uploadFileStream?(
      source: string,
      remotePath: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<void>;
  };
  getSignedPreviewUrl(
    port: number,
    expiresInSeconds?: number,
  ): Promise<{ url?: string }>;
  id?: string;
  name?: string;
  stop(): Promise<void>;
  process: {
    createPty(options: {
      id: string;
      cwd?: string;
      envs?: Record<string, string>;
      cols?: number;
      rows?: number;
      onData: (data: Uint8Array) => void | Promise<void>;
    }): Promise<{
      disconnect(): Promise<void>;
      sendInput(data: string | Uint8Array): Promise<void>;
      kill(): Promise<void>;
      wait(): Promise<{ error?: string; exitCode?: number }>;
      waitForConnection(): Promise<void>;
    }>;
    createSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{
      exitCode?: number;
      result?: string;
      stderr?: string;
      stdout?: string;
    }>;
    executeSessionCommand(
      sessionId: string,
      request: {
        command: string;
        runAsync?: boolean;
        suppressInputEcho?: boolean;
      },
    ): Promise<{ cmdId?: string }>;
    getSessionCommand(
      sessionId: string,
      commandId: string,
    ): Promise<{ exitCode?: number }>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
    ): Promise<{ stderr?: string; stdout?: string } | undefined>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<{ stderr?: string; stdout?: string } | undefined>;
  };
  updateNetworkSettings(settings: { networkBlockAll: boolean }): Promise<void>;
};

type DaytonaSdkPty = Awaited<
  ReturnType<DaytonaSdkSandbox["process"]["createPty"]>
>;
type DaytonaSdkPtyOptions = Parameters<
  DaytonaSdkSandbox["process"]["createPty"]
>[0];

export type DaytonaSdkPreparationWorkspaceProviderOptions = {
  apiKey?: string;
  client?: DaytonaSdkClient;
  commandTimeoutMs?: number;
  diskGB?: number;
  logWriteTimeoutMs?: number;
  previewUrlTimeoutMs?: number;
  ptyConnectionTimeoutMs?: number;
  sandboxCreateTimeoutSeconds?: number;
  sandboxLogSinks?: PipelineLogSink[];
  secrets?: Record<string, string>;
  snapshot?: string;
  submittedCodeSnapshot?: string;
};

const defaultSandboxDiskGB = 3;
const defaultCommandTimeoutMs = 10 * 60_000;
const defaultLogWriteTimeoutMs = 5_000;
const defaultPreviewUrlTimeoutMs = 30_000;
const defaultPtyConnectionTimeoutMs = 30_000;
const ptyTerminationTimeoutMs = 1_000;
const defaultSandboxCreateTimeoutSeconds = 300;
const sandboxCreateConnectionRetryLimit = 2;
const networkSettingsConnectionRetryLimit = 2;
const ptyStartupRetryLimit = 2;
const submittedCodeSyncMaxAttempts = 2;
const makeADemoArtifactDirectory = "/tmp/makeademo";
const workspaceMakeADemoDirectory = "/workspace/.makeademo";
const sandboxAuditLogPath = `${makeADemoArtifactDirectory}/sandbox-log.jsonl`;
const workspaceSandboxAuditLogPath = `${workspaceMakeADemoDirectory}/sandbox-log.jsonl`;

export async function createDaytonaSdkPreparationWorkspaceHandle(input: {
  apiKey?: string;
  client?: DaytonaSdkClient;
  commandTimeoutMs?: number;
  logWriteTimeoutMs?: number;
  previewUrlTimeoutMs?: number;
  sandboxId: string;
  sandboxLogSinks?: PipelineLogSink[];
  ptyConnectionTimeoutMs?: number;
}): Promise<PreparationWorkspaceHandle> {
  const client =
    input.client ??
    (new Daytona(
      input.apiKey === undefined ? undefined : { apiKey: input.apiKey },
    ) as DaytonaSdkClient);
  if (client.get === undefined) {
    throw new Error("Daytona client does not support sandbox lookup.");
  }
  const sandbox = await client.get(input.sandboxId);

  return createPreparationWorkspaceHandle({
    client,
    commandTimeoutMs: input.commandTimeoutMs ?? defaultCommandTimeoutMs,
    id: input.sandboxId,
    logWriteTimeoutMs: input.logWriteTimeoutMs ?? defaultLogWriteTimeoutMs,
    previewUrlTimeoutMs:
      input.previewUrlTimeoutMs ?? defaultPreviewUrlTimeoutMs,
    ptyConnectionTimeoutMs:
      input.ptyConnectionTimeoutMs ?? defaultPtyConnectionTimeoutMs,
    sandboxLogSinks: input.sandboxLogSinks ?? [],
    sandbox,
  });
}

export class DaytonaSdkPreparationWorkspaceProvider
  implements PreparationWorkspaceProvider
{
  private readonly client: DaytonaSdkClient;
  private readonly commandTimeoutMs: number;
  private readonly diskGB: number;
  private readonly logWriteTimeoutMs: number;
  private readonly previewUrlTimeoutMs: number;
  private readonly ptyConnectionTimeoutMs: number;
  private readonly sandboxCreateTimeoutSeconds: number;
  private readonly sandboxLogSinks: PipelineLogSink[];
  private readonly secrets: Record<string, string> | undefined;
  private readonly snapshot: string | undefined;
  private readonly submittedCodeSnapshot: string | undefined;

  constructor(options: DaytonaSdkPreparationWorkspaceProviderOptions = {}) {
    this.client =
      options.client ??
      (new Daytona(
        options.apiKey === undefined ? undefined : { apiKey: options.apiKey },
      ) as DaytonaSdkClient);
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
    this.secrets = options.secrets;
    this.snapshot = options.snapshot;
    this.submittedCodeSnapshot = options.submittedCodeSnapshot;
    this.diskGB = options.diskGB ?? defaultSandboxDiskGB;
    this.logWriteTimeoutMs =
      options.logWriteTimeoutMs ?? defaultLogWriteTimeoutMs;
    this.previewUrlTimeoutMs =
      options.previewUrlTimeoutMs ?? defaultPreviewUrlTimeoutMs;
    this.ptyConnectionTimeoutMs =
      options.ptyConnectionTimeoutMs ?? defaultPtyConnectionTimeoutMs;
    this.sandboxCreateTimeoutSeconds =
      options.sandboxCreateTimeoutSeconds ?? defaultSandboxCreateTimeoutSeconds;
    this.sandboxLogSinks = options.sandboxLogSinks ?? [];
  }

  async create(): Promise<PreparationWorkspaceHandle> {
    const createOptions = { timeout: this.sandboxCreateTimeoutSeconds };
    const sandbox = await this.createSandboxWithConnectionRetry(
      {
        autoDeleteInterval: -1,
        autoStopInterval: 15,
        disk: this.diskGB,
        ...(this.secrets === undefined ? {} : { secrets: this.secrets }),
        ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
      },
      createOptions,
    );
    const id = sandbox.id ?? sandbox.name;
    if (id === undefined || id.trim() === "") {
      await this.client.delete(sandbox);
      throw new Error("Daytona did not return a sandbox id.");
    }

    let submittedCodeSandbox: DaytonaSdkSandbox | undefined;
    try {
      submittedCodeSandbox =
        this.submittedCodeSnapshot === undefined
          ? undefined
          : await this.createSandboxWithConnectionRetry(
              {
                autoDeleteInterval: 0,
                ephemeral: true,
                linkedSandbox: id,
                networkBlockAll: true,
                snapshot: this.submittedCodeSnapshot,
              },
              createOptions,
            );
    } catch (error) {
      await this.client.delete(sandbox);
      throw error;
    }

    return createPreparationWorkspaceHandle({
      client: this.client,
      commandTimeoutMs: this.commandTimeoutMs,
      id,
      logWriteTimeoutMs: this.logWriteTimeoutMs,
      previewUrlTimeoutMs: this.previewUrlTimeoutMs,
      ptyConnectionTimeoutMs: this.ptyConnectionTimeoutMs,
      sandboxLogSinks: this.sandboxLogSinks,
      sandbox,
      ...(submittedCodeSandbox === undefined ? {} : { submittedCodeSandbox }),
    });
  }

  private async createSandboxWithConnectionRetry(
    input: unknown,
    options: { timeout: number },
  ): Promise<DaytonaSdkSandbox> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= sandboxCreateConnectionRetryLimit;
      attempt += 1
    ) {
      try {
        return await this.client.create(input, options);
      } catch (error) {
        lastError = error;
        if (
          attempt === sandboxCreateConnectionRetryLimit ||
          !isDaytonaConnectionError(error)
        ) {
          throw error;
        }

        await wait(250 * (attempt + 1));
      }
    }

    throw lastError;
  }
}

function createPreparationWorkspaceHandle(input: {
  client: DaytonaSdkClient;
  commandTimeoutMs: number;
  id: string;
  logWriteTimeoutMs: number;
  previewUrlTimeoutMs: number;
  ptyConnectionTimeoutMs: number;
  sandboxLogSinks?: PipelineLogSink[];
  sandbox: DaytonaSdkSandbox;
  submittedCodeSandbox?: DaytonaSdkSandbox;
}): PreparationWorkspaceHandle {
  const workspace = new DaytonaSdkPreparationWorkspace(
    input.sandbox,
    input.submittedCodeSandbox,
    input.id,
    input.commandTimeoutMs,
    input.logWriteTimeoutMs,
    input.previewUrlTimeoutMs,
    input.ptyConnectionTimeoutMs,
    input.sandboxLogSinks ?? [],
  );

  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= (async () => {
        let firstError: unknown;
        try {
          await workspace.cancelActiveCommands();
        } catch (error) {
          firstError = error;
        }
        if (input.submittedCodeSandbox !== undefined) {
          try {
            await input.client.delete(input.submittedCodeSandbox);
          } catch (error) {
            firstError ??= error;
          }
        }
        let stopped = false;
        try {
          await input.sandbox.stop();
          stopped = true;
        } catch (error) {
          firstError ??= error;
        }
        if (stopped) {
          try {
            await input.sandbox.archive();
          } catch (error) {
            firstError ??= error;
          }
        }
        if (firstError !== undefined) {
          throw firstError;
        }
      })();
      return releasePromise;
    },
    id: input.id,
    workspace,
  };
}

class DaytonaSdkPreparationWorkspace implements PreparationWorkspace {
  private readonly activePtys = new Set<ManagedPty>();
  private readonly sandboxLogger: PipelineEventLogger;

  constructor(
    private readonly sandbox: DaytonaSdkSandbox,
    private readonly submittedCodeSandbox: DaytonaSdkSandbox | undefined,
    private readonly workspaceId: string,
    private readonly commandTimeoutMs: number,
    private readonly logWriteTimeoutMs: number,
    private readonly previewUrlTimeoutMs: number,
    private readonly ptyConnectionTimeoutMs: number,
    sandboxLogSinks: PipelineLogSink[],
  ) {
    this.sandboxLogger = createPipelineEventLogger({
      base: {
        component: "daytona-sandbox",
      },
      sinks: [
        { write: (line) => this.writeSandboxLogLine(line) },
        ...sandboxLogSinks,
      ],
    });
  }

  async execute(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreaming(command, options);
    }

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const response = await withTimeout(
      this.sandbox.process.executeCommand(
        command,
        undefined,
        options.env,
        toSdkTimeoutSeconds(timeoutMs),
      ),
      timeoutMs,
      `Daytona command did not finish within ${timeoutMs}ms.`,
    );

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  private async executeStreaming(
    command: string,
    options: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult> {
    const output: string[] = [];
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const decoder = new TextDecoder();
    const exitMarker = createExitMarker();
    const ptyForData: { current?: ManagedPty } = {};
    const pty = await this.createConnectedPty(
      this.sandbox,
      {
        cols: 120,
        cwd: "/workspace",
        envs: options.env ?? {},
        id: `makeademo-${randomUUID()}`,
        onData: (data) => {
          const chunk = decoder.decode(data);
          output.push(chunk);
          ptyForData.current?.notifyData(chunk);
          const visibleChunk = removeExitMarker(chunk, exitMarker);
          if (visibleChunk.length > 0) {
            options.onStdout?.(visibleChunk);
          }
        },
        rows: 30,
      },
      exitMarker,
    );
    ptyForData.current = pty;

    try {
      await pty.sendInput(
        `stty -echo\n${command}\nprintf '\\n${exitMarker}%s\\n' $?\nexit\n`,
      );
      const result = await withTimeout(
        pty.completion(),
        timeoutMs,
        `Daytona command did not finish within ${timeoutMs}ms.`,
        () => void pty.cancel(),
      );
      const stdout = output.join("");
      const exitCode = readExitCode(stdout, exitMarker) ?? result.exitCode ?? 0;

      return {
        exitCode,
        stderr: result.error ?? "",
        stdout: removeExitMarker(stdout, exitMarker),
      };
    } finally {
      this.activePtys.delete(pty);
      await pty.disconnect();
    }
  }

  async cancelActiveCommands(): Promise<void> {
    await Promise.allSettled(
      [...this.activePtys].map((pty) => pty.terminate()),
    );
  }

  async writeSandboxLog(entry: PreparationWorkspaceLogEntry): Promise<void> {
    const { level: _level, source, timestamp, workspaceId, ...fields } = entry;
    await this.sandboxLogger[readSandboxLogLevel(entry)](
      {
        ...fields,
        ...(typeof timestamp === "string" ? { eventTime: timestamp } : {}),
        source: source ?? "makeademo",
        workspaceId:
          typeof workspaceId === "string" && workspaceId.trim().length > 0
            ? workspaceId
            : this.workspaceId,
      },
      readSandboxLogMessage(entry),
    );
  }

  private async writeSandboxLogLine(line: string): Promise<void> {
    const response = await withTimeout(
      this.sandbox.process.executeCommand(
        [
          `mkdir -p ${shellQuote(makeADemoArtifactDirectory)} ${shellQuote(workspaceMakeADemoDirectory)}`,
          `printf '%s' ${shellQuote(line)} | tee -a ${shellQuote(sandboxAuditLogPath)} >> ${shellQuote(workspaceSandboxAuditLogPath)}`,
        ].join(" && "),
      ),
      this.logWriteTimeoutMs,
      `Daytona sandbox log write did not finish within ${this.logWriteTimeoutMs}ms.`,
    );

    if ((response.exitCode ?? 0) !== 0) {
      throw new Error("Failed to write Daytona sandbox audit log.");
    }
  }

  async executeSubmittedCode(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }

    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreamingInSandbox(
        this.submittedCodeSandbox,
        command,
        options,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const response = await withTimeout(
      this.submittedCodeSandbox.process.executeCommand(
        command,
        undefined,
        options.env,
        toSdkTimeoutSeconds(timeoutMs),
      ),
      timeoutMs,
      `Daytona command did not finish within ${timeoutMs}ms.`,
    );

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  async executeSubmittedProject(
    request: SubmittedProjectExecutionRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    const execution = createSubmittedProjectExecution(request);
    const projectOptions = {
      ...options,
      env: execution.env,
    };
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreamingInSandbox(
        this.submittedCodeSandbox,
        execution.command,
        projectOptions,
        execution.cwd,
      );
    }
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const response = await withTimeout(
      this.submittedCodeSandbox.process.executeCommand(
        execution.command,
        execution.cwd,
        projectOptions.env,
        toSdkTimeoutSeconds(timeoutMs),
      ),
      timeoutMs,
      `Daytona command did not finish within ${timeoutMs}ms.`,
    );
    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  async executeSubmittedRuntime(
    request: SubmittedProjectRuntimeRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    const execution = createSubmittedRuntimeExecution(request);
    const runtimeOptions = {
      ...options,
      env: createSubmittedRuntimeEnv(options.env),
    };
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreamingInSandbox(
        this.submittedCodeSandbox,
        execution.command,
        runtimeOptions,
        execution.cwd,
      );
    }
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const response = await withTimeout(
      this.submittedCodeSandbox.process.executeCommand(
        execution.command,
        execution.cwd,
        runtimeOptions.env,
        toSdkTimeoutSeconds(timeoutMs),
      ),
      timeoutMs,
      `Daytona command did not finish within ${timeoutMs}ms.`,
    );
    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  async setOutboundNetworkAccess(enabled: boolean): Promise<void> {
    await this.setSandboxNetworkAccess(this.sandbox, enabled);
  }

  async setSubmittedCodeNetworkAccess(enabled: boolean): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }

    await this.setSandboxNetworkAccess(this.submittedCodeSandbox, enabled);
  }

  async syncSubmittedCodeWorkspace(): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }

    await this.sandboxLogger.info({
      event: "daytona.sync-submitted-code-workspace.started",
      maxAttempts: submittedCodeSyncMaxAttempts,
    });
    for (
      let attempt = 1;
      attempt <= submittedCodeSyncMaxAttempts;
      attempt += 1
    ) {
      try {
        await this.syncSubmittedCodeWorkspaceAttempt(attempt);
        await this.sandboxLogger.info({
          event: "daytona.sync-submitted-code-workspace.succeeded",
          attempt,
          maxAttempts: submittedCodeSyncMaxAttempts,
        });
        return;
      } catch (error) {
        if (
          attempt === submittedCodeSyncMaxAttempts ||
          !isDaytonaAuthenticationError(error)
        ) {
          throw error;
        }
        await this.sandboxLogger.warn({
          event: "daytona.sync-submitted-code-workspace.retrying",
          attempt,
          maxAttempts: submittedCodeSyncMaxAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        await wait(250);
      }
    }
  }

  private async syncSubmittedCodeWorkspaceAttempt(
    attempt: number,
  ): Promise<void> {
    const submittedCodeSandbox = this.submittedCodeSandbox;
    if (submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    const archiveName = `prepared-workspace-${randomUUID()}.tgz`;
    const remoteArchivePath = `${makeADemoArtifactDirectory}/${archiveName}`;
    const localDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-daytona-sync-"),
    );
    const localArchivePath = join(localDirectory, archiveName);
    let operation = "archive";

    try {
      const archiveResult = await withTimeout(
        this.sandbox.process.executeCommand(
          createPreparedWorkspaceArchiveCommand(remoteArchivePath),
          undefined,
          undefined,
          toSdkTimeoutSeconds(this.commandTimeoutMs),
        ),
        this.commandTimeoutMs,
        `Daytona prepared workspace archive did not finish within ${this.commandTimeoutMs}ms.`,
      );
      if ((archiveResult.exitCode ?? 0) !== 0) {
        throw new Error(
          formatCommandFailure(
            "Failed to archive prepared Daytona workspace",
            archiveResult,
          ),
        );
      }

      operation = "download";
      const downloadResults = await withTimeout(
        this.sandbox.fs.downloadFiles(
          [{ destination: localArchivePath, source: remoteArchivePath }],
          0,
        ),
        this.commandTimeoutMs,
        `Daytona prepared workspace archive download did not finish within ${this.commandTimeoutMs}ms.`,
      );
      const failedDownload = downloadResults.find(
        (result) => result.error !== undefined,
      );
      if (failedDownload !== undefined) {
        throw new Error(
          `Failed to download prepared Daytona workspace archive ${failedDownload.source}: ${failedDownload.error}`,
        );
      }

      operation = "upload";
      await withTimeout(
        submittedCodeSandbox.fs.uploadFiles([
          { destination: remoteArchivePath, source: localArchivePath },
        ]),
        this.commandTimeoutMs,
        `Daytona prepared workspace archive upload did not finish within ${this.commandTimeoutMs}ms.`,
      );
      operation = "extract";
      const extractResult = await withTimeout(
        submittedCodeSandbox.process.executeCommand(
          createSubmittedCodeWorkspaceExtractCommand(remoteArchivePath),
          undefined,
          undefined,
          toSdkTimeoutSeconds(this.commandTimeoutMs),
        ),
        this.commandTimeoutMs,
        `Daytona submitted-code workspace restore did not finish within ${this.commandTimeoutMs}ms.`,
      );
      if ((extractResult.exitCode ?? 0) !== 0) {
        throw new Error(
          formatCommandFailure(
            "Failed to restore prepared files in submitted-code sandbox",
            extractResult,
          ),
        );
      }
    } catch (error) {
      await this.sandboxLogger.error({
        event: "daytona.sync-submitted-code-workspace.operation.failed",
        operation,
        attempt,
        maxAttempts: submittedCodeSyncMaxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await Promise.allSettled([
        withTimeout(
          this.sandbox.process.executeCommand(
            `rm -f ${shellQuote(remoteArchivePath)}`,
            undefined,
            undefined,
            toSdkTimeoutSeconds(this.commandTimeoutMs),
          ),
          this.commandTimeoutMs,
          `Daytona prepared workspace archive cleanup did not finish within ${this.commandTimeoutMs}ms.`,
        ),
        withTimeout(
          submittedCodeSandbox.process.executeCommand(
            `rm -f ${shellQuote(remoteArchivePath)}`,
            undefined,
            undefined,
            toSdkTimeoutSeconds(this.commandTimeoutMs),
          ),
          this.commandTimeoutMs,
          `Daytona submitted-code workspace archive cleanup did not finish within ${this.commandTimeoutMs}ms.`,
        ),
        rm(localDirectory, { force: true, recursive: true }),
      ]);
    }
  }

  private async setSandboxNetworkAccess(
    sandbox: DaytonaSdkSandbox,
    enabled: boolean,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= networkSettingsConnectionRetryLimit;
      attempt += 1
    ) {
      try {
        await sandbox.updateNetworkSettings({ networkBlockAll: !enabled });
        return;
      } catch (error) {
        if (isRestrictedNetworkPolicyError(error)) {
          // This exact tier-policy response means sandbox overrides are
          // impossible, so provider-enforced blocking remains authoritative
          // whether the caller attempted to open or reseal the network.
          return;
        }
        if (
          attempt === networkSettingsConnectionRetryLimit ||
          !isDaytonaConnectionError(error)
        ) {
          throw error;
        }

        await wait(250 * (attempt + 1));
      }
    }
  }

  async getPreviewUrl(port: number): Promise<string> {
    const previewSandbox = this.submittedCodeSandbox ?? this.sandbox;
    const preview = await withTimeout(
      previewSandbox.getSignedPreviewUrl(port, 60 * 60),
      this.previewUrlTimeoutMs,
      `Daytona preview URL creation did not finish within ${this.previewUrlTimeoutMs}ms.`,
    );
    if (preview.url === undefined || preview.url.trim().length === 0) {
      throw new Error("Daytona did not return a preview URL.");
    }

    return preview.url;
  }

  async uploadFiles(
    files: PreparationWorkspaceUploadFile[],
    options: PreparationWorkspaceUploadOptions = {},
  ): Promise<void> {
    // Upload one stream at a time so cancellation can settle the current file
    // before a caller retries, and so large video evidence never leaves a
    // detached batch upload running in the provider.
    if (this.sandbox.fs.uploadFileStream === undefined) {
      if (options.signal !== undefined || options.timeoutMs !== undefined) {
        throw new Error(
          "Daytona sandbox does not support cancellable file uploads.",
        );
      }
      await this.sandbox.fs.uploadFiles(
        files.map((file) => ({
          destination: file.destinationPath,
          source: file.sourcePath,
        })),
      );
      return;
    }
    for (const file of files) {
      await this.sandbox.fs.uploadFileStream(
        file.sourcePath,
        file.destinationPath,
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined
            ? {}
            : { timeout: toSdkTimeoutSeconds(options.timeoutMs) }),
        },
      );
    }
  }

  async uploadSubmittedCodeFiles(
    files: PreparationWorkspaceUploadFile[],
  ): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      await this.sandbox.fs.uploadFiles(
        files.map((file) => ({
          destination: file.destinationPath,
          source: file.sourcePath,
        })),
      );
      return;
    }

    for (const file of files) {
      const encoded = (await readFile(file.sourcePath)).toString("base64");
      const response = await withTimeout(
        this.submittedCodeSandbox.process.executeCommand(
          [
            `mkdir -p ${shellQuote(dirname(file.destinationPath))}`,
            `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(file.destinationPath)}`,
          ].join(" && "),
          undefined,
          undefined,
          toSdkTimeoutSeconds(this.commandTimeoutMs),
        ),
        this.commandTimeoutMs,
        `Daytona command did not finish within ${this.commandTimeoutMs}ms.`,
      );
      if ((response.exitCode ?? 0) !== 0) {
        throw new Error(
          `Failed to materialize submitted-code file ${file.destinationPath}: ${response.stderr ?? response.result ?? "unknown error"}`,
        );
      }
    }
  }

  async downloadFiles(
    files: PreparationWorkspaceDownloadFile[],
  ): Promise<void> {
    await this.downloadFilesFromSandbox(this.sandbox, files);
  }

  async downloadSubmittedCodeFiles(
    files: PreparationWorkspaceDownloadFile[],
  ): Promise<void> {
    await this.downloadFilesFromSandbox(
      this.submittedCodeSandbox ?? this.sandbox,
      files,
    );
  }

  private async downloadFilesFromSandbox(
    sandbox: DaytonaSdkSandbox,
    files: PreparationWorkspaceDownloadFile[],
  ): Promise<void> {
    const results = await sandbox.fs.downloadFiles(
      files.map((file) => ({
        destination: file.destinationPath,
        source: file.sourcePath,
      })),
      0,
    );
    const failed = results.find((result) => result.error !== undefined);
    if (failed !== undefined) {
      throw new Error(
        `Failed to download Daytona sandbox file ${failed.source}: ${failed.error}`,
      );
    }
  }

  private async executeStreamingInSandbox(
    sandbox: DaytonaSdkSandbox,
    command: string,
    options: PreparationWorkspaceExecuteOptions,
    cwd = "/workspace",
  ): Promise<PreparationWorkspaceCommandResult> {
    const output: string[] = [];
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const decoder = new TextDecoder();
    const exitMarker = createExitMarker();
    let ptyForData: ManagedPty | undefined;
    const pty = await this.createConnectedPty(
      sandbox,
      {
        cols: 120,
        cwd,
        envs: options.env ?? {},
        id: `makeademo-${randomUUID()}`,
        onData: (data) => {
          const chunk = decoder.decode(data);
          output.push(chunk);
          ptyForData?.notifyData(chunk);
          const visibleChunk = removeExitMarker(chunk, exitMarker);
          if (visibleChunk.length > 0) {
            options.onStdout?.(visibleChunk);
          }
        },
        rows: 30,
      },
      exitMarker,
    );
    ptyForData = pty;

    try {
      await pty.sendInput(
        `stty -echo\n${command}\nprintf '\\n${exitMarker}%s\\n' $?\nexit\n`,
      );
      const result = await withTimeout(
        pty.completion(),
        timeoutMs,
        `Daytona command did not finish within ${timeoutMs}ms.`,
        () => void pty.cancel(),
      );
      const stdout = output.join("");
      const exitCode = readExitCode(stdout, exitMarker) ?? result.exitCode ?? 0;

      return {
        exitCode,
        stderr: result.error ?? "",
        stdout: removeExitMarker(stdout, exitMarker),
      };
    } finally {
      ptyForData = undefined;
      this.activePtys.delete(pty);
      await pty.disconnect();
    }
  }

  private async createConnectedPty(
    sandbox: DaytonaSdkSandbox,
    options: DaytonaSdkPtyOptions,
    exitMarker: string,
  ): Promise<ManagedPty> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ptyStartupRetryLimit + 1; attempt += 1) {
      let pty: ManagedPty | undefined;

      try {
        const rawPty = await sandbox.process.createPty({
          ...options,
          id: attempt === 1 ? options.id : `makeademo-${randomUUID()}`,
        });
        pty = new ManagedPty(rawPty, exitMarker);
        this.activePtys.add(pty);
        await withTimeout(
          pty.waitForConnection(),
          this.ptyConnectionTimeoutMs,
          `Daytona PTY did not connect within ${this.ptyConnectionTimeoutMs}ms.`,
        );
        return pty;
      } catch (error) {
        lastError = error;
        if (pty !== undefined) {
          this.activePtys.delete(pty);
          await pty.disconnect();
        }

        if (attempt > ptyStartupRetryLimit) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Daytona PTY startup failed.");
  }
}

function createSubmittedProjectExecution(
  request: SubmittedProjectExecutionRequest,
): { command: string; cwd: string; env: Record<string, string> } {
  const { plan } = request;
  const { cwd, manager } = validateSubmittedToolchainPlan(plan);
  const install = resolveCommand(manager.name, "frozen", []);
  if (
    install === null ||
    request.executable !== install.command ||
    !sameArgv(request.argv, install.args)
  ) {
    throw new Error("Submitted project execution is not the catalog install.");
  }
  const corepackDescriptor = createCorepackDescriptor(manager);
  return {
    command: [
      "mise",
      "--no-config",
      "exec",
      `node@${plan.node.version}`,
      "--",
      "corepack",
      corepackDescriptor,
      ...request.argv,
    ]
      .map(shellQuote)
      .join(" "),
    cwd,
    env: createSubmittedRuntimeEnv(),
  };
}

function createSubmittedRuntimeExecution(
  request: SubmittedProjectRuntimeRequest,
): { command: string; cwd: string; env: Record<string, string> } {
  validateSubmittedRuntimePlan(request.plan);
  return {
    command: [
      "mise",
      "--no-config",
      "exec",
      `node@${request.plan.node.version}`,
      "--",
      "sh",
      "-lc",
      request.command,
    ]
      .map(shellQuote)
      .join(" "),
    cwd: "/workspace",
    env: createSubmittedRuntimeEnv(),
  };
}

function validateSubmittedToolchainPlan(
  plan: SubmittedProjectExecutionRequest["plan"],
): {
  cwd: string;
  manager: NonNullable<
    SubmittedProjectExecutionRequest["plan"]["packageManager"]
  >;
} {
  if (plan.catalogRevision !== submittedCodeToolchainCatalog.revision) {
    throw new Error(
      `Unsupported submitted-code catalog revision: ${plan.catalogRevision}`,
    );
  }
  if (
    !(submittedCodeToolchainCatalog.node as readonly string[]).includes(
      plan.node.version,
    )
  ) {
    throw new Error(`Unsupported catalog Node version: ${plan.node.version}`);
  }
  const cwd = resolveSubmittedProjectCwd(plan.projectRoot);
  const manager = plan.packageManager;
  if (manager === undefined || plan.install === undefined) {
    throw new Error(
      "Submitted toolchain plan has no catalog install capability.",
    );
  }
  if (manager.name === "pnpm") {
    assertCatalogManagerVersion(manager.version);
  } else {
    throw new Error(
      `Unsupported catalog package manager: ${manager.name}@${manager.version}`,
    );
  }
  const install = resolveCommand(manager.name, "frozen", []);
  if (
    install === null ||
    plan.install.executable !== install.command ||
    !sameArgv(plan.install.argv, install.args)
  ) {
    throw new Error("Submitted toolchain plan is not the catalog install.");
  }
  createCorepackDescriptor(manager);
  return { cwd, manager };
}

function validateSubmittedRuntimePlan(
  plan: SubmittedProjectRuntimeRequest["plan"],
): void {
  if (plan.catalogRevision !== submittedCodeToolchainCatalog.revision) {
    throw new Error(
      `Unsupported submitted-code catalog revision: ${plan.catalogRevision}`,
    );
  }
  if (
    !(submittedCodeToolchainCatalog.node as readonly string[]).includes(
      plan.node.version,
    )
  ) {
    throw new Error(`Unsupported catalog Node version: ${plan.node.version}`);
  }
  resolveSubmittedProjectCwd(plan.projectRoot);
}

function createSubmittedRuntimeEnv(
  requested: Record<string, string> | undefined = undefined,
): Record<string, string> {
  const allowed = Object.fromEntries(
    Object.entries(requested ?? {}).filter(
      ([key]) =>
        key === "NODE_ENV" ||
        key.startsWith("PUBLIC_") ||
        key.startsWith("VITE_") ||
        key.startsWith("NEXT_PUBLIC_"),
    ),
  );
  return {
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "1",
    COREPACK_ENABLE_STRICT: "1",
    COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "0",
    COREPACK_ENV_FILE: "0",
    MISE_LOCKED: "1",
    MISE_NO_CONFIG: "1",
    MISE_NO_ENV: "1",
    MISE_NO_HOOKS: "1",
    MISE_NOT_FOUND_AUTO_INSTALL: "0",
    MISE_OFFLINE: "1",
    MISE_PARANOID: "1",
    ...allowed,
  };
}

function createCorepackDescriptor(input: {
  corepackHash?: string;
  name: string;
  version: string;
}): string {
  if (
    input.corepackHash !== undefined &&
    !/^sha(?:224|256|384|512)\.[A-Fa-f0-9]+$/.test(input.corepackHash)
  ) {
    throw new Error("Invalid Corepack package-manager integrity suffix.");
  }
  return `${input.name}@${input.version}${input.corepackHash === undefined ? "" : `+${input.corepackHash}`}`;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertCatalogManagerVersion(version: string): void {
  if (
    !(submittedCodeToolchainCatalog.pnpm as readonly string[]).includes(version)
  ) {
    throw new Error(`Unsupported catalog package manager: pnpm@${version}`);
  }
}

class ManagedPty {
  private disconnected = false;
  private terminationPromise: Promise<void> | undefined;
  private completionResolve!: (result: {
    error?: string;
    exitCode?: number;
  }) => void;
  private completionReject!: (error: unknown) => void;
  private readonly completionPromise = new Promise<{
    error?: string;
    exitCode?: number;
  }>((resolve, reject) => {
    this.completionResolve = resolve;
    this.completionReject = reject;
  });
  private markerBuffer = "";
  private cancelled = false;

  constructor(
    private readonly pty: DaytonaSdkPty,
    private readonly exitMarker: string,
  ) {}

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    await this.pty.disconnect();
  }

  async terminate(): Promise<void> {
    this.cancelled = true;
    this.completionResolve({ error: "PTY command cancelled.", exitCode: 143 });
    this.terminationPromise ??= this.terminateInternal();
    await this.terminationPromise;
  }

  async cancel(): Promise<void> {
    await this.terminate();
  }

  completion(): Promise<{ error?: string; exitCode?: number }> {
    return this.completionPromise;
  }

  fail(error: unknown): void {
    this.completionReject(error);
  }

  notifyData(chunk: string): void {
    if (this.cancelled) return;
    this.markerBuffer = (this.markerBuffer + chunk).slice(-256);
    const match = this.markerBuffer.match(
      new RegExp(`${escapeRegExp(this.exitMarker)}(\\d+)`),
    );
    if (match?.[1] !== undefined) {
      this.completionResolve({ exitCode: Number(match[1]) });
    }
  }

  private async terminateInternal(): Promise<void> {
    await settleWithin(this.pty.kill(), ptyTerminationTimeoutMs);
    await settleWithin(this.disconnect(), ptyTerminationTimeoutMs);
  }

  sendInput(data: string | Uint8Array): Promise<void> {
    return this.pty.sendInput(data);
  }

  waitForConnection(): Promise<void> {
    return this.pty.waitForConnection();
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<void> {
  await Promise.allSettled([
    withTimeout(promise, timeoutMs, "PTY termination timed out."),
  ]);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        onTimeout?.();
        reject(new Error(message));
      }, timeoutMs);
    }),
  ]);
}

function toSdkTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isDaytonaConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "DaytonaConnectionError" ||
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT") ||
    error.message.toLowerCase().includes("socket connection was closed")
  );
}

function isDaytonaAuthenticationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.trim().toLowerCase() ===
      "unauthorized: authentication failed: bearer token is invalid"
  );
}

function createExitMarker(): string {
  return `__MAKEADEMO_EXIT__:${randomUUID()}:`;
}

function readExitCode(output: string, exitMarker: string): number | undefined {
  const match = output.match(new RegExp(`${escapeRegExp(exitMarker)}(\\d+)`));
  if (match?.[1] === undefined) {
    return undefined;
  }

  return Number(match[1]);
}

function removeExitMarker(output: string, exitMarker: string): string {
  return output.replace(
    new RegExp(`\\n?${escapeRegExp(exitMarker)}\\d+\\n?`, "g"),
    "",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSandboxLogLevel(
  entry: PreparationWorkspaceLogEntry,
): "debug" | "error" | "info" | "warn" {
  if (entry.level !== undefined) {
    return entry.level;
  }
  const event = typeof entry.event === "string" ? entry.event : "";
  if (event.includes("failed") || event.includes("invalid")) {
    return "error";
  }

  if (event.includes("warning")) {
    return "warn";
  }

  return "info";
}

function readSandboxLogMessage(entry: PreparationWorkspaceLogEntry): string {
  if (typeof entry.message === "string") {
    return entry.message;
  }

  return typeof entry.event === "string" ? entry.event : "Sandbox log event.";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createPreparedWorkspaceArchiveCommand(archivePath: string): string {
  const excludedArchivePaths = [
    "./.git",
    "./.git/*",
    "./*/.git",
    "./*/.git/*",
    "./.makeademo",
    "./.makeademo/*",
    "./node_modules",
    "./node_modules/*",
    "./*/node_modules",
    "./*/node_modules/*",
    "./.vite",
    "./.vite/*",
    "./*/.vite",
    "./*/.vite/*",
    "./.turbo",
    "./.turbo/*",
    "./*/.turbo",
    "./*/.turbo/*",
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
    "./.next/cache",
    "./.next/cache/*",
    "./*/.next/cache",
    "./*/.next/cache/*",
    "./.bun",
    "./.bun/*",
    "./*/.bun",
    "./*/.bun/*",
    "./.cache",
    "./.cache/*",
    "./*/.cache",
    "./*/.cache/*",
  ];
  const excludeFlags = excludedArchivePaths
    .map((path) => `--exclude=${shellQuote(path)}`)
    .join(" ");

  return `sh -lc ${shellQuote(
    [
      `mkdir -p ${shellQuote(makeADemoArtifactDirectory)}`,
      `tar ${excludeFlags} -czf ${shellQuote(archivePath)} -C /workspace .`,
    ].join(" && "),
  )}`;
}

function createSubmittedCodeWorkspaceExtractCommand(
  archivePath: string,
): string {
  const preservedWorkspacePaths = [
    "-name node_modules",
    "-name .vite",
    "-name .turbo",
    "-name .npm",
    "-name .pnpm-store",
    "-path '*/.yarn/cache'",
    "-path '*/.next/cache'",
    "-name .bun",
    "-name .cache",
  ].join(" -o ");

  return `sh -lc ${shellQuote(
    [
      "preserved=$(mktemp -d)",
      "preserved_paths=$(mktemp)",
      'cleanup() { rm -f -- "$preserved_paths"; rm -rf -- "$preserved"; }',
      "trap cleanup EXIT",
      `find /workspace -mindepth 1 \\( ${preservedWorkspacePaths} \\) -prune -print > "$preserved_paths"`,
      `while IFS= read -r path; do relative="\${path#/workspace/}"; mkdir -p -- "\$preserved/\$(dirname -- "\$relative")" || exit 1; mv -- "\$path" "\$preserved/\$relative" || exit 1; done < "$preserved_paths"`,
      "rm -rf -- /workspace/* /workspace/.[!.]* /workspace/..?*",
      '{ cp -a "$preserved"/. /workspace/ 2>/dev/null || true; }',
      `tar -xzf ${shellQuote(archivePath)} -C /workspace`,
    ].join(" && "),
  )}`;
}

function formatCommandFailure(
  message: string,
  result: {
    exitCode?: number;
    result?: string;
    stderr?: string;
    stdout?: string;
  },
): string {
  const exitCode = result.exitCode ?? 0;
  const stderr = result.stderr ?? "";
  const stdout = result.stdout ?? result.result ?? "";

  return `${message} (exit code ${exitCode}). stderr: ${stderr} stdout: ${stdout}`;
}

function isRestrictedNetworkPolicyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.trim();
  const restriction =
    "Network access is restricted and cannot be overridden at the sandbox level";
  const documentedRestriction = `${restriction}. See https://www.daytona.io/docs/en/network-limits/#tier-based-network-restrictions`;
  return [
    restriction,
    `${restriction}.`,
    documentedRestriction,
    `${documentedRestriction}.`,
  ].includes(message);
}
