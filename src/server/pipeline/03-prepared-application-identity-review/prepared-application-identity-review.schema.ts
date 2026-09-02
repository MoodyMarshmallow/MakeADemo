import type { PreparedApplicationIdentityEvidenceLedger } from "./prepared-application-identity-evidence";
import type {
  PreparedApplicationIdentityDecision,
  PreparedApplicationIdentitySourceCitation,
} from "./prepared-application-identity-reviewer.interface";
import type { PreparedApplicationIdentityInspection } from "./prepared-application-identity-stage-tools";

export const preparedApplicationIdentityDecisionLimits = {
  array: 64,
  explanation: 4_000,
  string: 1_000,
} as const;

/** Validates agent output shape and backend-owned evidence provenance only. */
export function readPreparedApplicationIdentityDecision(
  value: unknown,
  ledger: PreparedApplicationIdentityEvidenceLedger,
  inspections: readonly PreparedApplicationIdentityInspection[] = [],
): PreparedApplicationIdentityDecision {
  const record = readRecord(value);
  const verdict = record.verdict;
  if (verdict !== "pass" && verdict !== "fail") {
    throw new Error("Identity review verdict must be pass or fail.");
  }
  const expectedKeys = [
    "explanation",
    ...(verdict === "fail" ? ["failureKind"] : []),
    "mockedBoundaries",
    "nativeSurfacesRendered",
    "replacementEvidence",
    "sourceCitations",
    "verdict",
  ].sort();
  if (Object.keys(record).sort().join(",") !== expectedKeys.join(",")) {
    throw new Error(
      "Identity review output contains unexpected or missing fields.",
    );
  }

  const explanation = readString(
    record.explanation,
    "explanation",
    preparedApplicationIdentityDecisionLimits.explanation,
  );
  const mockedBoundaries = readStringArray(
    record.mockedBoundaries,
    "mockedBoundaries",
  );
  const nativeSurfacesRendered = readStringArray(
    record.nativeSurfacesRendered,
    "nativeSurfacesRendered",
  );
  const replacementEvidence = readStringArray(
    record.replacementEvidence,
    "replacementEvidence",
  );
  const sourceCitations = readSourceCitations(record.sourceCitations);

  for (const boundary of mockedBoundaries) {
    if (!ledger.hasMockedBoundary(boundary)) {
      throw new Error(
        `Mocked boundary is outside the evidence ledger: ${boundary}`,
      );
    }
  }
  for (const path of nativeSurfacesRendered) {
    if (!ledger.hasSourcePath(path)) {
      throw new Error(`Native surface is outside the pinned source: ${path}`);
    }
  }
  for (const evidenceId of replacementEvidence) {
    if (!ledger.hasEvidence(evidenceId)) {
      throw new Error(
        `Replacement evidence is outside the evidence ledger: ${evidenceId}`,
      );
    }
  }
  for (const citation of sourceCitations) {
    if (!ledger.hasSourcePath(citation.path)) {
      throw new Error(
        `Source citation is outside the pinned source: ${citation.path}`,
      );
    }
  }

  const fields = {
    explanation,
    mockedBoundaries,
    nativeSurfacesRendered,
    replacementEvidence,
    sourceCitations,
  };
  if (verdict === "pass") {
    validatePassCoverage(fields, ledger, inspections);
    return { ...fields, verdict };
  }
  if (
    record.failureKind !== "replacement-detected" &&
    record.failureKind !== "identity-not-proven"
  ) {
    throw new Error(
      "Failed identity review must report replacement-detected or identity-not-proven.",
    );
  }
  return { ...fields, failureKind: record.failureKind, verdict };
}

