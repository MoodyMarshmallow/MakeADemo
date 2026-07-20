import type { AgentSession } from "../../agent-harness/agent-session";
import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScript } from "../04-script-generation/demo-script/demo-script.schema";
import type { CapturePathValidationResult } from "./capture-path-validator.interface";

export type CapturePathRepairInput = {
  attempt: number;
  failure: CapturePathValidationResult;
  agentSession?: AgentSession;
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
  repoUrl: string;
  demoScript: DemoScript;
};

export type CapturePathRepairResult = {
  preparationManifest: PreparationManifest;
  demoScript: DemoScript;
};

/**
 * Repairs a prepared workspace, Demo Script, or both after Capture Path
 * Validation fails. Implementations may use the existing agent session, but the
 * returned artifacts remain untrusted until full Capture Path Validation reruns.
 */
export interface CapturePathRepairer {
  repairCapturePathFailure(
    input: CapturePathRepairInput,
  ): Promise<CapturePathRepairResult>;
}
