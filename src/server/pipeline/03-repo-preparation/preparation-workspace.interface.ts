import type { PreparationWorkspaceResourceDiagnostics } from "./preparation-workspace-resource-diagnostics";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

export type { PreparationWorkspaceResourceDiagnostics } from "./preparation-workspace-resource-diagnostics";

export type PreparationWorkspaceCommandResult = {
  exitCode: number;
  resourceDiagnostics?: PreparationWorkspaceResourceDiagnostics;
  stderr: string;
  stdout: string;
};

export type PreparationWorkspaceUploadFile = {
  destinationPath: string;
  sourcePath: string;
};

export type PreparationWorkspaceUploadOptions = {
  /** Cancels an in-flight upload and must be observed by implementations. */
  signal?: AbortSignal;
  /** Optional provider fail-safe timeout in milliseconds. */
  timeoutMs?: number;
};

export type PreparationWorkspaceDownloadFile = {
  destinationPath: string;
  sourcePath: string;
};

export type PreparationWorkspaceDownloadOptions = {
  /** Rejects the transfer before writing more than this many bytes locally. */
  maxBytes?: number;
  /** Cancels an in-flight download and must be observed by implementations. */
  signal?: AbortSignal;
  /** Optional provider fail-safe timeout in milliseconds. */
  timeoutMs?: number;
};

export type PreparationWorkspaceExecuteOptions = {
  env?: Record<string, string>;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /** Optional per-command provider fail-safe timeout in milliseconds. */
  timeoutMs?: number;
};

/** Structured sandbox audit entry; level overrides legacy event-name inference. */
export type PreparationWorkspaceLogEntry = Record<string, unknown> & {
  level?: "debug" | "error" | "info" | "warn";
};

/**
 * A project-owned command paired with its resolved toolchain plan.
 * Implementations must ignore repository-provided executable paths and map the
 * plan only to catalog-owned PATH entries and the validated project cwd.
 */
export type SubmittedProjectExecutionRequest = {
  /** Catalog-owned executable; never copied from submitted metadata or agent input. */
  executable: string;
  /** Catalog-owned argv; implementations must preserve argument boundaries. */
  argv: readonly string[];
  /** Backend-owned execution policy; callers cannot supply arbitrary install environment. */
  installProfile?: "bounded";
  plan: SubmittedCodeToolchainPlan;
};

/** A backend-validated demo runtime command paired with its catalog plan. */
export type SubmittedProjectRuntimeRequest = {
  /** Complete backend wrapper command; provider implementations must shell-quote it. */
  command: string;
  plan: SubmittedCodeToolchainPlan;
};

/**
 * A provider-owned request to stop the submitted demo runtime.
 * Implementations must accept only a validated local TCP port and a bounded
 * timeout; callers cannot supply process identities, commands, environments,
 * or submitted toolchain authority.
 */
export type SubmittedRuntimeQuiescenceRequest = {
  port: number;
  timeoutMs: number;
};

/**
 * One compiled MakeADemo-owned capture program and its evidence paths.
 * Implementations must execute only `scriptPath` with MakeADemo's fixed,
 * absolute capture Node binary. They must not accept a submitted toolchain
 * plan, caller environment, package-manager executable, or arbitrary command.
 */
export type MakeADemoCaptureExecutionRequest = {
  runDirectory: string;
  scriptPath: string;
  stderrPath: string;
  stdoutPath: string;
  timeoutMs: number;
};

/**
 * Executes commands inside a Repo Preparation workspace.
 * Implementations must scope destructive work to the ephemeral workspace copy and
 * must not expose agent-only secrets to submitted app build or runtime commands.
 */
