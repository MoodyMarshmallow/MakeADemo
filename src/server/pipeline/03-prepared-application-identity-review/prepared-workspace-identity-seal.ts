import type { PreparedWorkspaceDiff } from "../03-repo-preparation/application-identity-evidence.interface";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { PreparedApplicationIdentityEvidenceSource } from "../03-repo-preparation/repo-preparation-agent.interface";
import type { PreparedApplicationIdentityReviewResult } from "./prepared-application-identity-reviewer.interface";

type IdentityNotProvenReview = Extract<
  PreparedApplicationIdentityReviewResult,
  { status: "succeeded"; verdict: "fail" }
>;

export type PreparedWorkspaceIdentitySealResult =
  | { preparedWorkspaceDiff: PreparedWorkspaceDiff; status: "intact" }
  | { identityReview: IdentityNotProvenReview; status: "changed" };

/** Terminal post-review source-integrity failure carried across later stages. */
export class PreparedWorkspaceIdentitySealError extends Error {
  readonly identityReview: IdentityNotProvenReview;
  readonly identityEvidenceSource: PreparedApplicationIdentityEvidenceSource;
  readonly workspaceId: string;

  constructor(
    identityReview: IdentityNotProvenReview,
    workspaceId: string,
    identityEvidenceSource: PreparedApplicationIdentityEvidenceSource,
  ) {
    super(identityReview.explanation);
    this.name = "PreparedWorkspaceIdentitySealError";
    this.identityReview = identityReview;
    this.identityEvidenceSource = identityEvidenceSource;
    this.workspaceId = workspaceId;
  }
}

/**
 * Recaptures the backend-owned source diff and proves that a writable stage did
 * not change any source authority accepted by Prepared Application Identity
 * Review. Implementations of the workspace seam must return the complete diff
 * against the privately bound pinned baseline.
 */
export async function verifyPreparedWorkspaceIdentitySeal(input: {
  reviewedDiff: PreparedWorkspaceDiff;
  stage: string;
  workspace: PreparationWorkspaceHandle;
}): Promise<PreparedWorkspaceIdentitySealResult> {
  const capturePreparedWorkspaceDiff =
    input.workspace.workspace.capturePreparedWorkspaceDiff;
  if (capturePreparedWorkspaceDiff === undefined) {
    throw new Error(
      "Prepared Workspace identity seal requires backend diff recapture.",
    );
  }
  const currentDiff = await capturePreparedWorkspaceDiff.call(
    input.workspace.workspace,
  );
  if (preparedWorkspaceDiffsMatch(input.reviewedDiff, currentDiff)) {
    return { preparedWorkspaceDiff: currentDiff, status: "intact" };
  }
  return {
    identityReview: {
      explanation: `${input.stage} changed prepared source after Prepared Application Identity Review. Full re-preparation and a new identity review are required.`,
      failureKind: "identity-not-proven",
      mockedBoundaries: [],
      nativeSurfacesRendered: [],
      replacementEvidence: [],
      sourceCitations: [],
      status: "succeeded",
      verdict: "fail",
    },
    status: "changed",
  };
}

function preparedWorkspaceDiffsMatch(
  reviewed: PreparedWorkspaceDiff,
  current: PreparedWorkspaceDiff,
): boolean {
  return (
    reviewed.artifactId === current.artifactId &&
    reviewed.patchSha256 === current.patchSha256 &&
    reviewed.patch === current.patch &&
    reviewed.sizeBytes === current.sizeBytes &&
    samePathSet(reviewed.createdPaths, current.createdPaths) &&
    samePathSet(reviewed.deletedPaths, current.deletedPaths) &&
    samePathSet(reviewed.modifiedPaths, current.modifiedPaths)
  );
}

function samePathSet(
  reviewed: readonly string[],
  current: readonly string[],
): boolean {
  if (reviewed.length !== current.length) return false;
  const currentPaths = new Set(current);
  return (
    currentPaths.size === current.length &&
    reviewed.every((path) => currentPaths.has(path))
  );
}
