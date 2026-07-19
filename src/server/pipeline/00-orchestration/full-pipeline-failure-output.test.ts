import { describe, expect, it } from "vitest";

import { formatFullPipelineFailure } from "./full-pipeline-failure-output";
import { FullPipelineStageFailure } from "./full-pipeline-runner";

describe("formatFullPipelineFailure", () => {
  it("prints whole-pipeline failure context for the terminal", () => {
    const error = new FullPipelineStageFailure({
      failure: {
        blockers: ["Repo Preparation agent timed out."],
        suggestedChanges: [],
      },
      logPath: "/runs/failed/pipeline-log.jsonl",
      agentAuditLogPath: "/runs/failed/agent-audit-log.jsonl",
      resultPath: "/runs/failed/full-pipeline-result.json",
      stage: "pipeline",
      status: "preparation-failed",
    });
    const output = formatFullPipelineFailure(error);

    expect(error.message).toBe(
      "Pipeline failed with status preparation-failed",
    );
    expect(output).toBe(
      [
        "Pipeline failed",
        "Stage: pipeline",
        "Status: preparation-failed",
        "Reason: Repo Preparation agent timed out.",
        "Result JSON: /runs/failed/full-pipeline-result.json",
        "Pipeline log: /runs/failed/pipeline-log.jsonl",
        "Agent audit log: /runs/failed/agent-audit-log.jsonl",
        "",
      ].join("\n"),
    );
  });

  it("prints the specific Capture Path Validation reason when the first blocker is generic", () => {
    const output = formatFullPipelineFailure(
      new FullPipelineStageFailure({
        failure: {
          blockers: [
            "Capture Path Validation failed. Please report this issue to MakeADemo.",
            "Capture Path Validation reason: Generated selector did not match.",
          ],
          suggestedChanges: [],
        },
        logPath: "/runs/failed/pipeline-log.jsonl",
        agentAuditLogPath: "/runs/failed/agent-audit-log.jsonl",
        resultPath: "/runs/failed/full-pipeline-result.json",
        stage: "pipeline",
        status: "capture-path-validation-failed",
      }),
    );

    expect(output).toContain(
      "Reason: Capture Path Validation reason: Generated selector did not match.",
    );
  });

  it("returns undefined for non-structured errors", () => {
    expect(formatFullPipelineFailure(new Error("boom"))).toBeUndefined();
  });

  it("omits the agent audit log line when no audit log path is available", () => {
    const output = formatFullPipelineFailure(
      new FullPipelineStageFailure({
        failure: {
          blockers: ["Repo Preparation agent timed out."],
          suggestedChanges: [],
        },
        logPath: "/runs/failed/pipeline-log.jsonl",
        agentAuditLogPath: undefined,
        resultPath: "/runs/failed/full-pipeline-result.json",
        stage: "pipeline",
        status: "preparation-failed",
      }),
    );

    expect(output).not.toContain("Agent audit log:");
  });
});
