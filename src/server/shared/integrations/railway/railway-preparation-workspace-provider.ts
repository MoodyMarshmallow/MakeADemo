import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { satisfies as semverSatisfies } from "semver";

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
import { railwayProductionTemplateRecipe } from "./railway-production-template-recipe";
import type {
  RailwaySandboxGateway,
  RailwaySandboxGatewayCommand,
  RailwaySandboxGatewaySandbox,
} from "./railway-sandbox-gateway.interface";

const workspacePath = "/workspace";
const agentUser = "makeademo";
const agentHome = "/home/makeademo";
const agentTemp = "/tmp/makeademo";
const captureRuntimeBin = "/opt/makeademo/capture-runtime/bin";
const capturePlaywrightModules =
  "/opt/makeademo/playwright-runtime/node_modules";
const captureBrowsers = "/ms-playwright";
const defaultCommandTimeoutMs = 10 * 60_000;
const defaultCreateTimeoutMs = 630_000;
const defaultTransferTimeoutMs = 10 * 60_000;
// Full pipeline transfers include raw scene footage and compositing evidence.
const defaultTransferMaxBytes = 2 * 1024 * 1024 * 1024;
const defaultIdleTimeoutMinutes = 15;
const defaultRuntimeDetachTimeoutMs = 5_000;
const trustedNodeBinDirectory =
  railwayProductionTemplateRecipe.runtimePaths.nodeBin.slice(
    0,
    -"/node".length,
  );
const trustedCommandPath = `${trustedNodeBinDirectory}:/usr/local/bin:/usr/bin:/bin`;

export type RailwayPreparationWorkspaceProviderOptions = {
  commandTimeoutMs?: number;
  createTimeoutMs?: number;
  gateway: RailwaySandboxGateway;
  transferMaxBytes?: number;
  transferTimeoutMs?: number;
};

/**
 * Full-pipeline Railway implementation of the Preparation Workspace seam.
 * It creates a primary agent workspace plus a separate submitted-code child,
 * leaves secrets at the backend boundary, and destroys only exact run-owned
 * sandbox identities during release.
 */
export class RailwayPreparationWorkspaceProvider
  implements PreparationWorkspaceProvider
{
  private readonly commandTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly transferMaxBytes: number;
  private readonly transferTimeoutMs: number;

  constructor(
    private readonly options: RailwayPreparationWorkspaceProviderOptions,
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
    this.createTimeoutMs = options.createTimeoutMs ?? defaultCreateTimeoutMs;
    this.transferMaxBytes = options.transferMaxBytes ?? defaultTransferMaxBytes;
    this.transferTimeoutMs =
      options.transferTimeoutMs ?? defaultTransferTimeoutMs;
  }

  async create(
    options: { signal?: AbortSignal } = {},
  ): Promise<PreparationWorkspaceHandle> {
    const createOptions = {
      env: {},
      idleTimeoutMinutes: defaultIdleTimeoutMinutes,
      networkIsolation: "ISOLATED" as const,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: this.createTimeoutMs,
    };
    const created = await Promise.allSettled([
      this.options.gateway.createSandbox(createOptions),
      this.options.gateway.createSandbox(createOptions),
    ]);
    const fulfilled = created.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const rejected = created.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (rejected.length > 0) {
      const cleanup = await Promise.allSettled([
        ...fulfilled.map((sandbox) =>
          this.options.gateway.destroySandbox(sandbox),
        ),
        this.options.gateway.drainPendingCreations?.({
          timeoutMs: this.createTimeoutMs,
        }),
      ]);
      const cleanupErrors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (rejected.length === 1 && cleanupErrors.length === 0)
        throw rejected[0];
      throw new AggregateError(
        [...rejected, ...cleanupErrors],
        "Railway preparation workspace creation failed.",
      );
    }
    const parent = fulfilled[0];
    const child = fulfilled[1];
    if (parent === undefined || child === undefined) {
      throw new Error("Railway preparation workspace creation was incomplete.");
    }
    const workspace = new RailwayPreparationWorkspace({
      child,
      commandTimeoutMs: this.commandTimeoutMs,
      gateway: this.options.gateway,
      parent,
      transferMaxBytes: this.transferMaxBytes,
      transferTimeoutMs: this.transferTimeoutMs,
    });
    let release: Promise<void> | undefined;
    return {
      id: parent.id,
      release() {
        release ??= releaseWorkspace({
          child,
          gateway: workspace.gateway,
          parent,
          workspace,
        });
        return release;
      },
      workspace,
    };
  }
}

