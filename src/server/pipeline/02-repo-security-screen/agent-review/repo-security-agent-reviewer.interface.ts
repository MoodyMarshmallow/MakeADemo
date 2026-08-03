import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { RepoSecurityScannerReport } from "../repository-loading/repo-security-scanners";

export type RepoSecurityAgentReviewInput = {
  deadlineAt?: number;
  /** Exact unapproved parent retained from pinned repository loading. */
  preparationWorkspace: PreparationWorkspaceHandle;
  /** Advisory scanner output supplied as untrusted leads for inspection. */
  scannerReports: readonly RepoSecurityScannerReport[];
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
 * Performs one read-only Stage 02 safety review in the retained parent.
 * Implementations may expose only the restricted Stage 02 inspection tool,
 * must not execute submitted code, and must not retain an Agent Session.
 */
export interface RepoSecurityAgentReviewer {
  review(
    input: RepoSecurityAgentReviewInput,
  ): Promise<RepoSecurityAgentReviewResult>;
}
