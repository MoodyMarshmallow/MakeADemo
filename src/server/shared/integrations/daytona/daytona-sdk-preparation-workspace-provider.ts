import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { satisfies as semverSatisfies } from "semver";

import { Daytona } from "@daytona/sdk";

import { createBoundedInstallEnvironment } from "../../../pipeline/03-repo-preparation/planned-dependency-install";
import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceDownloadFile,
  PreparationWorkspaceDownloadOptions,
  PreparationWorkspaceExecuteOptions,
  PreparationWorkspaceLogEntry,
  PreparationWorkspaceUploadFile,
  PreparationWorkspaceUploadOptions,
  SubmittedProjectExecutionRequest,
  SubmittedProjectRuntimeRequest,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import {
  type SubmittedCodeToolchainPlan,
  submittedCodeToolchainCatalog,
} from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import { resolveSubmittedProjectCwd } from "../../../pipeline/03-repo-preparation/submitted-project-root";
import { isApprovedSubmittedRuntimeEnvironmentKey } from "../../../pipeline/03-repo-preparation/submitted-runtime-environment";
import {
  type PipelineEventLogger,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../../logging/pipeline-event-logger";
import {
  type TrustedSubmittedNodeRuntimeArtifact,
  createTrustedSubmittedNodeProvisionCommand,
  readTrustedSubmittedNodeAttestation,
} from "./trusted-submitted-node-runtime";

class TrustedPackageManagerProvisioningError extends Error {
  constructor(
    readonly code: "deprecated_release" | "package_manager_release_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TrustedPackageManagerProvisioningError";
  }
}

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
    downloadFileStream?(
      sourcePath: string,
      options?: {
        onProgress?: (progress: {
          bytesReceived: number;
          totalBytes?: number;
        }) => void;
        signal?: AbortSignal;
        timeout?: number;
      },
    ): Promise<NodeJS.ReadableStream>;
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
const ptyStartupRetryLimit = 2;
const submittedCodeSyncMaxAttempts = 2;
const makeADemoArtifactDirectory = "/tmp/makeademo";
const workspaceMakeADemoDirectory = "/workspace/.makeademo";
const sandboxAuditLogPath = `${makeADemoArtifactDirectory}/sandbox-log.jsonl`;
const workspaceSandboxAuditLogPath = `${workspaceMakeADemoDirectory}/sandbox-log.jsonl`;
const agentWorkspaceUser = "pwuser";
const agentWorkspaceHome = "/workspace/.makeademo/agent-home";
const agentWorkspaceTemp = "/workspace/.makeademo/tmp";
const agentWorkspacePath =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const submittedSystemUtilitiesPath =
  "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";
const submittedCodePlaywrightModuleRoot =
  "/opt/makeademo/playwright-runtime/node_modules";
const submittedCodePlaywrightBrowsersPath = "/ms-playwright";
const parentSubmittedRuntimePaths = [
  "/usr/local/bin/node",
  "/usr/local/bin/npm",
  "/usr/local/bin/npx",
  "/usr/local/bin/corepack",
  "/usr/local/bin/bun",
  "/usr/local/bin/bunx",
  "/usr/local/bin/pnpm",
  "/usr/local/bin/yarn",
  "/usr/local/bin/makeademo-preload-submitted-code-image",
  "/usr/local/bin/makeademo-inspect-submitted-code-toolchain",
];

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
        networkBlockAll: false,
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
                autoDeleteInterval: -1,
                networkBlockAll: false,
                snapshot: this.submittedCodeSnapshot,
                user: "root",
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
          let submittedCodeStopped = false;
          try {
            await input.submittedCodeSandbox.stop();
            submittedCodeStopped = true;
          } catch (error) {
            firstError ??= error;
          }
          if (submittedCodeStopped) {
            try {
              await input.submittedCodeSandbox.archive();
            } catch (error) {
              firstError ??= error;
            }
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
  private submittedToolchainLifecycle: SubmittedToolchainLifecycle = {
    state: "unprovisioned",
  };
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
    return this.executeCancellableCommandInSandbox(
      this.sandbox,
      command,
      options,
    );
  }

  async executeAgentCommand(
    command: string,
    options: Omit<PreparationWorkspaceExecuteOptions, "env"> = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    const agentCommand = createUnprivilegedAgentCommand(command);
    const agentOptions: PreparationWorkspaceExecuteOptions = {
      ...options,
      env: {},
    };
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreaming(agentCommand, agentOptions);
    }
    return this.executeCancellableCommandInSandbox(
      this.sandbox,
      agentCommand,
      agentOptions,
    );
  }

  async prepareForAgent(): Promise<void> {
    const runtimePathWords = parentSubmittedRuntimePaths
      .map(shellQuote)
      .join(" ");
    const command = [
      `id -u ${shellQuote(agentWorkspaceUser)} >/dev/null 2>&1 || useradd --home-dir ${shellQuote(agentWorkspaceHome)} --no-create-home --shell /bin/bash ${shellQuote(agentWorkspaceUser)}`,
      `for makeademo_runtime_path in ${runtimePathWords}; do if test -e "$makeademo_runtime_path" || test -L "$makeademo_runtime_path"; then chmod 0750 "$makeademo_runtime_path"; fi; done`,
      `mkdir -p ${shellQuote(agentWorkspaceHome)} ${shellQuote(agentWorkspaceTemp)}`,
      `find ${shellQuote("/workspace")} -xdev -exec chown --no-dereference ${shellQuote(`${agentWorkspaceUser}:${agentWorkspaceUser}`)} {} +`,
      "chmod 0755 /tmp /var/tmp",
    ].join(" && ");
    const response = await this.executeCancellableCommandInSandbox(
      this.sandbox,
      command,
      {},
    );
    if ((response.exitCode ?? 0) !== 0) {
      throw new Error("Failed to hand the cloned workspace to the agent user.");
    }
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
    let commandStarted = false;
    const pty = await this.createConnectedPty(
      this.sandbox,
      {
        cols: 120,
        cwd: "/workspace",
        envs: options.env ?? {},
        id: `makeademo-${randomUUID()}`,
        onData: (data) => {
          const chunk = decoder.decode(data);
          ptyForData.current?.notifyData(chunk);
          if (!commandStarted) return;
          output.push(chunk);
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
      await this.preparePtyTerminal(pty);
      commandStarted = true;
      await pty.sendInput(createNoninteractivePtyCommand(command, exitMarker));
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

    const lifecycle = this.submittedToolchainLifecycle;
    if (lifecycle.state === "failed") {
      throw failedSubmittedCodeToolchainProvisioningRequiresFreshSandbox();
    }
    const submittedExecution =
      lifecycle.state === "unprovisioned"
        ? { command, env: createSubmittedRuntimeEnv(options.env) }
        : createArtifactBoundSubmittedExecution(
            command,
            lifecycle.artifact,
            options.env,
          );
    const execution = createUnprivilegedSubmittedCodeExecution(
      submittedExecution.command,
      submittedExecution.env,
    );
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreamingInSandbox(
        this.submittedCodeSandbox,
        execution.command,
        { ...options, env: {} },
      );
    }
    return this.executeCancellableCommandInSandbox(
      this.submittedCodeSandbox,
      execution.command,
      { ...options, env: {} },
    );
  }

  async executeSubmittedProject(
    request: SubmittedProjectExecutionRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    const provisioned = this.requireBoundSubmittedToolchain(request.plan);
    await this.verifySubmittedProjectIntegrity(
      this.submittedToolchainLifecycle.state === "synchronized"
        ? this.submittedToolchainLifecycle.projectIntegrity
        : undefined,
      provisioned.nodeRuntime,
    );
    const execution = createSubmittedProjectExecution(
      request,
      provisioned,
      options.env,
    );
    const projectOptions = {
      ...options,
      env: {},
    };
    const command = createUnprivilegedSubmittedCodeExecution(
      execution.command,
      execution.env,
    ).command;
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreamingInSandbox(
        this.submittedCodeSandbox,
        command,
        projectOptions,
        execution.cwd,
      );
    }
    return this.executeCancellableCommandInSandbox(
      this.submittedCodeSandbox,
      command,
      projectOptions,
      execution.cwd,
    );
  }

  async executeSubmittedRuntime(
    request: SubmittedProjectRuntimeRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    const provisioned = this.requireBoundSubmittedToolchain(request.plan);
    const execution = createSubmittedRuntimeExecution(request, provisioned);
    const runtimeOptions = {
      ...options,
      env: {},
    };
    const command = createUnprivilegedSubmittedCodeExecution(
      execution.command,
      execution.env,
    ).command;
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreamingInSandbox(
        this.submittedCodeSandbox,
        command,
        runtimeOptions,
        execution.cwd,
      );
    }
    return this.executeCancellableCommandInSandbox(
      this.submittedCodeSandbox,
      command,
      runtimeOptions,
      execution.cwd,
    );
  }

  async provisionSubmittedCodeToolchain(
    plan: SubmittedProjectExecutionRequest["plan"],
  ): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    if (this.submittedToolchainLifecycle.state === "failed") {
      throw failedSubmittedCodeToolchainProvisioningRequiresFreshSandbox();
    }
    const { manager } = validateSubmittedToolchainPlan(plan);
    const planIdentity = submittedToolchainPlanIdentity(plan, manager);
    const projectIntegrity = readSubmittedProjectIntegrityRequirement(
      plan,
      manager,
    );
    const artifactIdentity = submittedToolchainArtifactIdentity(
      plan.node.version,
      manager,
    );
    const existing = this.submittedToolchainLifecycle;
    if (existing.state !== "unprovisioned") {
      if (existing.artifact.artifactIdentity !== artifactIdentity) {
        throw freshSubmittedCodeSandboxRequired();
      }
      if (existing.planIdentity === planIdentity) {
        return;
      }
      this.submittedToolchainLifecycle = {
        artifact: existing.artifact,
        planIdentity,
        projectIntegrity,
        state: "provisioned",
      };
      return;
    }

    let artifact: HydratedSubmittedCodeToolchainArtifact;
    try {
      artifact = await (async () => {
        const nodeResult = await this.executeCancellableCommandInSandbox(
          this.submittedCodeSandbox as DaytonaSdkSandbox,
          createTrustedSubmittedNodeProvisionCommand(plan.node.version),
          { env: createTrustedToolchainProvisioningEnv() },
          "/",
        );
        if (nodeResult.exitCode !== 0) {
          throw new Error(
            `Trusted Node runtime hydration failed for Node ${plan.node.version}: ${nodeResult.stderr || nodeResult.stdout}`,
          );
        }
        const nodeRuntime = readTrustedSubmittedNodeAttestation(
          nodeResult.stdout,
          plan.node.version,
        );
        const toolchainRoot = trustedToolchainRootForArtifact(
          manager,
          artifactIdentity,
        );
        const result = await this.executeCancellableCommandInSandbox(
          this.submittedCodeSandbox as DaytonaSdkSandbox,
          manager.name === "bun"
            ? createTrustedBunHydrationCommand(
                nodeRuntime,
                manager.version,
                toolchainRoot,
              )
            : manager.name === "yarn" && manager.generation === "yarn-berry"
              ? createTrustedYarnBerryHydrationCommand(
                  nodeRuntime,
                  manager,
                  toolchainRoot,
                )
              : createTrustedToolchainHydrationCommand(
                  nodeRuntime,
                  manager,
                  toolchainRoot,
                ),
          { env: createTrustedToolchainProvisioningEnv() },
          "/",
        );
        if (result.exitCode !== 0) {
          if (
            result.stderr.includes("MAKEADEMO_REGISTRY_RELEASE_UNAVAILABLE")
          ) {
            throw new TrustedPackageManagerProvisioningError(
              "package_manager_release_unavailable",
              `The exact trusted package-manager release ${manager.name}@${manager.version} is unavailable.`,
            );
          }
          if (result.stderr.includes("MAKEADEMO_REGISTRY_RELEASE_DEPRECATED")) {
            throw new TrustedPackageManagerProvisioningError(
              "deprecated_release",
              `Trusted registry metadata marks ${manager.name}@${manager.version} as deprecated.`,
            );
          }
          throw new Error(
            `Trusted package-manager hydration failed for ${manager.name}@${manager.version}: ${result.stderr || result.stdout}`,
          );
        }
        const attestation =
          manager.name === "bun"
            ? readBunArtifactAttestation(result.stdout)
            : readHydratedArtifactAttestation(result.stdout);
        const hydrated: HydratedSubmittedCodeToolchainArtifact = {
          artifactIdentity,
          binPath: `${toolchainRoot}/${attestation.artifactDigest.slice(
            manager.name === "bun" ? "sha256:".length : "sha512:".length,
          )}/bin`,
          ...(manager.name === "bun" || manager.generation === "yarn-berry"
            ? {}
            : {
                corepackHash: (
                  attestation as ReturnType<
                    typeof readHydratedArtifactAttestation
                  >
                ).corepackHash,
              }),
          generation: manager.generation,
          nodeRuntime,
          packageManager: manager.name,
          toolchainHome:
            manager.name === "bun"
              ? `${toolchainRoot}/${attestation.artifactDigest.slice("sha256:".length)}/bin`
              : manager.name === "yarn" && manager.generation === "yarn-berry"
                ? `${toolchainRoot}/${attestation.artifactDigest.slice("sha512:".length)}/cli`
                : trustedToolchainHomeForArtifact(
                    manager,
                    artifactIdentity,
                    attestation.artifactDigest.slice("sha512:".length),
                  ),
          version: manager.version,
        };
        return hydrated;
      })();
      await this.verifyTrustedToolchainArtifact(artifact);
    } catch (error) {
      this.submittedToolchainLifecycle = { state: "failed" };
      throw error;
    }
    this.submittedToolchainLifecycle = {
      artifact,
      planIdentity,
      projectIntegrity,
      state: "provisioned",
    };
  }

  async syncSubmittedCodeWorkspace(): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    const lifecycle = this.submittedToolchainLifecycle;
    if (lifecycle.state === "unprovisioned") {
      throw new Error(
        "Submitted-code workspace synchronization requires a provisioned toolchain.",
      );
    }
    if (lifecycle.state === "failed") {
      throw failedSubmittedCodeToolchainProvisioningRequiresFreshSandbox();
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
        await this.verifySubmittedProjectIntegrity(
          lifecycle.projectIntegrity,
          lifecycle.artifact.nodeRuntime,
        );
        await this.sandboxLogger.info({
          event: "daytona.sync-submitted-code-workspace.succeeded",
          attempt,
          maxAttempts: submittedCodeSyncMaxAttempts,
        });
        this.submittedToolchainLifecycle = {
          ...lifecycle,
          state: "synchronized",
        };
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

  private async verifySubmittedProjectIntegrity(
    requirement: SubmittedProjectIntegrityRequirement | undefined,
    nodeRuntime: TrustedSubmittedNodeRuntimeArtifact | undefined,
  ): Promise<void> {
    if (
      this.submittedCodeSandbox === undefined ||
      requirement === undefined ||
      nodeRuntime === undefined
    ) {
      throw new Error(
        "Submitted project lockfile integrity requirement is unavailable.",
      );
    }
    const result = await this.executeCancellableCommandInSandbox(
      this.submittedCodeSandbox,
      createSubmittedProjectIntegrityVerificationCommand(
        requirement,
        nodeRuntime,
      ),
      { env: createTrustedToolchainProvisioningEnv() },
      "/",
    );
    if (result.exitCode !== 0) {
      throw new Error(
        "Submitted project lockfile integrity did not match the provisioned plan.",
      );
    }
  }

  private requireBoundSubmittedToolchain(
    plan: SubmittedCodeToolchainPlan,
  ): HydratedSubmittedCodeToolchainArtifact {
    const lifecycle = this.submittedToolchainLifecycle;
    if (lifecycle.state === "failed") {
      throw failedSubmittedCodeToolchainProvisioningRequiresFreshSandbox();
    }
    const { manager } = validateSubmittedToolchainPlan(plan);
    if (lifecycle.state === "unprovisioned") {
      throw new Error(
        `Submitted toolchain ${manager.name}@${manager.version} has not been provisioned and synchronized.`,
      );
    }
    if (
      lifecycle.state !== "synchronized" ||
      lifecycle.planIdentity !== submittedToolchainPlanIdentity(plan, manager)
    ) {
      throw new Error(
        `Submitted toolchain ${manager.name}@${manager.version} requires synchronization after provisioning.`,
      );
    }
    return lifecycle.artifact;
  }

  private async verifyTrustedToolchainArtifact(
    artifact: HydratedSubmittedCodeToolchainArtifact,
  ): Promise<void> {
    const submittedCodeSandbox = this.submittedCodeSandbox;
    if (submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    const result = await this.executeCancellableCommandInSandbox(
      submittedCodeSandbox,
      createTrustedToolchainArtifactVerificationCommand(artifact),
      { env: createTrustedToolchainProvisioningEnv() },
      "/",
    );
    if (result.exitCode !== 0) {
      const diagnostics =
        (result.stderr || result.stdout).trim() || "no diagnostics returned";
      throw new Error(
        `Trusted package-manager artifact verification failed for ${artifact.packageManager}@${artifact.version}: ${diagnostics}`,
      );
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
    options: PreparationWorkspaceDownloadOptions = {},
  ): Promise<void> {
    await this.downloadFilesFromSandbox(this.sandbox, files, options);
  }

  async downloadSubmittedCodeFiles(
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions = {},
  ): Promise<void> {
    await this.downloadFilesFromSandbox(
      this.submittedCodeSandbox ?? this.sandbox,
      files,
      options,
    );
  }

  private async downloadFilesFromSandbox(
    sandbox: DaytonaSdkSandbox,
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions,
  ): Promise<void> {
    if (
      options.maxBytes !== undefined ||
      options.signal !== undefined ||
      options.timeoutMs !== undefined
    ) {
      await this.downloadFilesFromSandboxStreams(sandbox, files, options);
      return;
    }
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

  private async downloadFilesFromSandboxStreams(
    sandbox: DaytonaSdkSandbox,
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions,
  ): Promise<void> {
    if (sandbox.fs.downloadFileStream === undefined) {
      throw new Error("Daytona streaming file download is unavailable.");
    }
    for (const file of files) {
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
      if (options.signal?.aborted === true) abortFromCaller();
      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => controller.abort(new Error("Daytona download timed out.")),
              options.timeoutMs,
            );
      let bytesReceived = 0;
      try {
        await mkdir(dirname(file.destinationPath), { recursive: true });
        const stream = await sandbox.fs.downloadFileStream(file.sourcePath, {
          signal: controller.signal,
          ...(options.timeoutMs === undefined
            ? {}
            : { timeout: Math.max(1, Math.ceil(options.timeoutMs / 1_000)) }),
          ...(options.maxBytes === undefined
            ? {}
            : {
                onProgress(progress) {
                  if (progress.bytesReceived > (options.maxBytes ?? 0)) {
                    controller.abort(
                      new Error(
                        `Daytona download exceeded ${options.maxBytes} bytes.`,
                      ),
                    );
                  }
                },
              }),
        });
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytesReceived += chunk.length;
            if (
              options.maxBytes !== undefined &&
              bytesReceived > options.maxBytes
            ) {
              const error = new Error(
                `Daytona download exceeded ${options.maxBytes} bytes.`,
              );
              controller.abort(error);
              callback(error);
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          stream,
          limiter,
          createWriteStream(file.destinationPath, { flags: "w" }),
          { signal: controller.signal },
        );
      } catch (error) {
        await rm(file.destinationPath, { force: true }).catch(() => undefined);
        if (controller.signal.reason instanceof Error) {
          throw controller.signal.reason;
        }
        throw error;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
      }
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
    let commandStarted = false;
    const pty = await this.createConnectedPty(
      sandbox,
      {
        cols: 120,
        cwd,
        envs: options.env ?? {},
        id: `makeademo-${randomUUID()}`,
        onData: (data) => {
          const chunk = decoder.decode(data);
          ptyForData?.notifyData(chunk);
          if (!commandStarted) return;
          output.push(chunk);
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
      await this.preparePtyTerminal(pty);
      commandStarted = true;
      await pty.sendInput(createNoninteractivePtyCommand(command, exitMarker));
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

  private async executeCancellableCommandInSandbox(
    sandbox: DaytonaSdkSandbox,
    command: string,
    options: PreparationWorkspaceExecuteOptions,
    cwd = "/workspace",
  ): Promise<PreparationWorkspaceCommandResult> {
    const markers = createCancellableCommandMarkers();
    const result = await this.executeStreamingInSandbox(
      sandbox,
      createCancellableCommand(command, markers),
      {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      },
      cwd,
    );
    if (result.exitCode === 143 && result.stderr === "PTY command cancelled.") {
      return result;
    }
    return readCancellableCommandResult(result.stdout, markers);
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

  private async preparePtyTerminal(pty: ManagedPty): Promise<void> {
    const readyMarker = `__MAKEADEMO_PTY_READY__:${randomUUID()}:`;
    const ready = pty.waitForMarker(readyMarker);
    await pty.sendInput(
      `stty -echo -onlcr -icanon && printf '\\n%s\\n' ${shellQuote(readyMarker)}\n`,
    );
    await withTimeout(
      ready,
      this.ptyConnectionTimeoutMs,
      `Daytona PTY terminal setup did not finish within ${this.ptyConnectionTimeoutMs}ms.`,
      () => void pty.cancel(),
    );
  }
}

function createNoninteractivePtyCommand(
  command: string,
  exitMarker: string,
): string {
  const script = [command, `printf '\\n${exitMarker}%s\\n' $?`].join("\n");
  const encoded = Buffer.from(script).toString("base64");
  return `printf '%s' ${shellQuote(encoded)} | base64 -d | /bin/sh; exit\n`;
}

type CancellableCommandMarkers = {
  exit: string;
  stderr: string;
  stdout: string;
};

function createCancellableCommandMarkers(): CancellableCommandMarkers {
  const id = randomUUID();
  return {
    exit: `__MAKEADEMO_COMMAND_EXIT__:${id}:`,
    stderr: `__MAKEADEMO_COMMAND_STDERR__:${id}:`,
    stdout: `__MAKEADEMO_COMMAND_STDOUT__:${id}:`,
  };
}

function createCancellableCommand(
  command: string,
  markers: CancellableCommandMarkers,
): string {
  const id = randomUUID();
  const stdoutPath = `${makeADemoArtifactDirectory}/command-${id}.stdout`;
  const stderrPath = `${makeADemoArtifactDirectory}/command-${id}.stderr`;
  return [
    `mkdir -p ${shellQuote(makeADemoArtifactDirectory)}`,
    `/bin/sh -c ${shellQuote(command)} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`,
    "makeademo_command_exit_code=$?",
    `printf '\\n%s\\n' ${shellQuote(markers.stdout)}`,
    `base64 < ${shellQuote(stdoutPath)} | tr -d '\\n'`,
    `printf '\\n%s\\n' ${shellQuote(markers.stderr)}`,
    `base64 < ${shellQuote(stderrPath)} | tr -d '\\n'`,
    `printf '\\n%s%s\\n' ${shellQuote(markers.exit)} "$makeademo_command_exit_code"`,
    `rm -f ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)}`,
    ":",
  ].join("\n");
}

function readCancellableCommandResult(
  output: string,
  markers: CancellableCommandMarkers,
): PreparationWorkspaceCommandResult {
  const stdoutMarker = findLastFramingMarker(output, markers.stdout, true);
  const stderrMarker = findLastFramingMarker(output, markers.stderr, true);
  const exitMarker = findLastFramingMarker(output, markers.exit, false);
  if (
    stdoutMarker === undefined ||
    stderrMarker === undefined ||
    exitMarker === undefined ||
    stderrMarker.index <= stdoutMarker.index ||
    exitMarker.index <= stderrMarker.index
  ) {
    throw new Error("Daytona command output framing was incomplete.");
  }

  const encodedStdout = output
    .slice(stdoutMarker.end, stderrMarker.index)
    .trim();
  const encodedStderr = output.slice(stderrMarker.end, exitMarker.index).trim();
  const exitCode = output
    .slice(exitMarker.end)
    .trim()
    .match(/^(\d+)/)?.[1];
  if (exitCode === undefined) {
    throw new Error("Daytona command output framing was incomplete.");
  }

  return {
    exitCode: Number(exitCode),
    stderr: Buffer.from(encodedStderr, "base64").toString("utf8"),
    stdout: Buffer.from(encodedStdout, "base64").toString("utf8"),
  };
}

function findLastFramingMarker(
  output: string,
  marker: string,
  includesTrailingNewline: boolean,
): { end: number; index: number } | undefined {
  const expression = new RegExp(
    `\\r?\\n${escapeRegExp(marker)}${includesTrailingNewline ? "\\r?\\n" : ""}`,
    "g",
  );
  let lastMatch: RegExpExecArray | null = null;
  for (
    let match = expression.exec(output);
    match !== null;
    match = expression.exec(output)
  ) {
    lastMatch = match;
  }
  return lastMatch === null
    ? undefined
    : { end: lastMatch.index + lastMatch[0].length, index: lastMatch.index };
}

function createSubmittedProjectExecution(
  request: SubmittedProjectExecutionRequest,
  provisioned: HydratedSubmittedCodeToolchainArtifact,
  requestedEnvironment: Record<string, string> | undefined = undefined,
): { command: string; cwd: string; env: Record<string, string> } {
  const { plan } = request;
  const { cwd, manager } = validateSubmittedToolchainPlan(plan);
  const install = immutableInstallCommand(manager);
  const expectedArgv = install?.argv;
  if (
    install === null ||
    expectedArgv === undefined ||
    request.executable !== install.executable ||
    !sameArgv(request.argv, expectedArgv)
  ) {
    throw new Error("Submitted project execution is not the catalog install.");
  }
  if (
    manager.name !== "bun" &&
    manager.generation !== "yarn-berry" &&
    provisioned.corepackHash === undefined
  ) {
    throw new Error("Verified Corepack integrity is unavailable.");
  }
  return {
    ...createArtifactBoundSubmittedExecution(
      [request.executable, ...request.argv].map(shellQuote).join(" "),
      provisioned,
      requestedEnvironment,
      request.installProfile === "bounded"
        ? createBoundedInstallEnvironment(request.plan)
        : undefined,
    ),
    cwd,
  };
}

type HydratedSubmittedCodeToolchainArtifact = {
  artifactIdentity: string;
  binPath: string;
  corepackHash?: `sha512.${string}`;
  generation: NonNullable<
    SubmittedCodeToolchainPlan["packageManager"]
  >["generation"];
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact;
  packageManager: NonNullable<
    SubmittedCodeToolchainPlan["packageManager"]
  >["name"];
  toolchainHome: string;
  version: string;
};

type SubmittedProjectIntegrityRequirement = {
  expected: `sha256:${string}`;
  filename: string;
  projectDirectory: string;
};

type SubmittedToolchainLifecycle =
  | { state: "unprovisioned" }
  | { state: "failed" }
  | {
      artifact: HydratedSubmittedCodeToolchainArtifact;
      planIdentity: string;
      projectIntegrity: SubmittedProjectIntegrityRequirement;
      state: "provisioned" | "synchronized";
    };

function createSubmittedRuntimeExecution(
  request: SubmittedProjectRuntimeRequest,
  provisioned: HydratedSubmittedCodeToolchainArtifact,
): { command: string; cwd: string; env: Record<string, string> } {
  validateSubmittedRuntimePlan(request.plan);
  return {
    ...createArtifactBoundSubmittedExecution(request.command, provisioned),
    cwd: "/workspace",
  };
}

function createArtifactBoundSubmittedExecution(
  command: string,
  artifact: HydratedSubmittedCodeToolchainArtifact,
  requested: Record<string, string> | undefined = undefined,
  backendOwned: Record<string, string> | undefined = undefined,
): { command: string; env: Record<string, string> } {
  return {
    command,
    env: createArtifactRuntimeEnv(artifact, requested, backendOwned),
  };
}

function createArtifactRuntimeEnv(
  artifact: HydratedSubmittedCodeToolchainArtifact,
  requested: Record<string, string> | undefined = undefined,
  backendOwned: Record<string, string> | undefined = undefined,
): Record<string, string> {
  return {
    ...createSubmittedRuntimeEnv({
      ...requested,
      ...(artifact.packageManager === "bun" ||
      artifact.generation === "yarn-berry"
        ? {}
        : { COREPACK_HOME: artifact.toolchainHome }),
    }),
    ...backendOwned,
    PATH: `${artifact.binPath}:${artifact.nodeRuntime.root}/bin:${submittedSystemUtilitiesPath}`,
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
    submittedCodeToolchainCatalog.node[plan.node.family].lifecycle !==
      plan.node.lifecycle ||
    !semverSatisfies(
      plan.node.version,
      `>=${submittedCodeToolchainCatalog.node[plan.node.family].compatibilityMinimum} <${plan.node.family + 1}`,
      { includePrerelease: false, loose: false },
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
  assertCompatibleManager(manager);
  const install = immutableInstallCommand(manager);
  if (
    install === null ||
    plan.install.executable !== install.executable ||
    !sameArgv(plan.install.argv, install.argv)
  ) {
    throw new Error("Submitted toolchain plan is not the catalog install.");
  }
  if (manager.name !== "bun") createCorepackDescriptor(manager);
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
    submittedCodeToolchainCatalog.node[plan.node.family].lifecycle !==
      plan.node.lifecycle ||
    !semverSatisfies(
      plan.node.version,
      `>=${submittedCodeToolchainCatalog.node[plan.node.family].compatibilityMinimum} <${plan.node.family + 1}`,
      { includePrerelease: false, loose: false },
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
        key === "COREPACK_HOME" ||
        isApprovedSubmittedRuntimeEnvironmentKey(key),
    ),
  );
  return {
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_ENABLE_STRICT: "1",
    COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "0",
    COREPACK_ENV_FILE: "0",
    YARN_IGNORE_PATH: "1",
    ...allowed,
    MAKEADEMO_PLAYWRIGHT_MODULE_ROOT: submittedCodePlaywrightModuleRoot,
    PLAYWRIGHT_BROWSERS_PATH: submittedCodePlaywrightBrowsersPath,
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

function immutableInstallCommand(
  manager: NonNullable<
    SubmittedProjectExecutionRequest["plan"]["packageManager"]
  >,
): {
  argv: readonly string[];
  executable: string;
} {
  if (manager.name === "npm") {
    return { argv: ["ci", "--maxsockets=4"], executable: "npm" };
  }
  if (manager.name === "pnpm") {
    return {
      argv: [
        "install",
        "--frozen-lockfile",
        "--child-concurrency=2",
        "--network-concurrency=4",
      ],
      executable: "pnpm",
    };
  }
  if (manager.name === "bun") {
    return { argv: ["install", "--frozen-lockfile"], executable: "bun" };
  }
  return {
    argv:
      manager.generation === "yarn-classic"
        ? ["install", "--frozen-lockfile", "--network-concurrency", "4"]
        : ["install", "--immutable"],
    executable: "yarn",
  };
}

function assertCompatibleManager(
  manager: NonNullable<
    SubmittedProjectExecutionRequest["plan"]["packageManager"]
  >,
): void {
  const ranges: Record<typeof manager.name, string> = {
    bun: ">=1.2.16 <2",
    npm: ">=8 <12",
    pnpm: ">=8 <12",
    yarn: ">=1 <5",
  };
  if (
    !/^\d+\.\d+\.\d+$/.test(manager.version) ||
    !semverSatisfies(manager.version, ranges[manager.name])
  ) {
    throw new Error(
      `Unsupported package-manager compatibility generation: ${manager.name}@${manager.version}`,
    );
  }
  const expectedGeneration =
    manager.name === "yarn"
      ? manager.version.startsWith("1.")
        ? "yarn-classic"
        : "yarn-berry"
      : manager.name === "bun"
        ? "bun-1"
        : manager.name === "npm"
          ? "npm-modern"
          : "pnpm-modern";
  if (manager.generation !== expectedGeneration) {
    throw new Error(
      `Package-manager generation does not match ${manager.name}@${manager.version}.`,
    );
  }
}

function submittedToolchainPlanIdentity(
  plan: SubmittedCodeToolchainPlan,
  manager: NonNullable<SubmittedCodeToolchainPlan["packageManager"]>,
): string {
  return JSON.stringify({
    catalogRevision: plan.catalogRevision,
    generation: manager.generation,
    install: plan.install,
    nodeVersion: plan.node.version,
    packageManager: manager.name,
    projectRoot: plan.projectRoot,
    projectIntegrity: manager.projectIntegrity ?? null,
    upstreamIntegrity: manager.corepackHash ?? null,
    version: manager.version,
  });
}

function readSubmittedProjectIntegrityRequirement(
  plan: SubmittedCodeToolchainPlan,
  manager: NonNullable<SubmittedCodeToolchainPlan["packageManager"]>,
): SubmittedProjectIntegrityRequirement {
  const expected = manager.projectIntegrity;
  const lockEvidence = plan.evidence.filter(
    (entry) => entry.kind === "lockfile" && entry.value === manager.name,
  );
  const filename = lockEvidence[0]?.source;
  if (
    expected === undefined ||
    !/^sha256:[a-f0-9]{64}$/.test(expected) ||
    lockEvidence.length !== 1 ||
    filename === undefined ||
    !/^[A-Za-z0-9._-]+$/.test(filename)
  ) {
    throw new Error(
      "Submitted toolchain plan has no canonical lockfile integrity requirement.",
    );
  }
  return {
    expected,
    filename,
    projectDirectory: resolveSubmittedProjectCwd(plan.projectRoot),
  };
}

function submittedToolchainArtifactIdentity(
  nodeVersion: string,
  manager: NonNullable<SubmittedCodeToolchainPlan["packageManager"]>,
): string {
  return JSON.stringify({
    generation: manager.generation,
    nodeVersion,
    packageManager: manager.name,
    upstreamIntegrity: manager.corepackHash ?? null,
    version: manager.version,
  });
}

function freshSubmittedCodeSandboxRequired(): Error {
  return new Error(
    "Submitted-code sandbox is bound to a different exact runtime; use a fresh submitted-code sandbox for the changed runtime.",
  );
}

function failedSubmittedCodeToolchainProvisioningRequiresFreshSandbox(): Error {
  return new Error(
    "Submitted-code toolchain provisioning failed in this child; use a fresh submitted-code sandbox before retrying.",
  );
}

function trustedToolchainRootForArtifact(
  input: {
    name: string;
    version: string;
  },
  artifactIdentity: string,
): string {
  const identityDigest = createHash("sha256")
    .update(artifactIdentity)
    .digest("hex")
    .slice(0, 24);
  return `/opt/makeademo/toolchains/${input.name}-${input.version}-${identityDigest}`;
}

function trustedToolchainHomeForArtifact(
  input: { name: string; version: string },
  artifactIdentity: string,
  digest: string,
): string {
  return `${trustedToolchainRootForArtifact(input, artifactIdentity)}/${digest}/corepack`;
}

function createTrustedToolchainProvisioningEnv(): Record<string, string> {
  return {
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "1",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "0",
    COREPACK_ENV_FILE: "0",
    COREPACK_NPM_REGISTRY: "https://registry.npmjs.org",
    HOME: "/var/empty",
  };
}

function createTrustedToolchainHydrationCommand(
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
  manager: NonNullable<
    SubmittedProjectExecutionRequest["plan"]["packageManager"]
  >,
  toolchainRoot: string,
): string {
  const artifactPath = `${toolchainRoot}/artifact.tgz`;
  const stagingCorepackHome = `${toolchainRoot}/staging-corepack`;
  const registryMetadata = createOfficialRegistryMetadataCommand(
    nodeRuntime,
    manager,
  );
  const launcherScript = createCorepackLauncherScript();
  const nodeExecutable = trustedNodeExecutable(nodeRuntime);
  const corepackCli = trustedCorepackCli(nodeRuntime);
  const corepackCommand = `${shellQuote(nodeExecutable)} ${shellQuote(corepackCli)}`;
  return [
    "set -eu",
    `artifact=${shellQuote(artifactPath)}`,
    `toolchain_root=${shellQuote(toolchainRoot)}`,
    'rm -rf "$toolchain_root"',
    'mkdir -p "$toolchain_root"',
    `mkdir -p ${shellQuote(`${stagingCorepackHome}/v1/${manager.name}`)}`,
    registryMetadata,
    ...(manager.corepackHash === undefined
      ? []
      : [`test \"$upstream_hash\" = ${shellQuote(manager.corepackHash)}`]),
    `descriptor="${manager.name}@${manager.version}+$upstream_hash"`,
    `COREPACK_HOME=${shellQuote(stagingCorepackHome)} COREPACK_NPM_REGISTRY=${shellQuote("https://registry.npmjs.org")} ${corepackCommand} pack \"$descriptor\" -o \"$artifact\"`,
    "digest=$(sha512sum \"$artifact\" | awk '{print $1}')",
    `COREPACK_HOME=${shellQuote(stagingCorepackHome)} ${corepackCommand} install -g --cache-only \"$artifact\"`,
    'target="$toolchain_root/$digest"',
    'mkdir -p "$target/bin"',
    'mv "$toolchain_root/staging-corepack" "$target/corepack"',
    `launcher="$target/bin/${manager.name}"`,
    `printf %s ${shellQuote(launcherScript)} > "$launcher"`,
    `printf '%s\n' "exec ${shellQuote(nodeExecutable)} ${shellQuote(corepackCli)} ${manager.name}@${manager.version}+$upstream_hash \\\"\\$@\\\"" >> "$launcher"`,
    'chmod 0555 "$launcher"',
    'rm -f "$artifact"',
    'chown -R root:root "$target"',
    'chmod -R a-w "$target"',
    "printf 'MAKEADEMO_UPSTREAM_SRI=%s\\n' \"$upstream_sri\"",
    "printf 'MAKEADEMO_ARTIFACT_SHA512=%s\\n' \"$digest\"",
  ].join(" && ");
}

function createTrustedYarnBerryHydrationCommand(
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
  manager: NonNullable<
    SubmittedProjectExecutionRequest["plan"]["packageManager"]
  >,
  toolchainRoot: string,
): string {
  const artifactPath = `${toolchainRoot}/artifact.tgz`;
  const registryMetadata = createOfficialRegistryMetadataCommand(
    nodeRuntime,
    manager,
  );
  const launcherScript = [
    "#!/bin/sh",
    "set -eu",
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'yarn_cli="$(dirname "$launcher_dir")/cli/yarn.js"',
    `exec ${shellQuote(trustedNodeExecutable(nodeRuntime))} "$yarn_cli" "$@"`,
    "",
  ].join("\n");
  return [
    "set -eu",
    `artifact=${shellQuote(artifactPath)}`,
    `toolchain_root=${shellQuote(toolchainRoot)}`,
    'rm -rf "$toolchain_root"',
    'mkdir -p "$toolchain_root/staging/cli"',
    registryMetadata,
    `curl --fail --silent --show-error --location --max-filesize 67108864 --proto '=https' --tlsv1.2 "$tarball_url" -o "$artifact"`,
    'test "$(sha512sum "$artifact" | awk \'{print $1}\')" = "${upstream_hash#sha512.}"',
    `test "$(tar -tzf "$artifact" | grep -Fxc ${shellQuote("package/bin/yarn.js")})" = 1`,
    'yarn_cli="$toolchain_root/staging/cli/yarn.js"',
    `tar -xOzf "$artifact" ${shellQuote("package/bin/yarn.js")} | head -c 67108865 > "$yarn_cli"`,
    'yarn_cli_size=$(wc -c < "$yarn_cli" | tr -d " ")',
    'test "$yarn_cli_size" -gt 0',
    'test "$yarn_cli_size" -le 67108864',
    ...createDeclaredYarnBerryHashVerificationCommands(manager),
    "digest=$(sha512sum \"$yarn_cli\" | awk '{print $1}')",
    'target="$toolchain_root/$digest"',
    'mkdir -p "$target/bin"',
    'mv "$toolchain_root/staging/cli" "$target/cli"',
    'launcher="$target/bin/yarn"',
    `printf %s ${shellQuote(launcherScript)} > "$launcher"`,
    'chmod 0555 "$launcher"',
    'rm -rf "$toolchain_root/staging"',
    'rm -f "$artifact"',
    'chown -R root:root "$target"',
    'chmod -R a-w "$target"',
    "printf 'MAKEADEMO_UPSTREAM_SRI=%s\\n' \"$upstream_sri\"",
    "printf 'MAKEADEMO_ARTIFACT_SHA512=%s\\n' \"$digest\"",
  ].join(" && ");
}

function createDeclaredYarnBerryHashVerificationCommands(
  manager: NonNullable<
    SubmittedProjectExecutionRequest["plan"]["packageManager"]
  >,
): string[] {
  if (manager.corepackHash === undefined) return [];
  const match = /^sha(224|256|384|512)\.([A-Fa-f0-9]+)$/.exec(
    manager.corepackHash,
  );
  const algorithmBits = match?.[1];
  const digest = match?.[2];
  if (
    algorithmBits === undefined ||
    digest === undefined ||
    digest.length !== Number(algorithmBits) / 4
  ) {
    throw new Error("Invalid Corepack package-manager integrity suffix.");
  }
  return [
    `test "sha${algorithmBits}.$(sha${algorithmBits}sum "$yarn_cli" | awk '{print $1}')" = ${shellQuote(`sha${algorithmBits}.${digest.toLowerCase()}`)}`,
  ];
}

function createCorepackLauncherScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'export COREPACK_HOME="$(dirname "$launcher_dir")/corepack"',
    "export COREPACK_DEFAULT_TO_LATEST=0",
    "export COREPACK_ENABLE_AUTO_PIN=0",
    "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "export COREPACK_ENABLE_NETWORK=0",
    "export COREPACK_ENABLE_PROJECT_SPEC=0",
    "export COREPACK_ENABLE_STRICT=1",
    "export COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0",
    "export COREPACK_ENV_FILE=0",
    "",
  ].join("\n");
}

function createTrustedBunHydrationCommand(
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
  version: string,
  toolchainRoot: string,
): string {
  const tag = `bun-v${version}`;
  const assetName = "bun-linux-x64.zip";
  const apiUrl = `https://api.github.com/repos/oven-sh/bun/releases/tags/${tag}`;
  const assetUrl = `https://github.com/oven-sh/bun/releases/download/${tag}/${assetName}`;
  const metadataParser = [
    "const fs = require('node:fs');",
    "const release = JSON.parse(fs.readFileSync(0, 'utf8'));",
    `const expectedTag = ${JSON.stringify(tag)};`,
    `const expectedName = ${JSON.stringify(assetName)};`,
    `const expectedUrl = ${JSON.stringify(assetUrl)};`,
    "if (release?.tag_name !== expectedTag || release?.draft !== false || release?.prerelease !== false) process.exit(1);",
    "const assets = Array.isArray(release?.assets) ? release.assets.filter((asset) => asset?.name === expectedName) : [];",
    "if (assets.length !== 1) process.exit(1);",
    "const asset = assets[0];",
    "if (asset?.browser_download_url !== expectedUrl || typeof asset?.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 134217728) process.exit(1);",
    "if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) process.exit(1);",
    "process.stdout.write(`${asset.digest.slice('sha256:'.length)} ${asset.size}`);",
  ].join(" ");
  const memberMetadataParser = [
    "const fs = require('node:fs');",
    "const metadata = fs.readFileSync(0, 'utf8');",
    "const matches = [...metadata.matchAll(/uncompressed size:\\s+([0-9]+) bytes/g)];",
    "if (matches.length !== 1) process.exit(1);",
    "const uncompressedSize = Number(matches[0][1]);",
    "if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize <= 0 || uncompressedSize > 268435456) process.exit(1);",
    "process.stdout.write(String(uncompressedSize));",
  ].join(" ");
  return [
    "set -eu",
    `toolchain_root=${shellQuote(toolchainRoot)}`,
    'rm -rf "$toolchain_root"',
    'mkdir -p "$toolchain_root/staging"',
    `metadata=$(curl --fail --silent --show-error --location --max-filesize 2097152 --proto '=https' --tlsv1.2 -H ${shellQuote("Accept: application/vnd.github+json")} -H ${shellQuote("X-GitHub-Api-Version: 2022-11-28")} ${shellQuote(apiUrl)})`,
    `authority=$(printf '%s' "$metadata" | ${createTrustedNodeCommand(nodeRuntime, metadataParser)})`,
    "upstream_sha256=${authority%% *}",
    "asset_size=${authority##* }",
    `asset="$toolchain_root/${assetName}"`,
    `curl --fail --silent --show-error --location --max-filesize 134217728 --proto '=https' --tlsv1.2 ${shellQuote(assetUrl)} -o "$asset"`,
    'test "$(wc -c < "$asset" | tr -d " ")" = "$asset_size"',
    'test "$(sha256sum "$asset" | awk \'{print $1}\')" = "$upstream_sha256"',
    `test "$(unzip -Z1 "$asset" | grep -Fxc ${shellQuote("bun-linux-x64/bun")})" = 1`,
    `member_size=$(unzip -Z -v "$asset" ${shellQuote("bun-linux-x64/bun")} | ${createTrustedNodeCommand(nodeRuntime, memberMetadataParser)})`,
    'test "$member_size" -gt 0',
    'test "$member_size" -le 268435456',
    `unzip -q "$asset" ${shellQuote("bun-linux-x64/bun")} -d "$toolchain_root/staging"`,
    'binary="$toolchain_root/staging/bun-linux-x64/bun"',
    'test -f "$binary"',
    "artifact_sha256=$(sha256sum \"$binary\" | awk '{print $1}')",
    'target="$toolchain_root/$artifact_sha256/bin"',
    'mkdir -p "$target"',
    'mv "$binary" "$target/bun"',
    'rm -rf "$toolchain_root/staging"',
    'rm -f "$asset"',
    'chown -R root:root "$toolchain_root/$artifact_sha256"',
    'chmod -R a-w "$toolchain_root/$artifact_sha256"',
    'chmod a+x "$target/bun"',
    `test "$("$target/bun" --version)" = ${shellQuote(version)}`,
    "printf 'MAKEADEMO_UPSTREAM_SHA256=%s\\n' \"$upstream_sha256\"",
    "printf 'MAKEADEMO_ARTIFACT_SHA256=%s\\n' \"$artifact_sha256\"",
  ].join(" && ");
}

function createTrustedToolchainArtifactVerificationCommand(
  artifact: HydratedSubmittedCodeToolchainArtifact,
): string {
  const launcher = `${artifact.binPath}/${artifact.packageManager}`;
  const layoutVerification =
    artifact.packageManager === "bun"
      ? 'test -x "$toolchain_home/bun" || fail "bun-binary"'
      : artifact.generation === "yarn-berry"
        ? 'test -f "$toolchain_home/yarn.js" || fail "yarn-berry-cli"'
        : `test -d "$toolchain_home/v1/${artifact.packageManager}/${artifact.version}" || fail "corepack-release"`;
  return [
    "set -eu",
    ": MAKEADEMO_VERIFY_TRUSTED_ARTIFACT",
    `toolchain_home=${shellQuote(artifact.toolchainHome)}`,
    `bin_path=${shellQuote(artifact.binPath)}`,
    'artifact_root=$(dirname "$toolchain_home")',
    'artifact_parent=$(dirname "$artifact_root")',
    `launcher=${shellQuote(launcher)}`,
    "fail() { printf 'Trusted artifact invariant failed: %s\\n' \"$1\" >&2; exit 1; }",
    'test -d "$artifact_root" || fail "artifact-root-directory"',
    'test -d "$toolchain_home" || fail "toolchain-home-directory"',
    'test -d "$bin_path" || fail "launcher-directory"',
    'test "$(stat -c %u "$artifact_parent")" = 0 || fail "artifact-parent-owner"',
    'test "$(stat -c %u "$artifact_root")" = 0 || fail "artifact-root-owner"',
    'test -z "$(find "$artifact_root" -xdev ! -user root -print -quit)" || fail "artifact-tree-owner"',
    'test -z "$(find "$artifact_root" -xdev -perm /222 -print -quit)" || fail "artifact-tree-mode"',
    `runuser -u ${shellQuote(agentWorkspaceUser)} -- test ! -w "$artifact_parent" || fail "artifact-parent-pwuser-write"`,
    `runuser -u ${shellQuote(agentWorkspaceUser)} -- test ! -w "$artifact_root" || fail "artifact-root-pwuser-write"`,
    `runuser -u ${shellQuote(agentWorkspaceUser)} -- test ! -w "$toolchain_home" || fail "toolchain-home-pwuser-write"`,
    `runuser -u ${shellQuote(agentWorkspaceUser)} -- test ! -w "$bin_path" || fail "launcher-directory-pwuser-write"`,
    layoutVerification,
    'test -x "$launcher" || fail "launcher-executable"',
    `runuser -u ${shellQuote(agentWorkspaceUser)} -- test -x "$launcher" || fail "launcher-pwuser-executable"`,
    'actual_version=$("$launcher" --version) || fail "launcher-version-command"',
    `test "$actual_version" = ${shellQuote(artifact.version)} || fail "launcher-version"`,
  ].join("\n");
}

function createOfficialRegistryMetadataCommand(
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
  manager: NonNullable<
    SubmittedProjectExecutionRequest["plan"]["packageManager"]
  >,
): string {
  const authority =
    manager.name === "yarn" && manager.generation === "yarn-berry"
      ? {
          metadataName: "@yarnpkg%2fcli-dist",
          tarballPath: "/@yarnpkg/cli-dist/-/",
        }
      : {
          metadataName: manager.name,
          tarballPath: `/${manager.name}/-/`,
        };
  const registryUrl = `https://registry.npmjs.org/${authority.metadataName}/${manager.version}`;
  const expectedMetadataName =
    manager.name === "yarn" && manager.generation === "yarn-berry"
      ? "@yarnpkg/cli-dist"
      : manager.name;
  const parser = [
    "const fs = require('node:fs');",
    "const metadata = JSON.parse(fs.readFileSync(0, 'utf8'));",
    `const expectedName = ${JSON.stringify(expectedMetadataName)};`,
    `const expectedVersion = ${JSON.stringify(manager.version)};`,
    "if (metadata?.name !== expectedName || metadata?.version !== expectedVersion) { process.stderr.write('MAKEADEMO_REGISTRY_RELEASE_UNAVAILABLE\\n'); process.exit(42); }",
    "if (Object.hasOwn(metadata, 'deprecated') && metadata.deprecated != null && String(metadata.deprecated).trim() !== '') { process.stderr.write('MAKEADEMO_REGISTRY_RELEASE_DEPRECATED\\n'); process.exit(42); }",
    "const integrity = metadata?.dist?.integrity;",
    "const tarball = metadata?.dist?.tarball;",
    "if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) process.exit(1);",
    "const digest = Buffer.from(integrity.slice('sha512-'.length), 'base64');",
    "if (digest.length !== 64) process.exit(1);",
    "const url = new URL(tarball);",
    `if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || !url.pathname.startsWith(${JSON.stringify(authority.tarballPath)})) process.exit(1);`,
    "process.stdout.write(`${integrity}\\n${url.toString()}`);",
  ].join(" ");
  const hashConverter = [
    "const fs = require('node:fs');",
    "const integrity = fs.readFileSync(0, 'utf8').trim();",
    "const digest = Buffer.from(integrity.slice('sha512-'.length), 'base64');",
    "if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) || digest.length !== 64) process.exit(1);",
    "process.stdout.write(`sha512.${digest.toString('hex')}`);",
  ].join(" ");
  return [
    "registry_metadata_file=$(mktemp)",
    `metadata_http_status=$(curl --silent --show-error --location --max-filesize 1048576 --proto '=https' --tlsv1.2 --output "$registry_metadata_file" --write-out '%{http_code}' ${shellQuote(registryUrl)}) || { metadata_curl_status=$?; rm -f "$registry_metadata_file"; exit "$metadata_curl_status"; }`,
    'if [ "$metadata_http_status" != 200 ]; then rm -f "$registry_metadata_file"; if [ "$metadata_http_status" = 404 ]; then printf \'MAKEADEMO_REGISTRY_RELEASE_UNAVAILABLE\\n\' >&2; exit 42; fi; exit 1; fi',
    'metadata=$(cat "$registry_metadata_file")',
    'rm -f "$registry_metadata_file"',
    `registry_authority=$(printf '%s' "$metadata" | ${createTrustedNodeCommand(nodeRuntime, parser)})`,
    `upstream_sri=$(printf '%s\n' "$registry_authority" | head -n 1)`,
    `tarball_url=$(printf '%s\n' "$registry_authority" | tail -n 1)`,
    'test -n "$upstream_sri"',
    'test -n "$tarball_url"',
    `upstream_hash=$(printf '%s' "$upstream_sri" | ${createTrustedNodeCommand(nodeRuntime, hashConverter)})`,
  ].join(" && ");
}

function createSubmittedProjectIntegrityVerificationCommand(
  requirement: SubmittedProjectIntegrityRequirement,
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
): string {
  const verifier = [
    "const { createHash } = require('node:crypto');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const projectDirectory = ${JSON.stringify(requirement.projectDirectory)};`,
    `const filename = ${JSON.stringify(requirement.filename)};`,
    `const expected = ${JSON.stringify(requirement.expected)};`,
    "const workspace = '/workspace';",
    "const lockfile = path.join(projectDirectory, filename);",
    "const relative = path.relative(workspace, lockfile);",
    "if (relative.startsWith('..') || path.isAbsolute(relative)) process.exit(1);",
    "let current = workspace;",
    "const segments = relative.split(path.sep).filter(Boolean);",
    "for (const [index, segment] of segments.entries()) {",
    "  current = path.join(current, segment);",
    "  const stat = fs.lstatSync(current);",
    "  if (stat.isSymbolicLink()) process.exit(1);",
    "  if (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()) process.exit(1);",
    "}",
    "const descriptor = fs.openSync(lockfile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);",
    "try {",
    "  if (!fs.fstatSync(descriptor).isFile()) process.exit(1);",
    "  const digest = `sha256:${createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex')}`;",
    "  if (digest !== expected) process.exit(1);",
    "} finally { fs.closeSync(descriptor); }",
  ].join(" ");
  return [
    ": MAKEADEMO_VERIFY_PROJECT_INTEGRITY",
    createTrustedNodeCommand(nodeRuntime, verifier),
  ].join(" && ");
}

function createTrustedNodeCommand(
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
  script: string,
): string {
  return [trustedNodeExecutable(nodeRuntime), "-e", script]
    .map(shellQuote)
    .join(" ");
}

function trustedNodeExecutable(
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
): string {
  return `${nodeRuntime.root}/bin/node`;
}

function trustedCorepackCli(
  nodeRuntime: TrustedSubmittedNodeRuntimeArtifact,
): string {
  return `${nodeRuntime.root}/bin/corepack`;
}

function readHydratedArtifactAttestation(stdout: string): {
  artifactDigest: `sha512:${string}`;
  corepackHash: `sha512.${string}`;
} {
  const artifactDigest = /MAKEADEMO_ARTIFACT_SHA512=([a-f0-9]{128})/.exec(
    stdout,
  )?.[1];
  const upstreamIntegrity =
    /MAKEADEMO_UPSTREAM_SRI=(sha512-[A-Za-z0-9+/]+={0,2})/.exec(stdout)?.[1];
  if (artifactDigest === undefined || upstreamIntegrity === undefined) {
    throw new Error(
      "Trusted package-manager hydration did not return its registry integrity attestation.",
    );
  }
  const digest = Buffer.from(
    upstreamIntegrity.slice("sha512-".length),
    "base64",
  );
  if (digest.length !== 64) {
    throw new Error(
      "Trusted package-manager hydration returned an invalid SHA-512 SRI.",
    );
  }
  return {
    artifactDigest: `sha512:${artifactDigest}`,
    corepackHash: `sha512.${digest.toString("hex")}`,
  };
}

function readBunArtifactAttestation(stdout: string): {
  artifactDigest: `sha256:${string}`;
} {
  const artifactDigest = /MAKEADEMO_ARTIFACT_SHA256=([a-f0-9]{64})/.exec(
    stdout,
  )?.[1];
  const upstreamDigest = /MAKEADEMO_UPSTREAM_SHA256=([a-f0-9]{64})/.exec(
    stdout,
  )?.[1];
  if (artifactDigest === undefined || upstreamDigest === undefined) {
    throw new Error(
      "Trusted Bun hydration did not return its authoritative GitHub SHA-256 attestation.",
    );
  }
  return {
    artifactDigest: `sha256:${artifactDigest}`,
  };
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
  private readonly markerWaiters = new Map<
    string,
    { reject: (error: unknown) => void; resolve: () => void }
  >();
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
    const error = new Error("PTY command cancelled.");
    this.completionResolve({ error: error.message, exitCode: 143 });
    for (const waiter of this.markerWaiters.values()) waiter.reject(error);
    this.markerWaiters.clear();
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
    for (const waiter of this.markerWaiters.values()) waiter.reject(error);
    this.markerWaiters.clear();
  }

  notifyData(chunk: string): void {
    if (this.cancelled) return;
    this.markerBuffer = (this.markerBuffer + chunk).slice(-256);
    for (const [marker, waiter] of this.markerWaiters) {
      if (!this.markerBuffer.includes(marker)) continue;
      this.markerWaiters.delete(marker);
      waiter.resolve();
    }
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

  waitForMarker(marker: string): Promise<void> {
    if (this.markerBuffer.includes(marker)) return Promise.resolve();
    if (this.cancelled) {
      return Promise.reject(new Error("PTY command cancelled."));
    }
    return new Promise((resolve, reject) => {
      this.markerWaiters.set(marker, { reject, resolve });
    });
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

function createUnprivilegedAgentCommand(command: string): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return `printf %s ${shellQuote(encoded)} | base64 --decode | runuser -u ${shellQuote(agentWorkspaceUser)} -- env -i HOME=${shellQuote(agentWorkspaceHome)} TMPDIR=${shellQuote(agentWorkspaceTemp)} PATH=${shellQuote(agentWorkspacePath)} /bin/bash --noprofile --norc`;
}

function createUnprivilegedSubmittedCodeExecution(
  command: string,
  env: Readonly<Record<string, string>>,
): { command: string } {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const environment = Object.entries({
    HOME: agentWorkspaceHome,
    PATH: agentWorkspacePath,
    TMPDIR: agentWorkspaceTemp,
    ...env,
  })
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return {
    command: `printf %s ${shellQuote(encoded)} | base64 --decode | runuser -u ${shellQuote(agentWorkspaceUser)} -- env -i ${environment} /bin/bash --noprofile --norc`,
  };
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
      `mkdir -p ${shellQuote(agentWorkspaceHome)} ${shellQuote(agentWorkspaceTemp)} ${shellQuote(`${workspaceMakeADemoDirectory}/cache`)}`,
      `if id -u ${shellQuote(agentWorkspaceUser)} >/dev/null 2>&1; then find /workspace -xdev -exec chown -h ${shellQuote(`${agentWorkspaceUser}:${agentWorkspaceUser}`)} {} +; fi`,
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