function validatePassCoverage(
  decision: {
    mockedBoundaries: readonly string[];
    nativeSurfacesRendered: readonly string[];
    sourceCitations: readonly PreparedApplicationIdentitySourceCitation[];
  },
  ledger: PreparedApplicationIdentityEvidenceLedger,
  inspections: readonly PreparedApplicationIdentityInspection[],
): void {
  if (decision.nativeSurfacesRendered.length === 0) {
    throw new Error("Passed identity review must report a native surface.");
  }
  if (decision.sourceCitations.length === 0) {
    throw new Error("Passed identity review must report a source citation.");
  }
  if (!setsExactlyMatch(decision.mockedBoundaries, ledger.mockedBoundaries)) {
    throw new Error(
      "Passed identity review must cover the exact mocked-boundary ledger.",
    );
  }

  const evidenceInspections = inspections.filter(
    (inspection) => inspection.kind === "evidence",
  );
  for (const inspection of evidenceInspections) {
    const evidence = ledger.readEvidence(inspection.evidenceId);
    if (evidence === undefined || evidence.kind !== inspection.evidenceKind) {
      throw new Error("Identity inspection evidence provenance is invalid.");
    }
  }
  const inspectedEvidenceIds = new Set(
    evidenceInspections.map((inspection) => inspection.evidenceId),
  );
  for (const requiredKind of [
    "prepared-screenshot",
    "accessibility-snapshot",
  ] as const) {
    const requiredEvidence = ledger.evidence.filter(
      (evidence) => evidence.kind === requiredKind,
    );
    if (
      requiredEvidence.length === 0 ||
      requiredEvidence.some(
        (evidence) => !inspectedEvidenceIds.has(evidence.id),
      )
    ) {
      throw new Error(
        `Passed identity review must inspect ${requiredKind} evidence.`,
      );
    }
  }
  if (!inspectedEvidenceIds.has(ledger.preparedWorkspaceDiff.artifactId)) {
    throw new Error(
      "Passed identity review must inspect prepared-change evidence.",
    );
  }

  const sourceInspections = inspections.filter(
    (inspection) => inspection.kind === "source",
  );
  for (const citation of decision.sourceCitations) {
    if (
      !sourceInspections.some(
        (inspection) =>
          inspection.path === citation.path &&
          inspection.startLine <= citation.startLine &&
          inspection.endLine >= citation.endLine,
      )
    ) {
      throw new Error(
        `Source citation was not inspected during this review: ${citation.path}`,
      );
    }
  }
}

function setsExactlyMatch(
  values: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    values.length === expected.length &&
    new Set(values).size === values.length &&
    values.every((value) => expected.includes(value))
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Identity review output must be an object.");
  }
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > preparedApplicationIdentityDecisionLimits.array
  ) {
    throw new Error(`${field} must be a bounded array.`);
  }
  return value.map((item, index) =>
    readString(
      item,
      `${field}[${index}]`,
      preparedApplicationIdentityDecisionLimits.string,
    ),
  );
}

function readSourceCitations(
  value: unknown,
): PreparedApplicationIdentitySourceCitation[] {
  if (
    !Array.isArray(value) ||
    value.length > preparedApplicationIdentityDecisionLimits.array
  ) {
    throw new Error("sourceCitations must be a bounded array.");
  }
  return value.map((item, index) => {
    const citation = readRecord(item);
    if (Object.keys(citation).sort().join(",") !== "endLine,path,startLine") {
      throw new Error(`sourceCitations[${index}] has invalid fields.`);
    }
    const startLine = readPositiveInteger(
      citation.startLine,
      `sourceCitations[${index}].startLine`,
    );
    const endLine = readPositiveInteger(
      citation.endLine,
      `sourceCitations[${index}].endLine`,
    );
    if (endLine < startLine || endLine - startLine + 1 > 400) {
      throw new Error(`sourceCitations[${index}] must span at most 400 lines.`);
    }
    return {
      endLine,
      path: readString(
        citation.path,
        `sourceCitations[${index}].path`,
        preparedApplicationIdentityDecisionLimits.string,
      ),
      startLine,
    };
  });
}

function readPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value as number;
}

function readString(
  value: unknown,
  field: string,
  maxCharacters: number,
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxCharacters) {
    throw new Error(
      `${field} must be nonempty and at most ${maxCharacters} characters.`,
    );
  }
  return normalized;
}
