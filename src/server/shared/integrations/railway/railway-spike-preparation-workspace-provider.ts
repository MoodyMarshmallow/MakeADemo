import { randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  unlinkSync,
} from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  PreparationWorkspaceUploadFile,
  PreparationWorkspaceUploadOptions,
  SubmittedProjectExecutionRequest,
  SubmittedProjectRuntimeRequest,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import type { SubmittedCodeToolchainPlan } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import type {
  RailwaySandboxGateway,
  RailwaySandboxGatewayCommand,
  RailwaySandboxGatewaySandbox,
} from "./railway-sandbox-gateway.interface";
import { railwaySpikeTemplateRecipe } from "./railway-spike-template-recipe";

const defaultCommandTimeoutMs = 10 * 60_000;
const defaultRuntimeDetachTimeoutMs = 5_000;
// Railway SDK 3.6 performs two sequential readiness phases inside create():
// up to 300 seconds for the template and then 300 seconds for the sandbox.
// Keep a bounded API/scheduling margin outside those provider-owned phases.
const defaultCreateTimeoutMs = 630_000;
// A timed-out call can still consume both SDK phases before exact-ID cleanup.
// The drain additionally covers the gateway's 30-second destroy/refresh bound
// and a final API/scheduling margin, failing closed if cleanup cannot be proven.
const defaultPendingCreationDrainTimeoutMs = 640_000;
const defaultTransferMaxBytes = 100 * 1024 * 1024;
const defaultTransferTimeoutMs = 2 * 60_000;
const fixedIdleTimeoutMinutes = 15;
const fixedCanaryNodeVersion = railwaySpikeTemplateRecipe.node.version;
const fixedCanaryNpmVersion = railwaySpikeTemplateRecipe.node.npmVersion;
const fixedCanaryPlaywrightModuleRoot =
  "/opt/makeademo/playwright-runtime/node_modules";
const fixedCanaryPlaywrightBrowsersPath = "/ms-playwright";
const fixedCanaryNodeBin = railwaySpikeTemplateRecipe.runtimePaths.nodeBin;
const fixedCanaryNpmBin = railwaySpikeTemplateRecipe.runtimePaths.npmBin;
const fixedCanaryNodeBinPath =
  "/opt/makeademo/toolchains/node/versions/22.23.1/bin:/usr/local/bin:/usr/bin:/bin";
const fixedCanaryUserHome = railwaySpikeTemplateRecipe.user.home;
const fixedCanaryUserTmp = railwaySpikeTemplateRecipe.user.temporaryDirectory;
const fixedCanaryUser = railwaySpikeTemplateRecipe.user.name;
const trustedInspectorCommand = "makeademo-inspect-submitted-code-toolchain";
const trustedInspectorPath = railwaySpikeTemplateRecipe.trustedFiles[0].path;
const workspacePath = "/workspace";

export type RailwaySpikePreparationWorkspaceProviderOptions = {
  commandTimeoutMs?: number;
  createTimeoutMs?: number;
  gateway: RailwaySandboxGateway;
  pendingCreationDrainTimeoutMs?: number;
  transferMaxBytes?: number;
  transferTimeoutMs?: number;
};

/**
 * Opt-in, fixed-canary Preparation Workspace provider for Railway Sandboxes.
 * It deliberately rejects plans outside its tested canary and is not wired into
 * the production pipeline.
 */
