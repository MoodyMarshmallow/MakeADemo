import type { RepoSecurityResult } from "../repo-security-screen";
import type { RepoSecurityEvidence } from "../repository-loading/repo-security-evidence";

export type RepoSecurityAgentReviewInput = {
  deadlineAt?: number;
  evidence: RepoSecurityEvidence;
  scan: RepoSecurityResult;
  signal?: AbortSignal;
};

export type RepoSecurityAgentReviewResult =
  | {
      concerns: string[];
      rationale: string;
      status: "succeeded";
      verdict: "approved" | "rejected";
    }
  | {
      failureKind: "invalid-output" | "timeout" | "unavailable";
      status: "failed";
    };

/**
 * Performs one read-only Stage 02 safety review over backend-bound static
 * evidence. Implementations must not expose tools, execute submitted code,
 * retain an Agent Session, or treat model output as repository evidence.
 */
export interface RepoSecurityAgentReviewer {
  review(
    input: RepoSecurityAgentReviewInput,
  ): Promise<RepoSecurityAgentReviewResult>;
}