type ProvisionedToolchain = {
  artifactIdentity: string;
  manager: NonNullable<SubmittedCodeToolchainPlan["packageManager"]>;
  nodeBinDirectory: string;
  packageManagerBinDirectory: string;
  planIdentity: string;
  projectDirectory: string;
  projectIntegrity: { expected: string; filename: string };
};

class RailwayPreparationWorkspace implements PreparationWorkspace {
  readonly activeCommands = new Set<RailwaySandboxGatewayCommand>();
  private readonly activeTransfers = new Set<Promise<void>>();
  private readonly pendingStarts = new Set<Promise<void>>();
  private installedPlanIdentity: string | undefined;
  private releasing = false;
  private lifecycle:
    | { state: "unprovisioned" }
    | { state: "provisioned" | "synchronized"; toolchain: ProvisionedToolchain }
    | { state: "failed" } = { state: "unprovisioned" };

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
    return this.executeIn(this.input.parent, command, {
      ...options,
      env: { ...options.env, PATH: trustedCommandPath },
    });
  }

  async executeAgentCommand(
    command: string,
    options: Omit<PreparationWorkspaceExecuteOptions, "env"> = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    return this.executeIn(
      this.input.parent,
      unprivilegedCommand(command, agentEnvironment()),
      { ...options, env: {} },
    );
  }

  async executeRepositoryCommand(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    return this.executeIn(
      this.input.parent,
      unprivilegedCommand(command, agentEnvironment()),
      { ...options, env: {} },
    );
  }

  async prepareForAgent(): Promise<void> {
    this.assertAcceptingOperations();
    const result = await this.executeIn(
      this.input.parent,
      [
        `install -d -o ${shellQuote(agentUser)} -g ${shellQuote(agentUser)} -m 0750 ${shellQuote(agentHome)} ${shellQuote(agentTemp)} ${shellQuote("/workspace/.makeademo")}`,
        `find ${shellQuote(workspacePath)} -xdev -exec chown --no-dereference ${shellQuote(`${agentUser}:${agentUser}`)} {} +`,
        // The agent gets exactly the submitted workspace; image runtime roots
        // remain root-owned and non-writable even if image defaults change.
        `for path in ${shellQuote("/opt/makeademo")} ${shellQuote("/ms-playwright")} ${shellQuote("/usr/local/bin")}; do if test -e "$path"; then chown -R root:root "$path" && chmod -R a-w "$path"; fi; done`,
        "chmod 0755 /tmp /var/tmp",
      ].join(" && "),
      {},
    );
    if (result.exitCode !== 0) {
      throw new Error(
        "Railway could not hand the prepared workspace to the agent user.",
      );
    }
  }

  async writeSandboxLog(entry: PreparationWorkspaceLogEntry): Promise<void> {
    this.assertAcceptingOperations();
    const line = JSON.stringify(sanitizeLogEntry(entry));
    const result = await this.executeIn(
      this.input.parent,
      [
        `install -d -o root -g root -m 0750 ${shellQuote("/opt/makeademo/artifacts")}`,
        `install -d -o ${shellQuote(agentUser)} -g ${shellQuote(agentUser)} -m 0750 ${shellQuote("/workspace/.makeademo")}`,
        `printf '%s\\n' ${shellQuote(line)} >> ${shellQuote("/opt/makeademo/artifacts/sandbox-audit.jsonl")}`,
        `printf '%s\\n' ${shellQuote(line)} >> ${shellQuote("/workspace/.makeademo/sandbox-audit.jsonl")}`,
      ].join(" && "),
      { timeoutMs: Math.min(this.input.commandTimeoutMs, 5_000) },
    );
    if (result.exitCode !== 0) {
      throw new Error("Railway sandbox audit log write failed.");
    }
  }

  async executeSubmittedCode(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    const environment = this.currentSubmittedEnvironment(options.env);
    return this.executeIn(
      this.input.child,
      unprivilegedCommand(command, environment),
      { ...options, env: {} },
    );
  }

  async provisionSubmittedCodeToolchain(
    plan: SubmittedCodeToolchainPlan,
  ): Promise<void> {
    this.assertAcceptingOperations();
    const toolchain = readProvisionedToolchain(plan);
    const existing = this.lifecycle;
    if (existing.state === "failed") {
      throw new Error(
        "Railway submitted-code provisioning failed; use a fresh child sandbox.",
      );
    }
    if (existing.state !== "unprovisioned") {
      if (existing.toolchain.planIdentity === toolchain.planIdentity) return;
      if (existing.toolchain.artifactIdentity !== toolchain.artifactIdentity) {
        throw new Error(
          "Railway submitted-code child is bound to a different exact runtime; use a fresh child sandbox.",
        );
      }
      this.installedPlanIdentity = undefined;
      this.lifecycle = { state: "provisioned", toolchain };
      return;
    }
    try {
      const result = await this.executeIn(
        this.input.child,
        createToolchainProvisionCommand(toolchain, plan.node.version),
        { env: {}, timeoutMs: this.input.commandTimeoutMs },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          "Railway trusted submitted-code toolchain provisioning failed.",
        );
      }
    } catch (error) {
      this.lifecycle = { state: "failed" };
      throw error;
    }
    this.lifecycle = { state: "provisioned", toolchain };
  }

  async syncSubmittedCodeWorkspace(): Promise<void> {
    this.assertAcceptingOperations();
    const lifecycle = this.requireProvisioned();
    const localDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-railway-full-sync-"),
    );
    const localArchive = join(localDirectory, "workspace.tgz");
    const remoteArchive = `/opt/makeademo/artifacts/sync-${randomBytes(16).toString("hex")}.tgz`;
    try {
      const archive = await this.executeIn(
        this.input.parent,
        createWorkspaceArchiveCommand(remoteArchive),
        {},
      );
      if (archive.exitCode !== 0)
        throw new Error("Railway could not archive the prepared workspace.");
      await this.downloadFrom(
        this.input.parent,
        [{ destinationPath: localArchive, sourcePath: remoteArchive }],
        {},
      );
      await this.uploadTo(
        this.input.child,
        [{ destinationPath: remoteArchive, sourcePath: localArchive }],
        {},
      );
      const extract = await this.executeIn(
        this.input.child,
        createWorkspaceExtractCommand(
          remoteArchive,
          this.installedPlanIdentity === lifecycle.toolchain.planIdentity,
        ),
        {},
      );
      if (extract.exitCode !== 0)
        throw new Error(
          "Railway could not synchronize the submitted-code workspace.",
        );
      const integrity = await this.executeIn(
        this.input.child,
        createLockfileIntegrityCommand(lifecycle.toolchain),
        {},
      );
      if (integrity.exitCode !== 0) {
        throw new Error(
          "Railway submitted project lockfile integrity did not match the provisioned plan.",
        );
      }
      this.lifecycle = {
        state: "synchronized",
        toolchain: lifecycle.toolchain,
      };
    } finally {
      await Promise.allSettled([
        this.executeIn(
          this.input.parent,
          `rm -f ${shellQuote(remoteArchive)}`,
          {},
        ),
        this.executeIn(
          this.input.child,
          `rm -f ${shellQuote(remoteArchive)}`,
          {},
        ),
        rm(localDirectory, { force: true, recursive: true }),
      ]);
    }
  }

  async executeSubmittedProject(
    request: SubmittedProjectExecutionRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    const toolchain = this.requireSynchronized(request.plan);
    const expected = request.plan.install;
    if (
      expected === undefined ||
      request.executable !== expected.executable ||
      !sameArgv(request.argv, expected.argv)
    ) {
      throw new Error(
        "Railway submitted project execution is not the plan-owned immutable install.",
      );
    }
    const environment = this.currentSubmittedEnvironment(
      options.env,
      request.installProfile === "bounded"
        ? createBoundedInstallEnvironment(request.plan)
        : undefined,
      toolchain,
    );
    this.installedPlanIdentity = undefined;
    const result = await this.executeIn(
      this.input.child,
      unprivilegedCommand(
        `cd ${shellQuote(toolchain.projectDirectory)} && ${[request.executable, ...request.argv].map(shellQuote).join(" ")}`,
        environment,
      ),
      { ...options, env: {} },
    );
    if (result.exitCode === 0) {
      this.installedPlanIdentity = toolchain.planIdentity;
    }
    return result;
  }

  async executeSubmittedRuntime(
    request: SubmittedProjectRuntimeRequest,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    const toolchain = this.requireSynchronized(request.plan);
    const lifecycle = isPreparedDemoStartWrapper(request.command)
      ? {
          detachAfterFirstStdout: true,
          detachTimeoutMs: defaultRuntimeDetachTimeoutMs,
        }
      : {};
    return this.executeIn(
      this.input.child,
      unprivilegedCommand(
        `cd ${shellQuote(toolchain.projectDirectory)} && ${request.command}`,
        this.currentSubmittedEnvironment(undefined, undefined, toolchain),
      ),
      { ...options, env: {} },
      lifecycle,
    );
  }

  async uploadFiles(
    files: PreparationWorkspaceUploadFile[],
    options: PreparationWorkspaceUploadOptions = {},
  ): Promise<void> {
    await this.uploadTo(this.input.parent, files, options);
  }

  async uploadSubmittedCodeFiles(
    files: PreparationWorkspaceUploadFile[],
  ): Promise<void> {
    await this.uploadTo(this.input.child, files, {});
  }

  async downloadFiles(
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions = {},
  ): Promise<void> {
    await this.downloadFrom(this.input.parent, files, options);
  }

  async downloadSubmittedCodeFiles(
    files: PreparationWorkspaceDownloadFile[],
    options: PreparationWorkspaceDownloadOptions = {},
  ): Promise<void> {
    await this.downloadFrom(this.input.child, files, options);
  }

  async cancelActiveCommands(): Promise<void> {
    const commands = [...this.activeCommands];
    const result = await Promise.allSettled([
      ...commands.map((command) => command.kill()),
      ...commands.map((command) => command.result()),
    ]);
    const failures = result.flatMap((entry) =>
      entry.status === "rejected" ? [entry.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Railway command cancellation failed.",
      );
    }
  }

  beginRelease(): void {
    this.releasing = true;
  }

  async waitForTransfers(): Promise<void> {
    await Promise.allSettled([...this.activeTransfers]);
  }

  async waitForCommandStarts(): Promise<void> {
    await Promise.allSettled([...this.pendingStarts]);
  }

  private requireProvisioned(): {
    state: "provisioned" | "synchronized";
    toolchain: ProvisionedToolchain;
  } {
    if (this.lifecycle.state === "failed") {
      throw new Error(
        "Railway submitted-code provisioning failed; use a fresh child sandbox.",
      );
    }
    if (this.lifecycle.state === "unprovisioned") {
      throw new Error(
        "Railway submitted-code workspace synchronization requires a provisioned toolchain.",
      );
    }
    return this.lifecycle;
  }

  private requireSynchronized(
    plan: SubmittedCodeToolchainPlan,
  ): ProvisionedToolchain {
    const lifecycle = this.requireProvisioned();
    const requested = readProvisionedToolchain(plan);
    if (lifecycle.toolchain.planIdentity !== requested.planIdentity) {
      throw new Error(
        "Railway submitted-code execution plan is not the exact provisioned plan.",
      );
    }
    if (lifecycle.state !== "synchronized") {
      throw new Error(
        "Railway submitted-code execution requires synchronization after provisioning.",
      );
    }
    return lifecycle.toolchain;
  }

  private currentSubmittedEnvironment(
    requested: Record<string, string> | undefined,
    backendOwned: Record<string, string> | undefined = undefined,
    toolchain: ProvisionedToolchain | undefined = this.lifecycle.state ===
      "unprovisioned" || this.lifecycle.state === "failed"
      ? undefined
      : this.lifecycle.toolchain,
  ): Record<string, string> {
    const safeRequested = allowSubmittedEnvironment(requested);
    return {
      ...safeRequested,
      ...backendOwned,
      HOME: agentHome,
      MAKEADEMO_PLAYWRIGHT_MODULE_ROOT: capturePlaywrightModules,
      PATH: [
        ...(toolchain === undefined
          ? [captureRuntimeBin]
          : [
              toolchain.packageManagerBinDirectory,
              toolchain.nodeBinDirectory,
              captureRuntimeBin,
            ]),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].join(":"),
      PLAYWRIGHT_BROWSERS_PATH: captureBrowsers,
      TMPDIR: agentTemp,
    };
  }

  private async uploadTo(
    sandbox: RailwaySandboxGatewaySandbox,
    files: PreparationWorkspaceUploadFile[],
    options: PreparationWorkspaceUploadOptions,
  ): Promise<void> {
    this.assertAcceptingOperations();
    await this.trackTransfer(
      options.timeoutMs,
      options.signal,
      async (signal, deadline) => {
        for (const file of files) {
          throwIfAborted(signal);
          const source = await stat(file.sourcePath);
          assertTransferSize(source.size, this.input.transferMaxBytes);
          const directory = await this.executeIn(
            sandbox,
            `mkdir -p ${shellQuote(dirname(file.destinationPath))}`,
            { timeoutMs: remaining(deadline) },
          );
          if (directory.exitCode !== 0)
            throw new Error(
              "Railway could not create the upload destination directory.",
            );
          await withAbort(
            this.input.gateway.writeFile(
              sandbox,
              file.destinationPath,
              () => localFileStream(file.sourcePath, signal),
              { timeoutMs: remaining(deadline) },
            ),
            signal,
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
    this.assertAcceptingOperations();
    await this.trackTransfer(
      options.timeoutMs,
      options.signal,
      async (signal, deadline) => {
        const limit = Math.min(
          options.maxBytes ?? this.input.transferMaxBytes,
          this.input.transferMaxBytes,
        );
        for (const file of files) {
          throwIfAborted(signal);
          await mkdir(dirname(file.destinationPath), { recursive: true });
          const temporary = `${file.destinationPath}.makeademo-railway-${randomBytes(16).toString("hex")}`;
          try {
            const source = await withAbort(
              this.input.gateway.readFile(sandbox, file.sourcePath, {
                timeoutMs: remaining(deadline),
              }),
              signal,
            );
            await pipeline(
              Readable.fromWeb(source as never),
              byteLimitTransform(limit, signal),
              createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
              { signal },
            );
            await rm(file.destinationPath, { force: true });
            await rename(temporary, file.destinationPath);
          } finally {
            await rm(temporary, { force: true });
          }
        }
      },
    );
  }

  private async trackTransfer(
    timeoutMs: number | undefined,
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal, deadline: number) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const signal =
      callerSignal === undefined
        ? controller.signal
        : AbortSignal.any([callerSignal, controller.signal]);
    const duration = timeoutMs ?? this.input.transferTimeoutMs;
    const promise = withDeadline(
      operation(signal, Date.now() + duration),
      duration,
      "Railway file transfer timed out.",
      () => controller.abort(),
    );
    this.activeTransfers.add(promise);
    try {
      await promise;
    } finally {
      this.activeTransfers.delete(promise);
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
    let start!: () => void;
    const pending = new Promise<void>((resolve) => {
      start = resolve;
    });
    this.pendingStarts.add(pending);
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
      start();
      const result = await active.result();
      if (result.timedOut || result.truncated) {
        throw new Error(
          "Railway command failed closed because provider output was timed out or truncated.",
        );
      }
      return {
        exitCode: result.exitCode ?? -1,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } finally {
      start();
      this.pendingStarts.delete(pending);
      if (active !== undefined) this.activeCommands.delete(active);
    }
  }

  private assertAcceptingOperations(): void {
    if (this.releasing)
      throw new Error("Railway preparation workspace is releasing.");
  }
}

async function releaseWorkspace(input: {
  child: RailwaySandboxGatewaySandbox;
  gateway: RailwaySandboxGateway;
  parent: RailwaySandboxGatewaySandbox;
  workspace: RailwayPreparationWorkspace;
}): Promise<void> {
  input.workspace.beginRelease();
  const settled: PromiseSettledResult<void>[] = [];
  for (const operation of [
    () => input.workspace.waitForTransfers(),
    () => input.workspace.waitForCommandStarts(),
    () => input.workspace.cancelActiveCommands(),
  ]) {
    settled.push(...(await Promise.allSettled([operation()])));
  }
  const destruction = await Promise.allSettled([
    input.gateway.destroySandbox(input.child),
    input.gateway.destroySandbox(input.parent),
  ]);
  const errors = [...settled, ...destruction].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Railway preparation workspace release failed.",
    );
  }
}

function readProvisionedToolchain(
  plan: SubmittedCodeToolchainPlan,
): ProvisionedToolchain {
  const manager = plan.packageManager;
  if (
    manager === undefined ||
    plan.install === undefined ||
    plan.catalogRevision !== submittedCodeToolchainCatalog.revision ||
    !isSupportedNode(plan) ||
    !isSupportedManager(manager) ||
    !isPlanOwnedInstall(plan)
  ) {
    throw new Error(
      "Railway submitted toolchain plan has no supported catalog install capability.",
    );
  }
  const projectDirectory = resolveSubmittedProjectCwd(plan.projectRoot);
  const lockfile = plan.evidence.filter(
    (entry) => entry.kind === "lockfile" && entry.value === manager.name,
  );
  if (
    manager.projectIntegrity === undefined ||
    !/^sha256:[a-f0-9]{64}$/.test(manager.projectIntegrity) ||
    lockfile.length !== 1 ||
    lockfile[0]?.source === undefined ||
    !/^[A-Za-z0-9._-]+$/.test(lockfile[0].source)
  ) {
    throw new Error(
      "Railway submitted toolchain plan has no canonical lockfile integrity requirement.",
    );
  }
  const planIdentity = JSON.stringify({
    catalogRevision: plan.catalogRevision,
    install: plan.install,
    node: plan.node.version,
    packageManager: manager,
    projectRoot: plan.projectRoot,
  });
  const artifactIdentity = JSON.stringify({
    generation: manager.generation,
    nodeVersion: plan.node.version,
    packageManager: manager.name,
    upstreamIntegrity: manager.corepackHash ?? null,
    version: manager.version,
  });
  const root = `/opt/makeademo/submitted-toolchains/${createHash("sha256").update(artifactIdentity).digest("hex").slice(0, 32)}`;
  return {
    artifactIdentity,
    manager,
    nodeBinDirectory: `${root}/node/bin`,
    packageManagerBinDirectory: `${root}/manager/bin`,
    planIdentity,
    projectDirectory,
    projectIntegrity: {
      expected: manager.projectIntegrity,
      filename: lockfile[0].source,
    },
  };
}

function isSupportedNode(plan: SubmittedCodeToolchainPlan): boolean {
  const entry = submittedCodeToolchainCatalog.node[plan.node.family];
  return (
    entry !== undefined &&
    entry.lifecycle === plan.node.lifecycle &&
    semverSatisfies(
      plan.node.version,
      `>=${entry.compatibilityMinimum} <${plan.node.family + 1}`,
      { loose: false },
    )
  );
}

function isSupportedManager(
  manager: NonNullable<SubmittedCodeToolchainPlan["packageManager"]>,
): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(manager.version)) return false;
  const generation =
    manager.name === "bun"
      ? "bun-1"
      : manager.name === "npm"
        ? "npm-modern"
        : manager.name === "pnpm"
          ? "pnpm-modern"
          : manager.version.startsWith("1.")
            ? "yarn-classic"
            : "yarn-berry";
  if (manager.generation !== generation) return false;
  const exactVersions: readonly string[] =
    manager.name === "yarn"
      ? submittedCodeToolchainCatalog.yarnSafeDefaults[
          manager.generation === "yarn-classic" ? "yarn-classic" : "yarn-berry"
        ]
      : submittedCodeToolchainCatalog.packageManagerSafeDefaults[manager.name];
  return exactVersions.includes(manager.version);
}