export class RailwaySpikePreparationWorkspaceProvider
  implements PreparationWorkspaceProvider
{
  private readonly commandTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly pendingCreationDrainTimeoutMs: number;
  private readonly transferMaxBytes: number;
  private readonly transferTimeoutMs: number;

  constructor(
    private readonly options: RailwaySpikePreparationWorkspaceProviderOptions,
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
    this.createTimeoutMs = options.createTimeoutMs ?? defaultCreateTimeoutMs;
    this.pendingCreationDrainTimeoutMs =
      options.pendingCreationDrainTimeoutMs ??
      defaultPendingCreationDrainTimeoutMs;
    this.transferMaxBytes = options.transferMaxBytes ?? defaultTransferMaxBytes;
    this.transferTimeoutMs =
      options.transferTimeoutMs ?? defaultTransferTimeoutMs;
  }

  async create(
    options: { signal?: AbortSignal } = {},
  ): Promise<PreparationWorkspaceHandle> {
    const sandboxOptions = {
      env: {},
      idleTimeoutMinutes: fixedIdleTimeoutMinutes,
      networkIsolation: "ISOLATED" as const,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: this.createTimeoutMs,
    };
    const creations = await Promise.allSettled([
      this.options.gateway.createSandbox(sandboxOptions),
      this.options.gateway.createSandbox(sandboxOptions),
    ]);
    const [parentCreation, childCreation] = creations;
    if (parentCreation === undefined || childCreation === undefined) {
      throw new Error(
        "Railway spike sandbox creation results were incomplete.",
      );
    }
    if (
      parentCreation.status === "rejected" ||
      childCreation.status === "rejected"
    ) {
      const creationErrors = creations
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      const createdSandboxes = creations
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<RailwaySandboxGatewaySandbox> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);
      const cleanup = await Promise.allSettled([
        ...createdSandboxes.map((sandbox) =>
          this.options.gateway.destroySandbox(sandbox),
        ),
        drainPendingGatewayCreations(
          this.options.gateway,
          this.pendingCreationDrainTimeoutMs,
        ),
      ]);
      const cleanupErrors = cleanup
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (creationErrors.length === 1 && cleanupErrors.length === 0) {
        throw creationErrors[0];
      }
      if (
        cleanupErrors.length === 0 &&
        creationErrors.length > 0 &&
        creationErrors.every(isAbortError)
      ) {
        throw creationErrors[0];
      }
      throw new AggregateError(
        [...creationErrors, ...cleanupErrors],
        "Railway spike preparation workspace creation failed.",
      );
    }
    const parent = parentCreation.value;
    const child = childCreation.value;

    const workspace = new RailwaySpikePreparationWorkspace({
      child,
      commandTimeoutMs: this.commandTimeoutMs,
      gateway: this.options.gateway,
      parent,
      transferMaxBytes: this.transferMaxBytes,
      transferTimeoutMs: this.transferTimeoutMs,
    });
    let releasePromise: Promise<void> | undefined;
    return {
      id: parent.id,
      release() {
        releasePromise ??= releaseRailwaySpikeWorkspace({
          child,
          gateway: workspace.gateway,
          parent,
          workspace,
        });
        return releasePromise;
      },
      workspace,
    };
  }
}

class RailwaySpikePreparationWorkspace implements PreparationWorkspace {
  readonly activeCommands = new Set<RailwaySandboxGatewayCommand>();
  private readonly activeTransfers = new Set<Promise<void>>();
  private readonly pendingCommandStarts = new Set<Promise<void>>();
  private releasing = false;
  private submittedToolchainLifecycle:
    | { state: "unprovisioned" }
    | { planIdentity: string; state: "provisioned" | "synchronized" } = {
    state: "unprovisioned",
  };

  constructor(
    readonly input: {
      child: RailwaySandboxGatewaySandbox;
      commandTimeoutMs: number;
      gateway: RailwaySandboxGateway;
      parent: RailwaySandboxGatewaySandbox;
      transferMaxBytes: number;
      transferTimeoutMs: number;
    },
  ) {}

  get gateway(): RailwaySandboxGateway {
    return this.input.gateway;
  }

  async execute(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    const trustedCommand =
      command === trustedInspectorCommand
        ? `${fixedCanaryNodeBin} ${trustedInspectorPath}`
        : command;
    return this.executeIn(this.input.parent, trustedCommand, options);
  }

  async executeAgentCommand(
    command: string,
    options: Omit<PreparationWorkspaceExecuteOptions, "env"> = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    return this.executeIn(
      this.input.parent,
      createUnprivilegedRecipeCommand(command, fixedAgentEnvironment()),
      { ...options, env: {} },
    );
  }

