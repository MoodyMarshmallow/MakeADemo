export const repoPreparationPlaybookIds = [
  "mock-backend-data",
  "local-authentication",
  "seed-local-database",
] as const;

const preparationMockingPlanLimits = {
  collectionItems: 64,
  stringBytes: 1_000,
} as const;

export type RepoPreparationPlaybookId =
  (typeof repoPreparationPlaybookIds)[number];

type PreparationMockingBoundary = {
  kind: "authentication" | "backend" | "database";
  localReplacement: string;
  source: string;
};

export type PreparationMockingPlan = {
  boundaries: PreparationMockingBoundary[];
  fixturePaths: string[];
  loadedPlaybooks: RepoPreparationPlaybookId[];
  nativeUiRoots: string[];
  plannedPresentationChanges: string[];
};

/** Reads the durable plan for replacing runtime boundaries with local state. */
export function readPreparationMockingPlan(
  value: unknown,
): PreparationMockingPlan {
  const record = readRecord(value, "mockingPlan");
  const nativeUiRoots = readStringArray(record, "nativeUiRoots");
  if (nativeUiRoots.length === 0) {
    throw new Error("mockingPlan.nativeUiRoots must not be empty");
  }
  return {
    boundaries: readArray(record, "boundaries").map((boundary, index) => {
      const item = readRecord(boundary, `mockingPlan.boundaries[${index}]`);
      const kind = readString(item, "kind");
      if (
        kind !== "authentication" &&
        kind !== "backend" &&
        kind !== "database"
      ) {
        throw new Error(
          `mockingPlan.boundaries[${index}].kind must be authentication, backend, or database`,
        );
      }
      return {
        kind,
        localReplacement: readString(item, "localReplacement"),
        source: readString(item, "source"),
      };
    }),
    fixturePaths: readStringArray(record, "fixturePaths"),
    loadedPlaybooks: readStringArray(record, "loadedPlaybooks").map(
      (playbook, index) => {
        if (
          !(repoPreparationPlaybookIds as readonly string[]).includes(playbook)
        ) {
          throw new Error(
            `mockingPlan.loadedPlaybooks[${index}] must be a trusted Repo Preparation playbook ID`,
          );
        }
        return playbook as RepoPreparationPlaybookId;
      },
    ),
    nativeUiRoots,
    plannedPresentationChanges: readStringArray(
      record,
      "plannedPresentationChanges",
    ),
  };
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`mockingPlan.${key} must be an array`);
  }
  if (value.length > preparationMockingPlanLimits.collectionItems) {
    throw new Error(
      `mockingPlan.${key} must contain at most ${preparationMockingPlanLimits.collectionItems} items`,
    );
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  if (
    Buffer.byteLength(value, "utf8") > preparationMockingPlanLimits.stringBytes
  ) {
    throw new Error(
      `${key} must be at most ${preparationMockingPlanLimits.stringBytes} bytes`,
    );
  }
  return value;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  return readArray(record, key).map((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(
        `mockingPlan.${key}[${index}] must be a non-empty string`,
      );
    }
    if (
      Buffer.byteLength(value, "utf8") >
      preparationMockingPlanLimits.stringBytes
    ) {
      throw new Error(
        `mockingPlan.${key}[${index}] must be at most ${preparationMockingPlanLimits.stringBytes} bytes`,
      );
    }
    return value;
  });
}
