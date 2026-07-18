import {
  type DependencyNetworkDecision,
  evaluateDependencyNetworkRequest,
} from "./dependency-network-gate";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "./preparation-workspace.interface";
import {
  executeSubmittedCode,
  executeSubmittedProject,
  setSubmittedCodeNetworkAccess,
} from "./submitted-code-execution";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

export type DependencyInstallNetworkWindowInput = {
  command: string;
  workspace: PreparationWorkspace;
};

export async function runDependencyInstallWithNetworkWindow(
  input: DependencyInstallNetworkWindowInput,
): Promise<PreparationWorkspaceCommandResult> {
  const decision = evaluateDependencyNetworkRequest({
    command: input.command,
    reason: "dependency-install",
  });
  assertNetworkAllowed(decision);

  writeSandboxLogBestEffort(input.workspace, {
    command: input.command,
    event: "submitted-code-network.opening",
    reason: "dependency-install",
  });
  await setSubmittedCodeNetworkAccess(input.workspace, true);
  try {
    writeSandboxLogBestEffort(input.workspace, {
      command: input.command,
      event: "submitted-code-network.opened",
      reason: "dependency-install",
    });
    return await executeSubmittedCode(input.workspace, input.command);
  } finally {
    writeSandboxLogBestEffort(input.workspace, {
      command: input.command,
      event: "submitted-code-network.closing",
      reason: "dependency-install",
    });
    await setSubmittedCodeNetworkAccess(input.workspace, false);
    writeSandboxLogBestEffort(input.workspace, {
      command: input.command,
      event: "submitted-code-network.closed",
      reason: "dependency-install",
    });
  }
}

export type PlannedDependencyInstallNetworkWindowInput = {
  toolchainPlan: SubmittedCodeToolchainPlan;
  workspace: PreparationWorkspace;
};

/**
 * Runs a backend-resolved, plan-owned dependency install with temporary network
 * access. The workspace implementation maps the immutable plan to catalog-owned
 * runtimes and must reject any executable or argv mismatch.
 */
export async function runPlannedDependencyInstallWithNetworkWindow(
  input: PlannedDependencyInstallNetworkWindowInput,
): Promise<PreparationWorkspaceCommandResult> {
  const install = input.toolchainPlan.install;

  writeSandboxLogBestEffort(input.workspace, {
    argv: install.argv,
    event: "submitted-code-network.opening",
    executable: install.executable,
    reason: "dependency-install",
  });
  await setSubmittedCodeNetworkAccess(input.workspace, true);
  try {
    writeSandboxLogBestEffort(input.workspace, {
      argv: install.argv,
      event: "submitted-code-network.opened",
      executable: install.executable,
      reason: "dependency-install",
    });
    return await executeSubmittedProject(input.workspace, {
      argv: install.argv,
      executable: install.executable,
      plan: input.toolchainPlan,
    });
  } finally {
    writeSandboxLogBestEffort(input.workspace, {
      argv: install.argv,
      event: "submitted-code-network.closing",
      executable: install.executable,
      reason: "dependency-install",
    });
    await setSubmittedCodeNetworkAccess(input.workspace, false);
    writeSandboxLogBestEffort(input.workspace, {
      argv: install.argv,
      event: "submitted-code-network.closed",
      executable: install.executable,
      reason: "dependency-install",
    });
  }
}

function writeSandboxLogBestEffort(
  workspace: PreparationWorkspace,
  entry: Record<string, unknown>,
): void {
  try {
    void workspace.writeSandboxLog?.(entry)?.catch(() => {
      // Sandbox audit logging is best-effort for this network window; never let
      // log transport failures gate product flow or network resealing.
    });
  } catch {
    // Sandbox audit logging is best-effort for this network window; never let
    // log transport failures gate product flow or network resealing.
  }
}

function assertNetworkAllowed(
  decision: DependencyNetworkDecision,
): asserts decision is { status: "allowed" } {
  if (decision.status === "denied") {
    throw new Error(decision.reason);
  }
}