  async executeSubmittedCode(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    return this.executeIn(
      this.input.child,
      createUnprivilegedRecipeCommand(
        command,
        trustedSubmittedCodeEnvironment(options.env),
      ),
      {
        ...options,
        env: {},
      },
    );
  }

  async executeSubmittedProject(
    request: SubmittedProjectExecutionRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    this.requireSynchronizedPlan(request.plan);
    this.assertImmutableInstallRequest(request);
    return this.executeIn(
      this.input.child,
      createUnprivilegedRecipeCommand(
        [fixedCanaryNpmBin, ...request.argv].map(shellQuote).join(" "),
        trustedSubmittedCodeEnvironment(options.env),
      ),
      { ...options, env: {} },
    );
  }

  async executeSubmittedRuntime(
    request: SubmittedProjectRuntimeRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    this.requireSynchronizedPlan(request.plan);
    const lifecycle = isPreparedDemoStartWrapper(request.command)
      ? {
          detachAfterFirstStdout: true,
          detachTimeoutMs: defaultRuntimeDetachTimeoutMs,
        }
      : {};
    return this.executeIn(
      this.input.child,
      createUnprivilegedRecipeCommand(
        request.command,
        trustedSubmittedCodeEnvironment(options.env),
      ),
      { ...options, env: {} },
      lifecycle,
    );
  }

  async provisionSubmittedCodeToolchain(
    plan: SubmittedCodeToolchainPlan,
  ): Promise<void> {
    this.assertAcceptingOperations();
    this.assertFixedCanary(plan);
    const planIdentity = fixedCanaryPlanIdentity(plan);
    const existing = this.submittedToolchainLifecycle;
    if (
      existing.state !== "unprovisioned" &&
      existing.planIdentity === planIdentity
    ) {
      return;
    }
    this.submittedToolchainLifecycle = { planIdentity, state: "provisioned" };
  }

  async uploadFiles(
    files: PreparationWorkspaceUploadFile[],
    options: PreparationWorkspaceUploadOptions = {},
  ): Promise<void> {
    this.assertAcceptingOperations();
    await this.uploadTo(this.input.parent, files, options);
  }

  async uploadSubmittedCodeFiles(
    files: PreparationWorkspaceUploadFile[],
  ): Promise<void> {
    this.assertAcceptingOperations();
    await this.uploadTo(this.input.child, files, {});
  }

  async downloadFiles(
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions = {},
  ): Promise<void> {
    this.assertAcceptingOperations();
    await this.downloadFrom(this.input.parent, files, options);
  }

  async downloadSubmittedCodeFiles(
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions = {},
  ): Promise<void> {
    this.assertAcceptingOperations();
    await this.downloadFrom(this.input.child, files, options);
  }

  async syncSubmittedCodeWorkspace(): Promise<void> {
    this.assertAcceptingOperations();
    const lifecycle = this.submittedToolchainLifecycle;
    if (lifecycle.state === "unprovisioned") {
      throw new Error(
        "Railway spike submitted-code workspace synchronization requires a provisioned toolchain.",
      );
    }
    const archive = await mkdtemp(join(tmpdir(), "makeademo-railway-sync-"));
    const localArchive = join(archive, "workspace.tar.gz");
    const remoteArchivePath = createRootOnlySyncArchivePath();
    try {
      const created = await this.executeIn(
        this.input.parent,
        createWorkspaceArchiveCommand(remoteArchivePath),
        {},
      );
      if (created.exitCode !== 0) {
        throw new Error(
          "Railway spike could not archive the prepared workspace.",
        );
      }
      await this.downloadFrom(
        this.input.parent,
        [{ destinationPath: localArchive, sourcePath: remoteArchivePath }],
        { maxBytes: this.input.transferMaxBytes },
      );
      await this.uploadTo(
        this.input.child,
        [{ destinationPath: remoteArchivePath, sourcePath: localArchive }],
        {},
      );
      const extracted = await this.executeIn(
        this.input.child,
        createWorkspaceExtractCommand(remoteArchivePath),
        {},
      );
      if (extracted.exitCode !== 0) {
        throw new Error(
          "Railway spike could not synchronize the submitted-code workspace.",
        );
      }
      this.submittedToolchainLifecycle = {
        ...lifecycle,
        state: "synchronized",
      };
    } finally {
      await Promise.allSettled([
        this.executeIn(
          this.input.parent,
          `rm -f ${shellQuote(remoteArchivePath)}`,
          {},
        ),
        this.executeIn(
          this.input.child,
          `rm -f ${shellQuote(remoteArchivePath)}`,
          {},
        ),
      ]);
      await rm(archive, { force: true, recursive: true });
    }
  }