function isPlanOwnedInstall(plan: SubmittedCodeToolchainPlan): boolean {
  const manager = plan.packageManager;
  if (manager === undefined || plan.install === undefined) return false;
  const expected =
    manager.name === "npm"
      ? ["ci", "--maxsockets=4"]
      : manager.name === "pnpm"
        ? [
            "install",
            "--frozen-lockfile",
            "--child-concurrency=2",
            "--network-concurrency=4",
          ]
        : manager.name === "bun"
          ? ["install", "--frozen-lockfile"]
          : manager.generation === "yarn-classic"
            ? ["install", "--frozen-lockfile", "--network-concurrency", "4"]
            : ["install", "--immutable"];
  return (
    plan.install.executable === manager.name &&
    sameArgv(plan.install.argv, expected)
  );
}

function createToolchainProvisionCommand(
  toolchain: ProvisionedToolchain,
  nodeVersion: string,
): string {
  const { manager } = toolchain;
  const root = toolchain.nodeBinDirectory.slice(0, -"/node/bin".length);
  const nodeDirectory = `${root}/node`;
  const managerDirectory = `${root}/manager`;
  const architecture =
    '$(case "$(dpkg --print-architecture)" in amd64) printf x64 ;; arm64) printf arm64 ;; *) exit 64 ;; esac)';
  const exactNodePath = '"$node_dir/bin:/usr/local/bin:/usr/bin:/bin"';
  const managerInstall =
    manager.name === "bun"
      ? [
          `test ${shellQuote(manager.version)} = '1.2.22' || { echo 'unsupported trusted capture Bun version' >&2; exit 65; }`,
          `install -o root -g root -m 0555 ${shellQuote(`${captureRuntimeBin}/bun`)} ${shellQuote(`${managerDirectory}/bin/bun`)}`,
        ]
      : [
          `PATH=${exactNodePath} "$node_dir/bin/node" "$node_dir/lib/node_modules/npm/bin/npm-cli.js" install --global --prefix ${shellQuote(managerDirectory)} --ignore-scripts --no-audit --no-fund ${shellQuote(`${manager.name}@${manager.version}`)}`,
          `test "$(PATH=${exactNodePath} ${shellQuote(`${managerDirectory}/bin/${manager.name}`)} --version)" = ${shellQuote(manager.version)}`,
        ];
  return [
    "set -eu",
    `root=${shellQuote(root)}`,
    `node_dir=${shellQuote(nodeDirectory)}`,
    `manager_dir=${shellQuote(managerDirectory)}`,
    `version=${shellQuote(nodeVersion)}`,
    `architecture=${architecture}`,
    'archive="node-v${version}-linux-${architecture}.tar.xz"',
    'distribution="https://nodejs.org/dist/v${version}"',
    'if ! test -x "$node_dir/bin/node"; then workdir=$(mktemp -d); trap "rm -rf \\"$workdir\\"" EXIT; mkdir -p "$root"; curl --fail --silent --show-error --location --proto "=https" --tlsv1.2 "$distribution/SHASUMS256.txt" -o "$workdir/SHASUMS256.txt"; curl --fail --silent --show-error --location --proto "=https" --tlsv1.2 "$distribution/$archive" -o "$workdir/$archive"; (cd "$workdir" && grep -F "  $archive" SHASUMS256.txt | sha256sum --check -); tar -xJf "$workdir/$archive" -C "$workdir"; mv "$workdir/node-v${version}-linux-${architecture}" "$node_dir"; fi',
    'test "$("$node_dir/bin/node" --version)" = "v$version"',
    'mkdir -p "$manager_dir/bin"',
    ...managerInstall,
    'chown -R root:root "$root"',
    'chmod -R a-w "$root"',
    `chmod a+x ${shellQuote(`${managerDirectory}/bin/${manager.name}`)}`,
  ].join(" && ");
}

