import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceExecuteOptions,
  SubmittedProjectExecutionRequest,
  SubmittedProjectRuntimeRequest,
} from "./preparation-workspace.interface";
import type { SubmittedCodeToolchainArtifactReceipt } from "./submitted-code-toolchain-artifact.interface";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

/**
 * Raised when MakeADemo cannot copy the prepared workspace into the
 * submitted-code runtime boundary. Callers must treat this as infrastructure
 * failure metadata and must not ask the preparation agent to repair app code.
 */
export class SubmittedCodeWorkspaceSyncError extends Error {
  readonly failureKind = "submitted-code-workspace-sync-failed" as const;

  constructor(cause: unknown) {
    super(readSubmittedCodeSyncFailureMessage(cause), {
      cause,
    });
    this.name = "SubmittedCodeWorkspaceSyncError";
  }
}

function readSubmittedCodeSyncFailureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }

  return "Failed to sync prepared files to submitted-code workspace.";
}

export async function executeSubmittedCode(
  workspace: PreparationWorkspace,
  command: string,
  options: PreparationWorkspaceExecuteOptions = {},
): Promise<PreparationWorkspaceCommandResult> {
  if (workspace.executeSubmittedCode === undefined) {
    throw new Error("Preparation workspace cannot execute submitted code.");
  }

  return await workspace.executeSubmittedCode(command, options);
}

/** Runs a project-owned command with the already resolved catalog plan. */
export async function executeSubmittedProject(
  workspace: PreparationWorkspace,
  request: SubmittedProjectExecutionRequest,
  options: PreparationWorkspaceExecuteOptions = {},
): Promise<PreparationWorkspaceCommandResult> {
  if (workspace.executeSubmittedProject === undefined) {
    throw new Error("Preparation workspace cannot execute submitted projects.");
  }

  return await workspace.executeSubmittedProject(request, options);
}

/** Starts a backend-validated runtime using the already resolved catalog plan. */
export async function executeSubmittedRuntime(
  workspace: PreparationWorkspace,
  request: SubmittedProjectRuntimeRequest,
  options: PreparationWorkspaceExecuteOptions = {},
): Promise<PreparationWorkspaceCommandResult> {
  if (workspace.executeSubmittedRuntime === undefined) {
    throw new Error("Preparation workspace cannot execute submitted runtimes.");
  }

  return await workspace.executeSubmittedRuntime(request, options);
}

/** Hydrates an integrity-attested package-manager artifact before execution. */
export async function provisionSubmittedCodeToolchain(
  workspace: PreparationWorkspace,
  plan: SubmittedCodeToolchainPlan,
): Promise<SubmittedCodeToolchainArtifactReceipt> {
  if (workspace.provisionSubmittedCodeToolchain === undefined) {
    throw new Error(
      "Preparation workspace cannot provision submitted-code toolchains.",
    );
  }
  return await workspace.provisionSubmittedCodeToolchain(plan);
}

export async function syncSubmittedCodeWorkspace(
  workspace: PreparationWorkspace,
): Promise<void> {
  if (workspace.syncSubmittedCodeWorkspace === undefined) {
    throw new Error(
      "Preparation workspace cannot sync prepared files to submitted code.",
    );
  }

  try {
    await workspace.syncSubmittedCodeWorkspace();
  } catch (error) {
    throw new SubmittedCodeWorkspaceSyncError(error);
  }
}