  async cancelActiveCommands(): Promise<void> {
    const commands = [...this.activeCommands];
    const results = await Promise.allSettled([
      ...commands.map((command) => command.kill()),
      ...commands.map((command) => command.result()),
    ]);
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Railway spike command cancellation failed.",
      );
    }
  }

  private async executeIn(
    sandbox: RailwaySandboxGatewaySandbox,
    command: string,
    options: PreparationWorkspaceExecuteOptions,
    lifecycle: {
      detachAfterFirstStdout?: boolean;
      detachTimeoutMs?: number;
    } = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    this.assertAcceptingOperations();
    let settleStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      settleStart = resolve;
    });
    this.pendingCommandStarts.add(started);
    let active: RailwaySandboxGatewayCommand | undefined;
    try {
      active = await this.input.gateway.execute(sandbox, command, {
        cwd: workspacePath,
        ...lifecycle,
        env: options.env ?? {},
        ...(options.onStderr === undefined
          ? {}
          : { onStderr: options.onStderr }),
        ...(options.onStdout === undefined
          ? {}
          : { onStdout: options.onStdout }),
        timeoutMs: options.timeoutMs ?? this.input.commandTimeoutMs,
      });
      this.activeCommands.add(active);
      settleStart?.();
      const result = await active.result();
      if (result.timedOut || result.truncated) {
        throw new Error(
          `Railway spike command failed closed because provider evidence reported timedOut=${result.timedOut}, truncated=${result.truncated}.`,
        );
      }
      return {
        exitCode: result.exitCode ?? -1,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } finally {
      settleStart?.();
      this.pendingCommandStarts.delete(started);
      if (active !== undefined) this.activeCommands.delete(active);
    }
  }

  beginRelease(): void {
    this.releasing = true;
  }

  async waitForCommandStarts(): Promise<void> {
    await Promise.allSettled([...this.pendingCommandStarts]);
  }

  async waitForTransfers(): Promise<void> {
    await Promise.allSettled([...this.activeTransfers]);
  }

  private assertAcceptingOperations(): void {
    if (this.releasing) {
      throw new Error("Railway spike preparation workspace is releasing.");
    }
  }

  private async uploadTo(
    sandbox: RailwaySandboxGatewaySandbox,
    files: PreparationWorkspaceUploadFile[],
    options: PreparationWorkspaceUploadOptions,
  ): Promise<void> {
    await this.trackTransfer(
      "upload",
      options.timeoutMs,
      options.signal,
      async (signal, deadline) => {
        throwIfAborted(signal);
        for (const file of files) {
          const source = await stat(file.sourcePath);
          assertTransferSize(source.size, this.input.transferMaxBytes);
          throwIfAborted(signal);
          await this.input.gateway.writeFile(
            sandbox,
            file.destinationPath,
            () => readLocalFile(file.sourcePath, signal),
            { timeoutMs: remainingTransferMilliseconds(deadline) },
          );
        }
      },
    );
  }

  private async downloadFrom(
    sandbox: RailwaySandboxGatewaySandbox,
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions,
  ): Promise<void> {
    const stagedFiles = files.map((file) => ({
      ...file,
      temporaryPath: undefined as string | undefined,
    }));
    const removeStagedFiles = async () => {
      await Promise.all(
        stagedFiles.map(async (file) => {
          if (file.temporaryPath !== undefined) {
            await rm(file.temporaryPath, { force: true });
          }
        }),
      );
    };
    await this.trackTransfer(
      "download",
      options.timeoutMs,
      options.signal,
      async (signal, deadline, commit) => {
        const maxBytes = Math.min(
          options.maxBytes ?? this.input.transferMaxBytes,
          this.input.transferMaxBytes,
        );
        try {
          for (const file of stagedFiles) {
            throwIfAborted(signal);
            await mkdir(dirname(file.destinationPath), { recursive: true });
            const stream = await awaitWithAbort(
              this.input.gateway.readFile(sandbox, file.sourcePath, {
                timeoutMs: remainingTransferMilliseconds(deadline),
              }),
              signal,
            );
            throwIfAborted(signal);
            const staged = createExclusiveDownloadSink(file.destinationPath);
            file.temporaryPath = staged.path;
            await pipeline(
              Readable.fromWeb(stream as never),
              createByteLimitTransform(maxBytes, signal),
              staged.sink,
              { signal },
            );
            throwIfAborted(signal);
          }
          await commit(async () => {
            await publishStagedDownloads(
              stagedFiles.map((file) => ({
                destinationPath: file.destinationPath,
                temporaryPath: requireStagedDownloadPath(file.temporaryPath),
              })),
            );
          });
        } catch (error) {
          await removeStagedFiles();
          throw error;
        }
      },
      removeStagedFiles,
    );
  }

  private async trackTransfer(
    kind: "download" | "upload",
    requestedTimeoutMs: number | undefined,
    callerSignal: AbortSignal | undefined,
    operation: (
      signal: AbortSignal,
      deadline: number,
      commit: (operation: () => Promise<void>) => Promise<void>,
    ) => Promise<void>,
    removeTimedOutArtifacts: () => Promise<void> = async () => undefined,
  ): Promise<void> {
    const timeoutMs = requestedTimeoutMs ?? this.input.transferTimeoutMs;
    const controller = new AbortController();
    const signal =
      callerSignal === undefined
        ? controller.signal
        : AbortSignal.any([callerSignal, controller.signal]);
    const deadline = Date.now() + timeoutMs;
    let committing = false;
    const commit = async (commitOperation: () => Promise<void>) => {
      throwIfAborted(signal);
      committing = true;
      try {
        await commitOperation();
      } finally {
        committing = false;
      }
    };
    const transfer = withTransferDeadline(
      operation(signal, deadline, commit),
      timeoutMs,
      () => committing,
      async () => {
        controller.abort();
        await removeTimedOutArtifacts();
      },
      `Railway spike ${kind} timed out.`,
    );
    this.activeTransfers.add(transfer);
    try {
      await transfer;
    } finally {
      this.activeTransfers.delete(transfer);
    }
  }

  private assertFixedCanary(plan: SubmittedCodeToolchainPlan): void {
    if (
      plan.node.version !== fixedCanaryNodeVersion ||
      plan.packageManager?.name !== "npm" ||
      plan.packageManager.version !== fixedCanaryNpmVersion ||
      plan.projectRoot !== "."
    ) {
      throw new Error(
        `Railway spike supports only the fixed Node ${fixedCanaryNodeVersion} / npm ${fixedCanaryNpmVersion} canary at the repository root.`,
      );
    }
  }

  private requireSynchronizedPlan(plan: SubmittedCodeToolchainPlan): void {
    this.assertFixedCanary(plan);
    const lifecycle = this.submittedToolchainLifecycle;
    if (lifecycle.state === "unprovisioned") {
      throw new Error(
        "Railway spike fixed canary toolchain has not been provisioned.",
      );
    }
    if (lifecycle.planIdentity !== fixedCanaryPlanIdentity(plan)) {
      throw new Error(
        "Railway spike submitted project plan is not the exact provisioned canary plan.",
      );
    }
    if (lifecycle.state !== "synchronized") {
      throw new Error(
        "Railway spike submitted project execution requires synchronization after provisioning.",
      );
    }
  }

  private assertImmutableInstallRequest(
    request: SubmittedProjectExecutionRequest,
  ): void {
    const install = request.plan.install;
    if (install === undefined) {
      throw new Error(
        "Railway spike plan declares no immutable install request for this fixture.",
      );
    }
    if (
      request.executable !== install.executable ||
      JSON.stringify(request.argv) !== JSON.stringify(install.argv)
    ) {
      throw new Error(
        "Railway spike submitted project request is not the plan-owned immutable install.",
      );
    }
  }
}

