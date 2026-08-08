import { applicationIdentityEvidenceCaps } from "../03-repo-preparation/application-identity-evidence";
import type {
  ApplicationIdentityBaseline,
  PreparedWorkspaceDiff,
} from "../03-repo-preparation/application-identity-evidence.interface";

const maxEvidenceCharacters = 16 * 1024;

export type PreparedApplicationIdentityEvidence = {
  content: string;
  id: string;
  kind: "accessibility-snapshot" | "prepared-change" | "prepared-screenshot";
};

export type PreparedApplicationIdentityEvidenceLedger = {
  applicationIdentityBaseline: ApplicationIdentityBaseline;
  commitSha: string;
  evidence: readonly PreparedApplicationIdentityEvidence[];
  mockedBoundaries: readonly string[];
  preparedWorkspaceDiff: PreparedWorkspaceDiff;
  sourceControlledPaths: readonly string[];
  hasEvidence(id: string): boolean;
  hasMockedBoundary(boundary: string): boolean;
  hasSourcePath(path: string): boolean;
  readEvidence(id: string): PreparedApplicationIdentityEvidence | undefined;
};

/** Creates the backend-owned provenance ledger accepted by identity review. */
export function createPreparedApplicationIdentityEvidenceLedger(input: {
  applicationIdentityBaseline: ApplicationIdentityBaseline;
  evidence: readonly PreparedApplicationIdentityEvidence[];
  mockedBoundaries: readonly string[];
  preparedWorkspaceDiff: PreparedWorkspaceDiff;
}): PreparedApplicationIdentityEvidenceLedger {
  validatePreparedWorkspaceDiff(input.preparedWorkspaceDiff);
  const commitSha = input.applicationIdentityBaseline.pinnedRevision.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) {
    throw new Error("Identity evidence commitSha must be a full Git SHA.");
  }
  const evidence = [
    {
      content:
        input.preparedWorkspaceDiff.patch.length === 0
          ? "(empty prepared workspace diff)"
          : input.preparedWorkspaceDiff.patch,
      id: readBoundedValue(
        input.preparedWorkspaceDiff.artifactId,
        "evidence id",
        200,
      ),
      kind: "prepared-change" as const,
    },
    ...input.evidence.map((item) => ({
      content: readBoundedValue(item.content, "evidence content"),
      id: readBoundedValue(item.id, "evidence id", 200),
      kind: item.kind,
    })),
  ].map((item) => ({
    content: item.content,
    id: readBoundedValue(item.id, "evidence id", 200),
    kind: item.kind,
  }));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  if (evidenceById.size !== evidence.length) {
    throw new Error("Identity evidence ids must be unique.");
  }
  const mockedBoundaries = normalizedUniqueValues(
    input.mockedBoundaries,
    "mocked boundary",
  );
  const sourceControlledPaths = normalizedUniqueValues(
    input.applicationIdentityBaseline.sourceControlledPaths,
    "source-controlled path",
  );
  const mockedBoundarySet = new Set(mockedBoundaries);
  const sourcePathSet = new Set(sourceControlledPaths);

  return Object.freeze({
    applicationIdentityBaseline: input.applicationIdentityBaseline,
    commitSha,
    evidence: Object.freeze(evidence),
    mockedBoundaries: Object.freeze(mockedBoundaries),
    preparedWorkspaceDiff: input.preparedWorkspaceDiff,
    sourceControlledPaths: Object.freeze(sourceControlledPaths),
    hasEvidence: (id: string) => evidenceById.has(id),
    hasMockedBoundary: (boundary: string) => mockedBoundarySet.has(boundary),
    hasSourcePath: (path: string) => sourcePathSet.has(path),
    readEvidence: (id: string) => evidenceById.get(id),
  });
}

function validatePreparedWorkspaceDiff(diff: PreparedWorkspaceDiff): void {
  const bytes = Buffer.from(diff.patch, "utf8");
  if (bytes.length > applicationIdentityEvidenceCaps.workspaceDiffBytes) {
    throw new Error("Identity prepared diff exceeds its content bound.");
  }
}

function normalizedUniqueValues(
  values: readonly string[],
  field: string,
): string[] {
  const normalized = values.map((value) => readBoundedValue(value, field, 500));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Identity evidence ${field} values must be unique.`);
  }
  return normalized;
}

function readBoundedValue(
  value: string,
  field: string,
  maxCharacters = maxEvidenceCharacters,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxCharacters) {
    throw new Error(
      `Identity ${field} must be nonempty and at most ${maxCharacters} characters.`,
    );
  }
  return normalized;
}
