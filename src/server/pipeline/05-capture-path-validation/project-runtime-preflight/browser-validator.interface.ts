import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { NetworkAttempt } from "./network-isolation-policy";
import type { ProjectValidationFailureKind } from "./validation-result";

export type BrowserValidationInput = {
  preparationWorkspace?: PreparationWorkspaceHandle;
  url: string;
};

export type BrowserValidationOutput = {
  blockedNetworkAttempts?: NetworkAttempt[];
  failureKind?: ProjectValidationFailureKind;
  interactable: boolean;
  logs: string[];
  screenshot?: { mimeType: "image/png"; path: string; sizeBytes?: number };
  screenshotArtifactId: string;
};

/**
 * Validates browser-capturable app behavior inside the sandbox.
 * Implementations must load the configured local URL, reject blank or fatal
 * runtime states, prove basic interactability, report browser-side runtime
 * network boundary attempts, and return screenshot proof.
 */
export interface BrowserValidator {
  validate(input: BrowserValidationInput): Promise<BrowserValidationOutput>;
}
