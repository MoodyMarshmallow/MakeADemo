import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspaceResourceDiagnostics } from "../03-repo-preparation/preparation-workspace.interface";
import type { DemoScript } from "../04-script-generation/demo-script/demo-script.schema";
import type { NetworkAttempt } from "./demo-runtime-preflight/network-isolation-policy";
import type { DemoRuntimePreflightFailureKind } from "./demo-runtime-preflight/validation-result";

/**
 * Stable machine-readable Capture Path Validation failures. Infrastructure
 * kinds must be surfaced unchanged so the Pipeline can avoid asking an agent
 * to repair a MakeADemo-owned runtime failure; app/script kinds remain
 * repairable by the Capture Path agent.
 */
export type CapturePathValidationFailureKind =
  | DemoRuntimePreflightFailureKind
  | "demo-script-type-validation-failed";

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
  failureKind?: CapturePathValidationFailureKind;
  failedAction?: string;
  failedSceneId?: string;
  failureReason?: string;
  logs: string[];
  resourceDiagnostics?: PreparationWorkspaceResourceDiagnostics;
  runDirectory?: string;
  screenshotArtifactId?: string;
  scriptPath?: string;
  status: "failed" | "succeeded";
  stderrPath?: string;
  stdoutPath?: string;
  warnings: string[];
};
