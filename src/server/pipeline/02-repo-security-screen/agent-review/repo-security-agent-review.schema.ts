export const repoSecurityAgentReviewLimits = {
  maxConcernCharacters: 500,
  maxConcerns: 16,
  maxRationaleCharacters: 2_000,
} as const;

export type RepoSecurityAgentDecision = {
  concerns: string[];
  rationale: string;
  verdict: "approved" | "rejected";
};

/** Validates the exact untrusted JSON returned by the Stage 02 reviewer. */
export function readRepoSecurityAgentDecision(
  value: unknown,
): RepoSecurityAgentDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Repo security review output must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "concerns,rationale,verdict") {
    throw new Error(
      "Repo security review output must contain exactly concerns, rationale, and verdict.",
    );
  }
  if (record.verdict !== "approved" && record.verdict !== "rejected") {
    throw new Error(
      "Repo security review verdict must be approved or rejected.",
    );
  }
  const rationale = readBoundedString(
    record.rationale,
    "rationale",
    repoSecurityAgentReviewLimits.maxRationaleCharacters,
  );
  if (
    !Array.isArray(record.concerns) ||
    record.concerns.length > repoSecurityAgentReviewLimits.maxConcerns
  ) {
    throw new Error("Repo security review concerns must be a bounded array.");
  }
  const concerns = record.concerns.map((concern, index) =>
    readBoundedString(
      concern,
      `concerns[${index}]`,
      repoSecurityAgentReviewLimits.maxConcernCharacters,
    ),
  );
  return { concerns, rationale, verdict: record.verdict };
}

function readBoundedString(
  value: unknown,
  field: string,
  maxCharacters: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxCharacters) {
    throw new Error(
      `${field} must be nonempty and at most ${maxCharacters} characters.`,
    );
  }
  return normalized;
}
