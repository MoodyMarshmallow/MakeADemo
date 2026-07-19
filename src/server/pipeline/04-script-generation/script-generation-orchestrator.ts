import type { AgentSession } from "../../agent-harness/agent-session";
import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { ProjectValidationResult } from "../05-capture-path-validation/project-runtime-preflight/validation-result";
import { assertDemoScriptCaptureSdkContract } from "../06-footage-capture/capture-sdk-contract";
import type { DemoPlanner } from "./demo-planning/demo-planner.interface";
import {
  type DemoScriptCandidate,
  buildDemoScriptPackage,
} from "./demo-script-package";
import type { ProjectExplorer } from "./project-exploration/project-explorer.interface";
import type { ScriptComposer } from "./script-composition/script-composer.interface";
import type { ScriptGenerationAgent } from "./script-generation-agent.interface";
import { assertCaptureReadyScriptQuality } from "./script-package-quality";

export type ScriptGenerationInput = {
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  agentSession?: AgentSession;
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
  repoUrl: string;
  validation?: ProjectValidationResult;
};

export type ScriptGenerationDependencies = {
  demoPlanner: DemoPlanner;
  projectExplorer: ProjectExplorer;
  scriptGenerationAgent?: ScriptGenerationAgent;
  scriptComposer: ScriptComposer;
};

export async function generateDemoScriptPackage(
  input: ScriptGenerationInput,
  dependencies: ScriptGenerationDependencies,
): Promise<DemoScriptCandidate> {
  if (dependencies.scriptGenerationAgent !== undefined) {
    if (
      input.preparationWorkspace === undefined ||
      input.agentSession === undefined
    ) {
      throw new Error(
        "Agentic Script Generation requires the validated preparation workspace and retained agent session ID.",
      );
    }

    return dependencies.scriptGenerationAgent.generateScriptPackage({
      ...input,
      agentSession: input.agentSession,
      preparationWorkspace: input.preparationWorkspace,
    });
  }

  const exploration = await dependencies.projectExplorer.exploreProject(input);
  const demoPlan = await dependencies.demoPlanner.planDemo({
    demoBrief: input.demoBrief,
    exploration,
  });
  const demoScript = await dependencies.scriptComposer.composeScript({
    demoBrief: input.demoBrief,
    demoPlan,
    exploration,
  });
  assertDemoScriptCaptureSdkContract(demoScript);
  assertCaptureReadyScriptQuality(demoScript);

  return buildDemoScriptPackage({
    demoPlan,
    demoScript,
    exploration,
  });
}