async function publishStagedDownloads(
  files: Array<{
    destinationPath: string;
    temporaryPath: string;
  }>,
): Promise<void> {
  const publications = files.map((file) => ({
    ...file,
    backupPath: undefined as string | undefined,
    published: false,
  }));
  try {
    for (const publication of publications) {
      const existing = await lstatIfPresent(publication.destinationPath);
      if (existing !== undefined && !existing.isDirectory()) {
        const backup = reserveExclusiveSiblingFile(
          publication.destinationPath,
          "backup",
        );
        closeSync(backup.descriptor);
        publication.backupPath = backup.path;
        try {
          await rename(publication.destinationPath, publication.backupPath);
        } catch (error) {
          unlinkSync(publication.backupPath);
          publication.backupPath = undefined;
          throw error;
        }
      }
      await rename(publication.temporaryPath, publication.destinationPath);
      publication.published = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const publication of [...publications].reverse()) {
      try {
        if (publication.published) {
          await rm(publication.destinationPath, { force: true });
        }
        if (publication.backupPath !== undefined) {
          await rename(publication.backupPath, publication.destinationPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Railway spike download publication rollback failed.",
      );
    }
    throw error;
  }
  await Promise.all(
    publications.map(async (publication) => {
      if (publication.backupPath !== undefined) {
        await rm(publication.backupPath, { force: true });
      }
    }),
  );
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function fixedCanaryPlanIdentity(plan: SubmittedCodeToolchainPlan): string {
  return JSON.stringify(plan);
}

function isPreparedDemoStartWrapper(command: string): boolean {
  return (
    command.includes("nohup ") &&
    command.includes("/tmp/makeademo-demo.exit-code") &&
    command.includes("/tmp/makeademo-demo.log") &&
    command.includes("/tmp/makeademo-demo.pid") &&
    command.includes("echo $!")
  );
}

async function drainPendingGatewayCreations(
  gateway: RailwaySandboxGateway,
  timeoutMs: number,
): Promise<void> {
  await gateway.drainPendingCreations?.({ timeoutMs });
}

function trustedSubmittedCodeEnvironment(
  environment: Record<string, string> | undefined,
): Record<string, string> {
  assertNoTrustedEnvironmentOverrides(environment);
  return {
    ...environment,
    ...fixedAgentEnvironment(),
    MAKEADEMO_PLAYWRIGHT_MODULE_ROOT: fixedCanaryPlaywrightModuleRoot,
    PLAYWRIGHT_BROWSERS_PATH: fixedCanaryPlaywrightBrowsersPath,
  };
}

function fixedAgentEnvironment(): Record<string, string> {
  return {
    HOME: fixedCanaryUserHome,
    PATH: fixedCanaryNodeBinPath,
    TMPDIR: fixedCanaryUserTmp,
  };
}

function assertNoTrustedEnvironmentOverrides(
  environment: Record<string, string> | undefined,
): void {
  for (const key of [
    "HOME",
    "MAKEADEMO_PLAYWRIGHT_MODULE_ROOT",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
    "TMPDIR",
  ]) {
    if (environment?.[key] !== undefined) {
      throw new Error(
        `Railway spike callers cannot override trusted environment variable ${key}.`,
      );
    }
  }
}

function createUnprivilegedRecipeCommand(
  command: string,
  environment: Record<string, string>,
): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const environmentArguments = Object.entries(environment)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `printf %s ${shellQuote(encoded)} | base64 --decode | runuser -u ${shellQuote(fixedCanaryUser)} -- env -i ${environmentArguments} /bin/bash --noprofile --norc`;
}

async function releaseRailwaySpikeWorkspace(input: {
  child: RailwaySandboxGatewaySandbox;
  gateway: RailwaySandboxGateway;
  parent: RailwaySandboxGatewaySandbox;
  workspace: RailwaySpikePreparationWorkspace;
}): Promise<void> {
  const errors: unknown[] = [];
  input.workspace.beginRelease();
  try {
    await input.workspace.waitForTransfers();
    await input.workspace.waitForCommandStarts();
    await input.workspace.cancelActiveCommands();
  } catch (error) {
    errors.push(error);
  }
  const results = await Promise.allSettled([
    input.gateway.destroySandbox(input.child),
    input.gateway.destroySandbox(input.parent),
  ]);
  errors.push(
    ...results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason),
  );
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Railway spike preparation workspace release failed.",
    );
  }
}

