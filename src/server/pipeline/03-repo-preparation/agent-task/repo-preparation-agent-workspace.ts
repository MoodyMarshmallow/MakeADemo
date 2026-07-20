import type { AgentSessionWorkspace } from "../../../agent-harness/agent-session-runner.interface";
import type {
  PreparationWorkspace,
  PreparationWorkspaceExecuteOptions,
} from "../preparation-workspace.interface";

type RepoPreparationAgentWorkspace = AgentSessionWorkspace & {
  baseWorkspace: PreparationWorkspace;
};

const agentWorkspaces = new WeakMap<
  PreparationWorkspace,
  RepoPreparationAgentWorkspace
>();

/**
 * Returns the retained unprivileged agent view of a prepared repo. Every
 * agentic Pipeline stage must use this view so retained Pi sessions keep one
 * coding-tool binding while backend work continues through the trusted
 * PreparationWorkspace. Authorization does not depend on shell-text filtering.
 */
export function createRepoPreparationAgentWorkspace(
  workspace: PreparationWorkspace,
): RepoPreparationAgentWorkspace {
  const retained = agentWorkspaces.get(workspace);
  if (retained !== undefined) return retained;

  const agentWorkspace: RepoPreparationAgentWorkspace = {
    // Exposed only for provider-neutral test doubles that associate scripted
    // turns with the provider workspace identity.
    baseWorkspace: workspace,
    cancelActiveCommands: workspace.cancelActiveCommands?.bind(workspace),
    async execute(command, options) {
      if (workspace.executeAgentCommand === undefined) {
        throw new Error(
          "Repo Preparation workspace does not provide unprivileged agent command execution.",
        );
      }
      const executeOptions: PreparationWorkspaceExecuteOptions = {
        ...(options.onStderr === undefined
          ? {}
          : { onStderr: options.onStderr }),
        ...(options.onStdout === undefined
          ? {}
          : { onStdout: options.onStdout }),
        timeoutMs: options.timeoutMs,
      };
      return workspace.executeAgentCommand(command, executeOptions);
    },
    writeSandboxLog: workspace.writeSandboxLog?.bind(workspace),
  };
  agentWorkspaces.set(workspace, agentWorkspace);
  return agentWorkspace;
}
