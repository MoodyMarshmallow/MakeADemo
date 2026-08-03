import type {
  AgentSessionWorkspace,
  AgentTaskRunner,
} from "../../../agent-harness/agent-session-runner.interface";
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

export type AgenticRepoSecurityReviewerOptions = {
  hardTimeoutMs: number;
  runner: AgentTaskRunner;
  timeoutMs: number;
};

const toolFreeWorkspace: AgentSessionWorkspace = {
  async execute() {
    throw new Error("Repo Security Screen agent review is tool-free.");
  },
};

/** Runs the bounded Stage 02 safety decision as one tool-free agent turn. */
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
        executionMode: "tool-free-transient",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        stage: "repo-security-screen",
        taskPrompt: createRepoSecurityAgentReviewPrompt({
          evidence: input.evidence,
          scan: input.scan,
        }),
        tools: [],
        workspace: toolFreeWorkspace,
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