async function* readLocalFile(
  path: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
  }
}

function createExclusiveDownloadSink(destinationPath: string) {
  const staging = reserveExclusiveSiblingFile(destinationPath, "staging");
  try {
    return {
      path: staging.path,
      sink: createWriteStream(staging.path, {
        autoClose: true,
        fd: staging.descriptor,
      }),
    };
  } catch (error) {
    closeSync(staging.descriptor);
    unlinkSync(staging.path);
    throw error;
  }
}

function reserveExclusiveSiblingFile(
  destinationPath: string,
  purpose: "backup" | "staging",
): { descriptor: number; path: string } {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(
      dirname(destinationPath),
      `.makeademo-railway-${purpose}-${randomBytes(16).toString("hex")}`,
    );
    try {
      return { descriptor: openSync(path, "wx", 0o600), path };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    }
  }
  throw new Error(`Railway spike could not reserve a ${purpose} file.`);
}

function requireStagedDownloadPath(path: string | undefined): string {
  if (path === undefined) {
    throw new Error("Railway spike download did not create its staging file.");
  }
  return path;
}

function createByteLimitTransform(
  maxBytes: number,
  signal: AbortSignal | undefined,
): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        throwIfAborted(signal);
        received += chunk.byteLength;
        assertTransferSize(received, maxBytes);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

