import type { AgentSession } from "../../agent-harness/agent-session";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScript } from "./demo-script/demo-script.schema";
import type { ScriptGenerationInput } from "./script-generation-orchestrator";

export type AgenticScriptGenerationInput = ScriptGenerationInput & {
  agentSession: AgentSession;
  preparationWorkspace: PreparationWorkspaceHandle;
};

/**
 * Generates a Demo Script inside a prepared workspace.
 * Implementations should resume the provided preparation agent session and
 * write only Script Generation artifacts; Capture Path Validation decides later
 * whether the script is accepted for Footage Capture.
 */
export interface ScriptGenerationAgent {
  generateDemoScript(input: AgenticScriptGenerationInput): Promise<DemoScript>;
}