function createLockfileIntegrityCommand(
  toolchain: ProvisionedToolchain,
): string {
  const expected = toolchain.projectIntegrity.expected.slice("sha256:".length);
  return [
    "set -eu",
    ": MAKEADEMO_VERIFY_SUBMITTED_LOCKFILE",
    `cd ${shellQuote(toolchain.projectDirectory)}`,
    `printf '%s  %s\\n' ${shellQuote(expected)} ${shellQuote(toolchain.projectIntegrity.filename)} | sha256sum --check --status`,
  ].join(" && ");
}

function createWorkspaceArchiveCommand(destination: string): string {
  return [
    `install -d -o root -g root -m 0750 ${shellQuote(dirname(destination))}`,
    `tar --exclude='./.git' --exclude='./.makeademo' --exclude='./node_modules' --exclude='./.npm' --exclude='./.pnpm-store' --exclude='./.yarn/cache' --exclude='./.cache' --exclude='./.next/cache' --exclude='./.vite' --exclude='./.turbo' -czf ${shellQuote(destination)} -C ${shellQuote(workspacePath)} .`,
  ].join(" && ");
}

function createWorkspaceExtractCommand(
  archive: string,
  preserveInstalledDependencies: boolean,
): string {
  const staging = `${archive}.workspace`;
  return [
    "set -eu",
    `staging=${shellQuote(staging)}`,
    "trap 'rm -rf -- \"$staging\"' EXIT",
    'rm -rf -- "$staging"',
    'install -d -o root -g root -m 0700 "$staging"',
    `tar --no-same-owner --no-same-permissions -xzf ${shellQuote(archive)} -C "$staging"`,
    ...(preserveInstalledDependencies
      ? [
          ": MAKEADEMO_PRESERVE_INSTALLED_DEPENDENCIES",
          `workspace=${shellQuote(workspacePath)}`,
          'preserve_dependency_path() { source=$1; relative=${source#"$workspace/"}; destination="$staging/$relative"; if ! test -e "$destination" && ! test -L "$destination"; then mkdir -p -- "$(dirname -- "$destination")"; mv -- "$source" "$destination"; fi; }',
          "find \"$workspace\" -xdev \\( -type d \\( -name node_modules -o -path '*/.yarn/cache' -o -path '*/.yarn/unplugged' \\) -prune -print0 -o -type f \\( -name .pnp.cjs -o -name .pnp.loader.mjs -o -path '*/.yarn/install-state.gz' \\) -print0 \\) | while IFS= read -r -d '' dependency; do preserve_dependency_path \"$dependency\"; done",
        ]
      : []),
    `find ${shellQuote(workspacePath)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
    `find "$staging" -mindepth 1 -maxdepth 1 -exec mv -t ${shellQuote(workspacePath)} -- {} +`,
    `chown -R ${shellQuote(`${agentUser}:${agentUser}`)} ${shellQuote(workspacePath)}`,
  ].join(" && ");
}

function unprivilegedCommand(
  command: string,
  environment: Record<string, string>,
): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const assignments = Object.entries(environment)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `printf %s ${shellQuote(encoded)} | base64 --decode | runuser -u ${shellQuote(agentUser)} -- env -i ${assignments} /bin/bash --noprofile --norc`;
}

function agentEnvironment(): Record<string, string> {
  return {
    HOME: agentHome,
    PATH: `${captureRuntimeBin}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: agentTemp,
  };
}