function assertTransferSize(size: number, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || size > maxBytes) {
    throw new Error(
      `Railway spike transfer exceeds its ${maxBytes}-byte limit.`,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new DOMException("The transfer was aborted.", "AbortError");
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      result();
    };
    const abort = () => {
      settle(() =>
        reject(new DOMException("The transfer was aborted.", "AbortError")),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function remainingTransferMilliseconds(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function withTransferDeadline(
  operation: Promise<void>,
  timeoutMs: number,
  isCommitting: () => boolean,
  onTimeout: () => Promise<void>,
  message: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timingOut = false;
    const timer = setTimeout(
      () => {
        if (isCommitting()) return;
        timingOut = true;
        void onTimeout().then(
          () => reject(new Error(message)),
          (cleanupError: unknown) =>
            reject(new Error(message, { cause: cleanupError })),
        );
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    operation.then(
      () => {
        if (timingOut) return;
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        if (timingOut) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createWorkspaceArchiveCommand(archivePath: string): string {
  return [
    "tar",
    "--exclude='./.git'",
    "--exclude='./.makeademo'",
    "--exclude='./node_modules'",
    "--exclude='./.cache'",
    "--exclude='./.vite'",
    "--exclude='./.turbo'",
    "--exclude='./.npm'",
    "--exclude='./.pnpm-store'",
    "--exclude='./.yarn/cache'",
    "--exclude='./.next/cache'",
    "--exclude='./.bun'",
    `-czf ${shellQuote(archivePath)}`,
    `-C ${workspacePath}`,
    ".",
  ].join(" ");
}

function createWorkspaceExtractCommand(archivePath: string): string {
  return [
    `find ${shellQuote(workspacePath)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
    `tar --no-same-owner --no-same-permissions -xzf ${shellQuote(archivePath)} -C ${shellQuote(workspacePath)}`,
  ].join(" && ");
}

function createRootOnlySyncArchivePath(): string {
  return `/root/.makeademo-railway-sync-${randomBytes(16).toString("hex")}.tar.gz`;
}
