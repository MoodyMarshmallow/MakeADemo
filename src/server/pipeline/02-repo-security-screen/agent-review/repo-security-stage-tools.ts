import type { AgentToolDefinition } from "../../../agent-harness/agent-session-runner.interface";
import { createReadOnlyExecCommandTool } from "../../../agent-harness/tools/exec-command/read-only-exec-command";
import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";

/** Binds Stage 02's sole agent tool to the unapproved parent workspace. */
export function createRepoSecurityStageTools(
  workspace: PreparationWorkspace,
): readonly AgentToolDefinition[] {
  return [
    createReadOnlyExecCommandTool({
      async execute(request, options) {
        if (workspace.executeReadOnlyCommand === undefined) {
          throw new Error(
            "Repo Security read-only command execution is unavailable.",
          );
        }
        return workspace.executeReadOnlyCommand(request, options);
      },
    }),
  ];
}
