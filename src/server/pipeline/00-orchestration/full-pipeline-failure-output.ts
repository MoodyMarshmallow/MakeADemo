import { FullPipelineStageFailure } from "./full-pipeline-runner";

export function formatFullPipelineFailure(error: unknown): string | undefined {
  if (!(error instanceof FullPipelineStageFailure)) {
    return undefined;
  }

  return [
    "Pipeline failed",
    `Stage: ${error.stage}`,
    `Status: ${error.status}`,
    `Reason: ${readFailureReason(error.failure)}`,
    `Result JSON: ${error.resultPath}`,
    `Pipeline log: ${error.logPath}`,
    ...(error.agentAuditLogPath === undefined
      ? []
      : [`Agent audit log: ${error.agentAuditLogPath}`]),
    "",
  ].join("\n");
}

function readFailureReason(
  failure: FullPipelineStageFailure["failure"],
): string {
  return (
    failure.blockers.find((blocker) =>
      blocker.startsWith("Capture Path Validation reason: "),
    ) ??
    failure.blockers[0] ??
    "See full pipeline result for details."
  );
}
