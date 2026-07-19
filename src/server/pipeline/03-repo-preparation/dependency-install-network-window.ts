import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "./preparation-workspace.interface";
import {
  executeSubmittedProject,
  setSubmittedCodeNetworkAccess,
} from "./submitted-code-execution";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

export type PlannedDependencyInstallNetworkWindowInput = {
  toolchainPlan: SubmittedCodeToolchainPlan;
  workspace: PreparationWorkspace;
};

/** Raised when submitted-code outbound network access cannot be proven closed. */
export class SubmittedCodeNetworkResealError extends Error {
  constructor(cause: unknown) {
    super("Submitted-code network access could not be resealed.", { cause });
    this.name = "SubmittedCodeNetworkResealError";
  }
}

/**
 * Runs a backend-resolved, plan-owned dependency install with temporary network
 * access. The workspace implementation maps the immutable plan to catalog-owned
 * runtimes and must reject any executable or argv mismatch.
 */
export async function runPlannedDependencyInstallWithNetworkWindow(
  input: PlannedDependencyInstallNetworkWindowInput,
): Promise<PreparationWorkspaceCommandResult> {
  const install = input.toolchainPlan.install;
  if (install === undefined) {
    const blocker = input.toolchainPlan.installBlocker;
    throw new Error(
      `Submitted code toolchain cannot install dependencies (${blocker?.code ?? "missing_immutable_install"}): ${blocker?.reason ?? "No catalog-owned immutable install is available."}`,
    );
  }

  writeSandboxLogBestEffort(input.workspace, {
    argv: install.argv,
    event: "submitted-code-network.opening",
    executable: install.executable,
    reason: "dependency-install",
  });
  let executionError: unknown;
  let result: PreparationWorkspaceCommandResult | undefined;
  let resealError: SubmittedCodeNetworkResealError | undefined;
  try {
    await setSubmittedCodeNetworkAccess(input.workspace, true);
    writeSandboxLogBestEffort(input.workspace, {
      argv: install.argv,
      event: "submitted-code-network.opened",
      executable: install.executable,
      reason: "dependency-install",
    });
    result = await executeSubmittedProject(input.workspace, {
      argv: install.argv,
      executable: install.executable,
      plan: input.toolchainPlan,
    });
  } catch (error) {
    executionError = error;
  } finally {
    writeSandboxLogBestEffort(input.workspace, {
      argv: install.argv,
      event: "submitted-code-network.closing",
      executable: install.executable,
      reason: "dependency-install",
    });
    try {
      await setSubmittedCodeNetworkAccess(input.workspace, false);
    } catch (firstFailure) {
      try {
        await setSubmittedCodeNetworkAccess(input.workspace, false);
      } catch {
        resealError = new SubmittedCodeNetworkResealError(firstFailure);
      }
    }
    if (resealError === undefined) {
      writeSandboxLogBestEffort(input.workspace, {
        argv: install.argv,
        event: "submitted-code-network.closed",
        executable: install.executable,
        reason: "dependency-install",
      });
    } else {
      writeSandboxLogBestEffort(input.workspace, {
        argv: install.argv,
        event: "submitted-code-network.reseal-failed",
        executable: install.executable,
        level: "error",
        reason: "dependency-install",
        resealAttempts: 2,
      });
    }
  }
  if (resealError !== undefined) throw resealError;
  if (executionError !== undefined) throw executionError;
  if (result === undefined) {
    throw new Error(
      "Planned dependency installation did not produce a result.",
    );
  }
  return result;
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