export interface PreparationWorkspace {
  /**
   * Terminates active primary and submitted-code commands and waits for their
   * provider command handles to settle before returning.
   */
  cancelActiveCommands?(): Promise<void>;
  downloadFiles?(
    files: PreparationWorkspaceDownloadFile[],
    options?: PreparationWorkspaceDownloadOptions,
  ): Promise<void>;
  execute(
    command: string,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Executes provider-owned repository clone and Git inventory commands as the
   * unprivileged owner of `/workspace`. Implementations must scrub inherited
   * environment variables. Repository-loading callers must fail closed when
   * this boundary is unavailable and never fall back to `execute`.
   */
  executeRepositoryCommand?(
    command: string,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Executes an agent-authored shell command as the image's unprivileged
   * workspace user. Implementations must keep the trusted root filesystem and
   * helper binaries non-writable, expose no backend environment, and make only
   * `/workspace` persistent writable state available to the command.
   */
  executeAgentCommand?(
    command: string,
    options?: Omit<PreparationWorkspaceExecuteOptions, "env">,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Executes compiled Capture Path Validation or Footage Capture JavaScript in
   * submitted-code isolation through MakeADemo's fixed capture runtime. The
   * implementation owns the runtime path, trusted Playwright bindings,
   * environment, timeout wrapper, and evidence collection; submitted project
   * toolchains must not influence any of them.
   */
  executeMakeADemoCapture?(
    request: MakeADemoCaptureExecutionRequest,
    options?: Omit<PreparationWorkspaceExecuteOptions, "env" | "timeoutMs">,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Executes submitted repo code inside the submitted-code runtime boundary.
   * Implementations must not run these commands in the agent workspace and must
   * apply the submitted-code environment before execution.
   */
  executeSubmittedCode?(
    command: string,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Executes the backend-resolved immutable dependency install.
   * Implementations must reject argv that differs from the plan-owned install.
   */
  executeSubmittedProject?(
    request: SubmittedProjectExecutionRequest,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Starts a backend-validated project runtime with the selected catalog Node.
   * Implementations must preserve /workspace cwd and reject a tampered plan.
   */
  executeSubmittedRuntime?(
    request: SubmittedProjectRuntimeRequest,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Stops the retained submitted runtime process group, waits for it to exit,
   * and verifies the requested local port is free before workspace mutation.
   */
  quiesceSubmittedRuntime?(
    request: SubmittedRuntimeQuiescenceRequest,
  ): Promise<void>;
  /** Returns a provider-hosted public URL for a local port when supported. */
  getPreviewUrl?(port: number): Promise<string | undefined>;
  /**
   * Transfers the cloned repository tree to the unprivileged agent user
   * without dereferencing submitted symlinks. Must run before agent tools.
   */
  prepareForAgent?(): Promise<void>;
  /**
   * Acquires and verifies the exact resolved runtime before submitted repo
   * files are copied into the runtime sandbox. Implementations must privately
   * bind that plan and reject execution until provisioning and sync complete.
   */
  provisionSubmittedCodeToolchain?(
    plan: SubmittedCodeToolchainPlan,
  ): Promise<void>;
  /**
   * Emits structured audit logs inside the sandbox. Implementations must keep a
   * durable copy available from workspace storage and may additionally relay the
   * entry through provider-specific process logs when that route is available.
   */
  writeSandboxLog?(entry: PreparationWorkspaceLogEntry): Promise<void>;
  /**
   * Replaces the submitted-code workspace contents with the prepared parent
   * workspace snapshot before validation or capture commands run. Implementations
   * must include hidden and untracked prepared files while excluding VCS metadata
   * and dependency caches so submitted-code execution starts from source state.
   */
  syncSubmittedCodeWorkspace?(): Promise<void>;
  uploadFiles(
    files: PreparationWorkspaceUploadFile[],
    options?: PreparationWorkspaceUploadOptions,
  ): Promise<void>;
  /**
   * Uploads files only to the submitted-code runtime boundary when one exists.
   * Implementations must not mirror these files into the agent workspace.
   */
  uploadSubmittedCodeFiles?(
    files: PreparationWorkspaceUploadFile[],
  ): Promise<void>;
  /** Downloads artifacts from the submitted-code runtime boundary. */
  downloadSubmittedCodeFiles?(
    files: PreparationWorkspaceDownloadFile[],
    options?: PreparationWorkspaceDownloadOptions,
  ): Promise<void>;
}
