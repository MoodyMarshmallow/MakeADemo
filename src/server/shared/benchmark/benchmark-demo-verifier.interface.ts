export type BenchmarkDemoVerificationStatus =
  | "verified"
  | "rejected"
  | "inconclusive"
  | "error";

export type BenchmarkDemoVerification = {
  artifactPath: string;
  comparisons: string[];
  mismatches: string[];
  reason: string;
  status: BenchmarkDemoVerificationStatus;
  verifier: "external-codex";
};

export type BenchmarkDemoVerifierInput = {
  commitSha: string;
  evidenceImagePaths: string[];
  features: string[];
  finalVideoPath: string;
  outputDirectory: string;
  repoId: string;
  repoUrl: string;
  signal?: AbortSignal;
};

/**
 * Independently compares rendered-video evidence with the submitted repository
 * at its pinned commit. Implementations must not reuse the generation session,
 * must return inconclusive when evidence is insufficient, and must never award
 * verification merely because a final video file exists.
 */
export type BenchmarkDemoVerifier = (
  input: BenchmarkDemoVerifierInput,
) => Promise<BenchmarkDemoVerification>;
