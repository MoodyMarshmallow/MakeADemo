import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScript } from "../04-script-generation/demo-script/demo-script.schema";
import type { NetworkAttempt } from "./demo-runtime-preflight/network-isolation-policy";

export type CapturePathValidationInput = {
  preparationManifest: PreparationManifest;
  preparationWorkspace: PreparationWorkspaceHandle;
  demoScript: DemoScript;
};

export type CapturePathValidationResult = {
  blockedNetworkAttempts: NetworkAttempt[];
  browserUrl?: string;
  diagnosticsLogPath?: string;
  errorMessage?: string;
  failedAction?: string;
  failedSceneId?: string;
  failureReason?: string;
  logs: string[];
  runDirectory?: string;
  screenshotArtifactId?: string;
  scriptPath?: string;
  status: "failed" | "succeeded";
  stderrPath?: string;
  stdoutPath?: string;
  warnings: string[];
};
