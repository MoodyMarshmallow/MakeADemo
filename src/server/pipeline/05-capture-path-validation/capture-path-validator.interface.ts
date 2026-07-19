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

/**
 * Validates that a Demo Script candidate's generated capture path can run against
 * the prepared app under Runtime Network Lockdown. Implementations must run
 * project-level checks before generated Browser Actions, produce structured
 * failure evidence, and must not produce final Scene footage.
 */
interface CapturePathValidator {
  validate(
    input: CapturePathValidationInput,
  ): Promise<CapturePathValidationResult>;
}
