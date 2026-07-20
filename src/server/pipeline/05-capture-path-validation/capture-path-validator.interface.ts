import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type {
  DemoScriptCandidate,
  DemoScriptPackage,
} from "../04-script-generation/demo-script-package";
import type { NetworkAttempt } from "./project-runtime-preflight/network-isolation-policy";

export type CapturePathValidationInput = {
  preparationManifest: PreparationManifest;
  preparationWorkspace: PreparationWorkspaceHandle;
  demoScriptCandidate: DemoScriptCandidate;
  demoScriptPackage: DemoScriptPackage;
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
