import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspaceResourceDiagnostics } from "../../03-repo-preparation/preparation-workspace.interface";
import type { NetworkAttempt } from "./network-isolation-policy";
import type { DemoRuntimePreflightFailureKind } from "./validation-result";

export type SandboxValidationInput = {
  demoCommand: string;
  repoUrl: string;
  url: string;
};

export type SandboxValidationOutput = {
  blockedNetworkAttempts: NetworkAttempt[];
  /** URL the browser validator should use; falls back to the manifest URL. */
  browserUrl?: string;
  failureKind?: DemoRuntimePreflightFailureKind;
  failureReason?: string;
  localUrl?: string;
  /** Provider-hosted public URL, when the provider can expose one. */
  previewUrl?: string;
  serverLog?: string;
  cleanup?: () => Promise<void>;
  logs: string[];
  repoFiles: string[];
  runtimeExitCode: number;
  resourceDiagnostics?: PreparationWorkspaceResourceDiagnostics;
};

/**
 * Runs untrusted submitted project code inside an isolated sandbox.
 * Implementations must honor the Preparation Manifest dependency-install
 * strategy and report any observed runtime boundary attempts.
 */
export interface SandboxRunner {
  runValidation(
    input: SandboxValidationInput & {
      preparationManifest: PreparationManifest;
      preparationWorkspace: PreparationWorkspaceHandle;
    },
  ): Promise<SandboxValidationOutput>;
}
