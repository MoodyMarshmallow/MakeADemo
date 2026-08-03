import type {
  MakeADemoCaptureExecutionRequest,
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceExecuteOptions,
} from "./preparation-workspace.interface";

/** Executes compiled capture JavaScript through the MakeADemo-owned runtime. */
export async function executeMakeADemoCapture(
  workspace: PreparationWorkspace,
  request: MakeADemoCaptureExecutionRequest,
  options: Omit<PreparationWorkspaceExecuteOptions, "env" | "timeoutMs"> = {},
): Promise<PreparationWorkspaceCommandResult> {
  if (workspace.executeMakeADemoCapture === undefined) {
    throw new Error(
      "Preparation workspace cannot execute MakeADemo capture programs.",
    );
  }

  return await workspace.executeMakeADemoCapture(request, options);
}
