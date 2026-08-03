import type { AgentTaskRunner } from "../../../agent-harness/agent-session-runner.interface";
import {
  isPipelineCancellationError,
  throwIfPipelineDeadlineReached,
} from "../../00-orchestration/job/pipeline-cancellation";
import { createRepoSecurityAgentReviewPrompt } from "./repo-security-agent-review-prompt";
import { readRepoSecurityAgentDecision } from "./repo-security-agent-review.schema";
import type {
  RepoSecurityAgentReviewInput,
  RepoSecurityAgentReviewResult,
  RepoSecurityAgentReviewer,
} from "./repo-security-agent-reviewer.interface";
import { createRepoSecurityStageTools } from "./repo-security-stage-tools";

export type AgenticRepoSecurityReviewerOptions = {
  hardTimeoutMs: number;
  runner: AgentTaskRunner;
  timeoutMs: number;
};

/** Runs the Stage 02 safety decision as one restricted transient agent turn. */
export class AgenticRepoSecurityReviewer implements RepoSecurityAgentReviewer {
  constructor(private readonly options: AgenticRepoSecurityReviewerOptions) {}

  async review(
    input: RepoSecurityAgentReviewInput,
  ): Promise<RepoSecurityAgentReviewResult> {
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    const hardDeadlineAt = Math.min(
      Date.now() + this.options.hardTimeoutMs,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );

    let result: Awaited<ReturnType<AgentTaskRunner["run"]>>;
    try {
      result = await this.options.runner.run({
        attempt: 1,
        ...(input.deadlineAt === undefined
          ? {}
          : { deadlineCeilingAt: input.deadlineAt }),
        hardDeadlineAt,
        hardTimeoutMs: this.options.hardTimeoutMs,
        inactivityTimeoutMs: this.options.timeoutMs,
        executionMode: "stage-tools-transient",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        stage: "repo-security-screen",
        taskPrompt: createRepoSecurityAgentReviewPrompt({
          scannerReports: input.scannerReports,
        }),
        tools: createRepoSecurityStageTools(
          input.preparationWorkspace.workspace,
        ),
        workspace: input.preparationWorkspace.workspace,
      });
    } catch (error) {
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
      if (isPipelineCancellationError(error)) throw error;
      return failureResult(
        error instanceof Error && error.name === "AgentSessionTimeoutError"
          ? "timeout"
          : "unavailable",
      );
    }
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);

    if (result.exitCode !== 0) {
      return failureResult(
        result.failure?.category === "timeout" ? "timeout" : "unavailable",
      );
    }

    try {
      const decision = readRepoSecurityAgentDecision(result.structuredOutput);
      return {
        ...decision,
        status: "succeeded",
      };
    } catch {
      return failureResult("invalid-output");
    }
  }
}

function failureResult(
  failureKind: "invalid-output" | "timeout" | "unavailable",
): RepoSecurityAgentReviewResult {
  return {
    failureKind,
    status: "failed",
  };
}
