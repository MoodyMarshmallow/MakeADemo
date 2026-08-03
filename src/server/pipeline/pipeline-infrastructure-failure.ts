/** Stable machine-readable failures owned by MakeADemo infrastructure. */
const pipelineInfrastructureFailureKinds = [
  "browser-validation-protocol-failed",
  "dependency-install-sigkill",
  "fresh-capture-baseline-failed",
  "invalid-output",
  "preparation-workspace-cleanup-failed",
  "sandbox-infrastructure-failed",
  "sandbox-execution-failed",
  "submitted-code-toolchain-provisioning-failed",
  "submitted-code-workspace-sync-failed",
  "submitted-toolchain-inspection-failed",
  "timeout",
  "unexpected-pipeline-error",
  "unavailable",
  "validator-dependency-failed",
] as const;

export type PipelineInfrastructureFailureKind =
  (typeof pipelineInfrastructureFailureKinds)[number];

const failureKinds = new Set<unknown>(pipelineInfrastructureFailureKinds);

export function isPipelineInfrastructureFailureKind(
  value: unknown,
): value is PipelineInfrastructureFailureKind {
  return failureKinds.has(value);
}
