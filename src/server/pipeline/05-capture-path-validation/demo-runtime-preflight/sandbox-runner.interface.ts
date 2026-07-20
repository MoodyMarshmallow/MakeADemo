import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { NetworkAttempt } from "./network-isolation-policy";
import type { DemoRuntimePreflightFailureKind } from "./validation-result";

export type SandboxValidationInput = {
  demoCommand: string;
  repoUrl: string;
  url: string;
};

export type SandboxValidationOutput = {
  blockedNetworkAttempts: NetworkAttempt[];
  browserUrl?: string;
  failureKind?: DemoRuntimePreflightFailureKind;
  failureReason?: string;
  localUrl?: string;
  previewUrl?: string;
  serverLog?: string;
  cleanup?: () => Promise<void>;
  logs: string[];
  repoFiles: string[];
  runtimeExitCode: number;
};

/**
 * Runs untrusted submitted project code inside an isolated sandbox.
 * Implementations must honor the Preparation Manifest dependency-install
 * strategy, seal the runtime network boundary before the demo command runs,
 * and report any blocked boundary attempts.
 */
export interface SandboxRunner {
  runValidation(
    input: SandboxValidationInput & {
      preparationManifest: PreparationManifest;
      preparationWorkspace: PreparationWorkspaceHandle;
    },
  ): Promise<SandboxValidationOutput>;
}
