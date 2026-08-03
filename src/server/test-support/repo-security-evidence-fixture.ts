import {
  type RepoSecurityEvidence,
  repoSecurityEvidenceLimits,
} from "../pipeline/02-repo-security-screen/repository-loading/repo-security-evidence";

/** Returns explicit bounded evidence for tests that do not exercise loading. */
export function repoSecurityEvidenceFixture(): RepoSecurityEvidence {
  return {
    coverage: {
      excerptBytes: 0,
      omittedEligibleFileCount: 0,
      omittedEligibleSizeBytes: 0,
      selectedFileCount: 0,
      truncatedFileCount: 0,
    },
    files: [],
    inventory: {
      eligibleFileCount: 0,
      eligibleSizeBytes: 0,
      omittedEligibleFileCount: 0,
      omittedEligibleSizeBytes: 0,
      sampledPathOmissionCount: 0,
      sampledPaths: [],
      totalFileCount: 0,
      totalSizeBytes: 0,
    },
    limits: repoSecurityEvidenceLimits,
  };
}
