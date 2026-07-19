import type { AgentSession } from "../../agent-harness/agent-session";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScriptCandidate } from "./demo-script-package";
import type { ScriptGenerationInput } from "./script-generation-orchestrator";

export type AgenticScriptGenerationInput = ScriptGenerationInput & {
  agentSession: AgentSession;
  preparationWorkspace: PreparationWorkspaceHandle;
};

/**
 * Generates a Demo Script candidate inside a prepared workspace.
 * Implementations should resume the provided preparation agent session and
 * write only Script Generation artifacts; Capture Path Validation decides later
 * whether the candidate is accepted for Footage Capture.
 */
export interface ScriptGenerationAgent {
  generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<DemoScriptCandidate>;
}
