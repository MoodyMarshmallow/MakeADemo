import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { PreparedApplicationIdentityEvidenceLedger } from "./prepared-application-identity-evidence";

export type PreparedApplicationIdentitySourceCitation = {
  endLine: number;
  path: string;
  startLine: number;
};

type PreparedApplicationIdentityDecisionFields = {
  explanation: string;
  mockedBoundaries: string[];
  nativeSurfacesRendered: string[];
  replacementEvidence: string[];
  sourceCitations: PreparedApplicationIdentitySourceCitation[];
};

export type PreparedApplicationIdentityDecision =
  | (PreparedApplicationIdentityDecisionFields & {
      failureKind?: never;
      verdict: "pass";
    })
  | (PreparedApplicationIdentityDecisionFields & {
      failureKind: "identity-not-proven" | "replacement-detected";
      verdict: "fail";
    });

export type PreparedApplicationIdentityReviewInput = {
  deadlineAt?: number;
  evidenceLedger: PreparedApplicationIdentityEvidenceLedger;
  preparationManifest: PreparationManifest;
  preparationWorkspace: PreparationWorkspaceHandle;
  signal?: AbortSignal;
};

export type PreparedApplicationIdentityReviewResult =
  | (PreparedApplicationIdentityDecision & { status: "succeeded" })
  | {
      failureKind: "invalid-output" | "timeout" | "unavailable";
      status: "failed";
    };

/**
 * Independently verifies that a prepared visible application remains the
 * submitted pinned application's native interface. Implementations must use a
 * fresh non-retained session, treat repository and prepared evidence as
 * untrusted data, and return only schema- and provenance-validated decisions.
 */
export interface PreparedApplicationIdentityReviewer {
  review(
    input: PreparedApplicationIdentityReviewInput,
  ): Promise<PreparedApplicationIdentityReviewResult>;
}
