import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "./preparation-workspace.interface";
import { executeSubmittedProject } from "./submitted-code-execution";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

export type PlannedDependencyInstallInput = {
  toolchainPlan: SubmittedCodeToolchainPlan;
  workspace: PreparationWorkspace;
};

const commonBoundedInstallEnvironment = {
  CHILD_CONCURRENCY: "2",
  CI: "true",
  CMAKE_BUILD_PARALLEL_LEVEL: "2",
  HUSKY: "0",
  MAKEFLAGS: "-j2",
  TURBO_CONCURRENCY: "2",
} as const;

/** Returns manager-generation controls owned by the submitted install plan. */
export function createBoundedInstallEnvironment(
  plan: SubmittedCodeToolchainPlan,
): Record<string, string> {
  const manager = plan.packageManager;
  if (manager?.generation === "yarn-berry") {
    return {
      ...commonBoundedInstallEnvironment,
      YARN_NETWORK_CONCURRENCY: "4",
      ...(manager.version.startsWith("4.")
        ? { YARN_TASK_POOL_CONCURRENCY: "2" }
        : {}),
    };
  }
  return commonBoundedInstallEnvironment;
}

/** Runs a backend-resolved, plan-owned dependency install. */
export async function runPlannedDependencyInstall(
  input: PlannedDependencyInstallInput,
): Promise<PreparationWorkspaceCommandResult> {
  const install = input.toolchainPlan.install;
  if (install === undefined) {
    const blocker = input.toolchainPlan.installBlocker;
    throw new Error(
      `Submitted code toolchain cannot install dependencies (${blocker?.code ?? "missing_immutable_install"}): ${blocker?.reason ?? "No catalog-owned immutable install is available."}`,
    );
  }
  return executeSubmittedProject(input.workspace, {
    argv: install.argv,
    executable: install.executable,
    installProfile: "bounded",
    plan: input.toolchainPlan,
  });
}
