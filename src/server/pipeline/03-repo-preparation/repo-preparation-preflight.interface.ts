/**
 * The bounded, repair-oriented verdict Repo Preparation consumes after it
 * asks its runtime-preflight port to validate a Preparation Manifest.
 * Implementations must redact and bound diagnostic text before returning it;
 * Repo Preparation may persist this result in its control state and show it to
 * an agent, but never needs Capture Path Validation implementation details.
 */
export type RepoPreparationPreflightResult = {
  blockedNetworkAttempts: RepoPreparationNetworkAttempt[];
  browserUrl?: string;
  evidence?: RepoPreparationPreflightEvidence;
  failureKind?: string;
  failureReason?: string;
  localUrl?: string;
  logs: string[];
  previewUrl?: string;
  screenshot?: { mimeType: "image/png"; path: string; sizeBytes?: number };
  screenshotArtifactId?: string;
  status: "succeeded" | "failed";
  warnings: string[];
};

type RepoPreparationNetworkAttempt = {
  direction: "inbound" | "outbound";
  host: string;
  phase: "install" | "runtime";
  url?: string;
};

type RepoPreparationPreflightEvidence = {
  browser?: RepoPreparationBoundedEvidence;
  serverLog?: RepoPreparationBoundedEvidence;
};

type RepoPreparationBoundedEvidence = {
  omittedChars?: number;
  text: string;
  truncated?: true;
};
