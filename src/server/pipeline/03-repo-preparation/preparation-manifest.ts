import type {
  ApplicationIdentityBaseline,
  PreparedWorkspaceDiff,
} from "./application-identity-evidence.interface";
import {
  type PreparationMockingPlan,
  readPreparationMockingPlan,
} from "./preparation-mocking-plan.schema";

type PreparationStatus =
  | "adapted-existing-demo"
  | "created-new-demo"
  | "reused-existing-demo";

/** Controls whether validation infers and runs a package-manager install. */
type DependencyInstallStrategy = "inferred" | "not-required";

type NativeVisibleInterfaceProvenance = {
  nativeStartupAttempts: string[];
  sourceControlledUiPaths: string[];
};

export type PreparationManifest = {
  assumptions: string[];
  createdFiles: string[];
  deletedFiles?: string[];
  demoCommand: string;
  dependencyInstall?: DependencyInstallStrategy;
  diffArtifactId: string;
  existingDemoEvidence: string[];
  mockingPlan: PreparationMockingPlan;
  /** @deprecated Derived from mockingPlan.boundaries. */
  mockedServices: string[];
  modifiedFiles: string[];
  /** @deprecated Derived from demoCommand and mockingPlan.nativeUiRoots. */
  nativeVisibleInterface?: NativeVisibleInterfaceProvenance;
  repoUrl: string;
  risks: string[];
  scriptGenerationContext: string[];
  setupSummary: string;
  status: PreparationStatus;
  url: string;
  workspaceId: string;
};

const statuses = new Set<PreparationStatus>([
  "adapted-existing-demo",
  "created-new-demo",
  "reused-existing-demo",
]);

export function readPreparationManifest(value: unknown): PreparationManifest {
  const record = assertRecord(value, "Preparation Manifest");
  const status = readStatus(record);
  const demoCommand = readNonEmptyString(record, "demoCommand");
  const mockingPlan = readPreparationMockingPlan(record.mockingPlan);
  const mockedServices = [
    ...new Set(mockingPlan.boundaries.map((boundary) => boundary.source)),
  ];

  return {
    assumptions: readStringArray(record, "assumptions"),
    createdFiles: readOptionalStringArray(record, "createdFiles"),
    deletedFiles: readOptionalStringArray(record, "deletedFiles"),
    demoCommand,
    dependencyInstall: readDependencyInstallStrategy(record),
    diffArtifactId: readNonEmptyString(record, "diffArtifactId"),
    existingDemoEvidence: readOptionalStringArray(
      record,
      "existingDemoEvidence",
    ),
    mockingPlan,
    mockedServices,
    modifiedFiles: readOptionalStringArray(record, "modifiedFiles"),
    nativeVisibleInterface: {
      nativeStartupAttempts: [demoCommand],
      sourceControlledUiPaths: [...mockingPlan.nativeUiRoots],
    },
    repoUrl: readNonEmptyString(record, "repoUrl"),
    risks: readStringArray(record, "risks"),
    scriptGenerationContext: readOptionalStringArray(
      record,
      "scriptGenerationContext",
    ),
    setupSummary: readNonEmptyString(record, "setupSummary"),
    status,
    url: readLocalHttpUrl(record, "url"),
    workspaceId: readNonEmptyString(record, "workspaceId"),
  };
}

/** Validates plan paths against backend-owned source and workspace evidence. */
export function validateNativeVisibleInterfaceProvenance(
  manifest: PreparationManifest,
  applicationIdentityBaseline: ApplicationIdentityBaseline,
): void {
  const baselinePaths = new Set(
    applicationIdentityBaseline.sourceControlledPaths,
  );
  const indexedSourcePaths = new Set(
    applicationIdentityBaseline.uiIdentityIndex.entries.map(
      (entry) => entry.path,
    ),
  );
  for (const path of manifest.mockingPlan.nativeUiRoots) {
    if (!baselinePaths.has(path)) {
      throw new Error(
        `mockingPlan.nativeUiRoots includes ${path}, which was not source-controlled before Repo Preparation`,
      );
    }
    if (!indexedSourcePaths.has(path)) {
      throw new Error(
        `mockingPlan.nativeUiRoots includes ${path}, which was not indexed as pre-mutation source evidence`,
      );
    }
  }
  const preparedPaths = new Set(baselinePaths);
  for (const path of manifest.deletedFiles ?? []) preparedPaths.delete(path);
  for (const path of manifest.createdFiles) preparedPaths.add(path);
  for (const path of manifest.mockingPlan.fixturePaths) {
    if (!preparedPaths.has(path)) {
      throw new Error(
        `mockingPlan.fixturePaths includes ${path}, which was not present in the pinned source or backend-captured workspace diff`,
      );
    }
  }
}

/**
 * Binds agent-authored manifest claims to the backend-captured workspace diff.
 * The returned manifest always carries the backend artifact identifier; agent
 * output cannot select or replace diff evidence.
 */
export function createAuthoritativePreparationManifest(
  manifest: PreparationManifest,
  diff: PreparedWorkspaceDiff,
): PreparationManifest {
  assertSamePaths("createdFiles", manifest.createdFiles, diff.createdPaths);
  assertSamePaths(
    "deletedFiles",
    manifest.deletedFiles ?? [],
    diff.deletedPaths,
  );
  assertSamePaths("modifiedFiles", manifest.modifiedFiles, diff.modifiedPaths);
  return {
    ...manifest,
    deletedFiles: manifest.deletedFiles ?? [],
    diffArtifactId: diff.artifactId,
  };
}

function assertSamePaths(
  manifestField: "createdFiles" | "deletedFiles" | "modifiedFiles",
  claimedPaths: readonly string[],
  actualPaths: readonly string[],
): void {
  assertSameValues(
    `${manifestField} must exactly match the backend-captured prepared workspace diff`,
    claimedPaths,
    actualPaths,
  );
}

function assertSameValues(
  message: string,
  claimedValues: readonly string[],
  actualValues: readonly string[],
): void {
  const claimed = [...claimedValues].sort();
  const actual = [...actualValues].sort();
  if (
    claimed.length !== actual.length ||
    claimed.some((value, index) => value !== actual[index])
  ) {
    throw new Error(message);
  }
}

function readDependencyInstallStrategy(
  record: Record<string, unknown>,
): DependencyInstallStrategy {
  const value =
    record.dependencyInstall === undefined
      ? "inferred"
      : record.dependencyInstall;
  if (value !== "inferred" && value !== "not-required") {
    throw new Error("dependencyInstall must be inferred or not-required");
  }
  return value;
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readStatus(record: Record<string, unknown>): PreparationStatus {
  const status = readNonEmptyString(record, "status");
  if (!statuses.has(status as PreparationStatus)) {
    throw new Error("status must be a known preparation status");
  }

  return status as PreparationStatus;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function readLocalHttpUrl(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = readNonEmptyString(record, key);
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "0.0.0.0"].includes(url.hostname)
    ) {
      return value;
    }
  } catch {
    // Fall through to the shared validation error.
  }

  throw new Error(`${key} must be a local http URL`);
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be a string array`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${key}[${index}] must be a string`);
    }

    return item;
  });
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  return record[key] === undefined ? [] : readStringArray(record, key);
}
