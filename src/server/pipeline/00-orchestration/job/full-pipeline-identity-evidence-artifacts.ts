import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PreparedApplicationIdentityReviewResult } from "../../03-prepared-application-identity-review/prepared-application-identity-reviewer.interface";
import { applicationIdentityEvidenceCaps } from "../../03-repo-preparation/application-identity-evidence";
import type { PreparedApplicationIdentityEvidenceSource } from "../../03-repo-preparation/repo-preparation-agent.interface";

const identityAuditMaximumBytes = 512 * 1024;
const identityAuditFilename = "prepared-application-identity-audit.json";
const preparedWorkspacePatchFilename = "prepared-workspace.patch";

export type FullPipelineIdentityEvidenceArtifactPaths = {
  identityAuditPath: string;
  preparedWorkspacePatchPath: string;
};

/**
 * Persists one bounded, exact backend preparation patch and a compact audit
 * record. The audit retains digests and validated structured decisions, but
 * omits raw source inventory, screenshot bytes, and accessibility text.
 */
export async function writeFullPipelineIdentityEvidenceArtifacts(input: {
  identityReview: PreparedApplicationIdentityReviewResult;
  preparation: PreparedApplicationIdentityEvidenceSource;
  runDirectory: string;
}): Promise<FullPipelineIdentityEvidenceArtifactPaths> {
  const diff = input.preparation.preparedWorkspaceDiff;
  const patchBytes = Buffer.from(diff.patch, "utf8");
  const patchSha256 = sha256(patchBytes);
  if (
    patchBytes.length > applicationIdentityEvidenceCaps.workspaceDiffBytes ||
    patchBytes.length !== diff.sizeBytes ||
    patchSha256 !== diff.patchSha256
  ) {
    throw new Error(
      "Prepared Workspace patch does not match its bounded backend digest.",
    );
  }

  const identityAuditPath = join(input.runDirectory, identityAuditFilename);
  const preparedWorkspacePatchPath = join(
    input.runDirectory,
    preparedWorkspacePatchFilename,
  );
  const accessibilitySnapshot =
    input.preparation.runtimePreflight.accessibilitySnapshot;
  const screenshot = input.preparation.runtimePreflight.screenshot;
  const manifestJson = JSON.stringify(input.preparation.manifest);
  const audit = {
    baseline: {
      pathInventorySha256:
        input.preparation.applicationIdentityBaseline.pathInventorySha256,
      pinnedRevision:
        input.preparation.applicationIdentityBaseline.pinnedRevision,
      sourcePathCount:
        input.preparation.applicationIdentityBaseline.sourceControlledPaths
          .length,
      sourceTreeObjectId:
        input.preparation.applicationIdentityBaseline.sourceTreeObjectId,
    },
    identityReview: input.identityReview,
    preparationManifest: {
      diffArtifactId: input.preparation.manifest.diffArtifactId,
      mockingPlan: input.preparation.manifest.mockingPlan,
      sha256: sha256(Buffer.from(manifestJson, "utf8")),
    },
    preparedEvidence: {
      ...(accessibilitySnapshot === undefined
        ? {}
        : {
            accessibilitySnapshot: {
              ...(accessibilitySnapshot.omittedChars === undefined
                ? {}
                : { omittedChars: accessibilitySnapshot.omittedChars }),
              sha256: accessibilitySnapshot.sha256,
              sizeBytes: accessibilitySnapshot.sizeBytes,
            },
          }),
      ...(screenshot?.sha256 === undefined
        ? {}
        : {
            screenshot: {
              mimeType: screenshot.mimeType,
              sha256: screenshot.sha256,
              ...(screenshot.sizeBytes === undefined
                ? {}
                : { sizeBytes: screenshot.sizeBytes }),
            },
          }),
    },
    preparedWorkspaceDiff: {
      artifactId: diff.artifactId,
      createdPathCount: diff.createdPaths.length,
      deletedPathCount: diff.deletedPaths.length,
      modifiedPathCount: diff.modifiedPaths.length,
      patchSha256,
      patchSizeBytes: patchBytes.length,
    },
    version: 1,
  } as const;
  const auditBytes = Buffer.from(`${JSON.stringify(audit, null, 2)}\n`, "utf8");
  if (auditBytes.length > identityAuditMaximumBytes) {
    throw new Error("Prepared Application Identity audit exceeds its bound.");
  }

  await writeFile(preparedWorkspacePatchPath, patchBytes);
  await writeFile(identityAuditPath, auditBytes);
  return { identityAuditPath, preparedWorkspacePatchPath };
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
