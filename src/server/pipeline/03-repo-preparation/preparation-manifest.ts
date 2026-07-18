type PreparationStatus =
  | "adapted-existing-demo"
  | "created-new-demo"
  | "reused-existing-demo";

/** Controls whether validation infers and runs a package-manager install. */
type DependencyInstallStrategy = "inferred" | "not-required";

/**
 * Identifies the submitted repository UI that the prepared visible interface
 * must render. Paths must come from the source-controlled baseline captured
 * before Repo Preparation; startup attempts describe how native UI startup was
 * attempted rather than a replacement standalone entrypoint.
 */
type NativeVisibleInterfaceProvenance = {
  nativeStartupAttempts: string[];
  sourceControlledUiPaths: string[];
};

export type PreparationManifest = {
  assumptions: string[];
  createdFiles: string[];
  demoCommand: string;
  dependencyInstall?: DependencyInstallStrategy;
  diffArtifactId: string;
  existingDemoEvidence: string[];
  mockedServices: string[];
  modifiedFiles: string[];
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

  return {
    assumptions: readStringArray(record, "assumptions"),
    createdFiles: readOptionalStringArray(record, "createdFiles"),
    demoCommand: readNonEmptyString(record, "demoCommand"),
    dependencyInstall: readDependencyInstallStrategy(record),
    diffArtifactId: readNonEmptyString(record, "diffArtifactId"),
    existingDemoEvidence: readOptionalStringArray(
      record,
      "existingDemoEvidence",
    ),
    mockedServices: readOptionalStringArray(record, "mockedServices"),
    modifiedFiles: readOptionalStringArray(record, "modifiedFiles"),
    nativeVisibleInterface: readNativeVisibleInterface(record),
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

/**
 * Verifies that claimed visible UI paths existed in the submitted repository
 * before Repo Preparation. Callers must supply the backend-captured baseline,
 * never an agent-provided path inventory.
 */
export function validateNativeVisibleInterfaceProvenance(
  manifest: PreparationManifest,
  baselineSourceControlledPaths: readonly string[],
): void {
  const provenance = manifest.nativeVisibleInterface;
  if (provenance === undefined) {
    throw new Error("nativeVisibleInterface must be present");
  }
  const baselinePaths = new Set(baselineSourceControlledPaths);
  for (const path of provenance.sourceControlledUiPaths) {
    if (!baselinePaths.has(path)) {
      throw new Error(
        `nativeVisibleInterface.sourceControlledUiPaths includes ${path}, which was not source-controlled before Repo Preparation`,
      );
    }
  }
}

function readNativeVisibleInterface(
  record: Record<string, unknown>,
): NativeVisibleInterfaceProvenance {
  const provenance = assertRecord(
    record.nativeVisibleInterface,
    "nativeVisibleInterface",
  );
  const sourceControlledUiPaths = readStringArray(
    provenance,
    "sourceControlledUiPaths",
  );
  if (sourceControlledUiPaths.length === 0) {
    throw new Error(
      "nativeVisibleInterface.sourceControlledUiPaths must not be empty",
    );
  }
  const nativeStartupAttempts = readStringArray(
    provenance,
    "nativeStartupAttempts",
  );
  if (nativeStartupAttempts.length === 0) {
    throw new Error(
      "nativeVisibleInterface.nativeStartupAttempts must not be empty",
    );
  }

  return { nativeStartupAttempts, sourceControlledUiPaths };
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
