import type { AgentSession } from "../../agent-harness/agent-session";
import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import { generateDefaultDemoScript } from "./default-demo-script-generator";
import { assertCaptureReadyScriptQuality } from "./demo-script-quality";
import { assertDemoScriptCaptureSdkContract } from "./demo-script/capture-sdk-contract";
import type { DemoScript } from "./demo-script/demo-script.schema";
import type { ScriptGenerationAgent } from "./script-generation-agent.interface";

export type ScriptGenerationInput = {
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  agentSession?: AgentSession;
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
  repoUrl: string;
};

export type ScriptGenerationDependencies = {
  scriptGenerationAgent?: ScriptGenerationAgent;
};

export async function generateDemoScript(
  input: ScriptGenerationInput,
  dependencies: ScriptGenerationDependencies,
): Promise<DemoScript> {
  if (dependencies.scriptGenerationAgent !== undefined) {
    if (
      input.preparationWorkspace === undefined ||
      input.agentSession === undefined
    ) {
      throw new Error(
        "Agentic Script Generation requires the validated preparation workspace and retained agent session ID.",
      );
    }

    return dependencies.scriptGenerationAgent.generateDemoScript({
      ...input,
      agentSession: input.agentSession,
      preparationWorkspace: input.preparationWorkspace,
    });
  }

  const demoScript = generateDefaultDemoScript(input);
  assertDemoScriptCaptureSdkContract(demoScript);
  assertCaptureReadyScriptQuality(demoScript);

  return demoScript;
}
