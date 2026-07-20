import type { NetworkAttempt } from "./network-isolation-policy";
import type { BoundedValidationText } from "./validation-evidence";

/**
 * Stable machine-readable validation failure categories. Producers must only set
 * this when the failure comes from MakeADemo infrastructure rather than app
 * behavior so callers can choose retry/fail-fast policy without parsing text.
 */
export type DemoRuntimePreflightFailureKind =
  | "dependency-install-failed"
  | "demo-process-exited"
  | "demo-readiness-timeout"
  | "fresh-capture-baseline-failed"
  | "runtime-network-blocked"
  | "validator-dependency-failed"
  | "browser-validation-protocol-failed"
  | "browser-validation-timeout"
  | "browser-load-failed"
  | "browser-not-interactable"
  | "sandbox-execution-failed"
  | "submitted-code-workspace-sync-failed";

type DemoRuntimePreflightEvidence = {
  browser?: BoundedValidationText;
  serverLog?: BoundedValidationText;
};

export type DemoRuntimePreflightResult = {
  blockedNetworkAttempts: NetworkAttempt[];
  browserUrl?: string;
  /** The sandbox-local URL that was actually validated. */
  localUrl?: string;
  /** The externally reachable preview URL, when one was created. */
  previewUrl?: string;
  evidence?: DemoRuntimePreflightEvidence;
  failureKind?: DemoRuntimePreflightFailureKind;
  failureReason?: string;
  logs: string[];
  screenshot?: { mimeType: "image/png"; path: string; sizeBytes?: number };
  screenshotArtifactId?: string;
  status: "succeeded" | "failed";
  warnings: string[];
};