function allowSubmittedEnvironment(
  environment: Record<string, string> | undefined,
): Record<string, string> {
  if (environment === undefined) return {};
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      !isApprovedSubmittedRuntimeEnvironmentKey(key) ||
      value.length > 8 * 1024
    ) {
      throw new Error(
        `Railway submitted-code environment variable is not allowlisted: ${key}.`,
      );
    }
    allowed[key] = value;
  }
  return allowed;
}

function sanitizeLogEntry(
  entry: PreparationWorkspaceLogEntry,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      sanitizeLogValue(key, value),
    ]),
  );
}

function sanitizeLogValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (/token|secret|api[_-]?key|authorization|password/i.test(key))
      return "[redacted]";
    return value.slice(0, 16 * 1024);
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizeLogValue(key, item));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeLogValue(nestedKey, nestedValue),
      ]),
    );
  return value;
}

function isPreparedDemoStartWrapper(command: string): boolean {
  return (
    command.includes("nohup ") &&
    command.includes("/tmp/makeademo-demo.pid") &&
    command.includes("echo $!")
  );
}

function sameArgv(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function* localFileStream(
  path: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
  }
}

function byteLimitTransform(limit: number, signal: AbortSignal): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      try {
        throwIfAborted(signal);
        total += chunk.byteLength;
        assertTransferSize(total, limit);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

function assertTransferSize(size: number, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0 || size > limit) {
    throw new Error(`Railway transfer exceeds its ${limit}-byte limit.`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("The transfer was aborted.", "AbortError");
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new DOMException("The transfer was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        onTimeout();
        reject(new Error(message));
      },
      Math.max(1, timeoutMs),
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
