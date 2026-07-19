import { resolveCommand } from "package-manager-detector/commands";
import {
  maxSatisfying,
  satisfies as semverSatisfies,
  validRange,
} from "semver";
import { normalizeSubmittedProjectRoot } from "./submitted-project-root";

const catalogRevision = "submitted-js-2026-07-17.1" as const;
// The active catalog intentionally targets the Directus/Ghost slice only.
// Catalog parity for npm, Yarn, Bun, and Node 18/24/26 is required before the
// full benchmark can represent general JavaScript-project support.
// Audited follow-up candidates are intentionally not executable catalog
// entries until the submitted-code image physically contains their paths:
// Node 18.20.8, 24.11.1, 24.16.0, 26.3.0; Bun 1.2.22; and Yarn
// 1.22.22/4.11.0/4.12.0/4.13.0.
const supportedNodeVersions = ["22.23.1"] as const;
const supportedPackageManagerVersions = {
  pnpm: ["10.27.0", "11.13.0"],
} as const;

type SubmittedCodePackageManager = "bun" | "npm" | "pnpm" | "yarn";

/**
 * A normalized, bounded file view produced by MakeADemo's trusted metadata
 * inspector. Keys must be accepted metadata basenames and values must never
 * exceed the inspector's file-size limit.
 */
type SubmittedCodeToolchainCandidate = {
  files: Readonly<Record<string, string>>;
  projectRoot: string;
};

/**
 * Safe normalized metadata for candidate JavaScript project roots. Producers
 * must not execute repository code or read credential-bearing configuration.
 */
export type SubmittedCodeToolchainMetadata = {
  candidates: readonly SubmittedCodeToolchainCandidate[];
};

/**
 * The executable toolchain selected solely from the fixed offline catalog.
 * Consumers must map versions and projectRoot to catalog-owned paths; no raw
 * repository string may be used as an executable path or command.
 */
export type SubmittedCodeToolchainPlan = {
  catalogRevision: typeof catalogRevision;
  evidence: readonly SubmittedCodeToolchainEvidence[];
  /** Present only when the catalog can perform an immutable install. */
  install?: {
    argv: readonly string[];
    executable: string;
  };
  /** A bounded reason an install must be blocked; runtime remains catalog-owned. */
  installBlocker?: {
    code: Exclude<
      SubmittedCodeToolchainResolutionError["code"],
      "unsupported_node_version"
    >;
    reason: string;
  };
  node: { version: (typeof supportedNodeVersions)[number] };
  packageManager?: {
    corepackHash?: string;
    name: "pnpm";
    version: (typeof supportedPackageManagerVersions.pnpm)[number];
  };
  projectRoot: string;
  warnings?: readonly SubmittedCodeToolchainWarning[];
};

export class SubmittedCodeToolchainResolutionError extends Error {
  constructor(
    readonly code:
      | "missing_immutable_install"
      | "missing_lockfile"
      | "unsupported_node_version"
      | "unsupported_package_manager"
      | "unsupported_package_manager_version",
    message: string,
  ) {
    super(message);
    this.name = "SubmittedCodeToolchainResolutionError";
  }
}

type SubmittedCodeToolchainWarning = {
  reason: string;
  source: string;
  value: string;
};

/** One normalized metadata claim retained for audit, never for execution. */
type SubmittedCodeToolchainEvidence = {
  kind: "lockfile" | "node" | "package-manager" | "project-root";
  source: string;
  value: string;
};

const metadataFileMaxBytes = 64 * 1024;
const acceptedMetadataFiles = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
]);

/** Resolves safe submitted-project metadata against the revisioned catalog. */
export function resolveSubmittedCodeToolchain(
  metadata: SubmittedCodeToolchainMetadata,
): SubmittedCodeToolchainPlan {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !Array.isArray(metadata.candidates)
  ) {
    throw new Error("Submitted toolchain metadata must contain candidates.");
  }
  const candidate = selectProjectRoot(metadata.candidates);
  const packageJson = readPackageJson(candidate.files["package.json"]);
  const evidence: SubmittedCodeToolchainEvidence[] = [
    {
      kind: "project-root",
      source: "accepted JavaScript project metadata",
      value: candidate.projectRoot,
    },
  ];
  const nodeConstraints = collectNodeConstraints(candidate.files, packageJson);
  evidence.push(
    ...nodeConstraints.map(({ source, value }) => ({
      kind: "node" as const,
      source,
      value,
    })),
  );
  const { version: nodeVersion, warnings } =
    resolveNodeVersion(nodeConstraints);
  let manager: SubmittedCodeToolchainPlan["packageManager"];
  try {
    manager = resolvePackageManager(
      candidate.files,
      packageJson,
      evidence,
      warnings,
    );
  } catch (error) {
    if (
      error instanceof SubmittedCodeToolchainResolutionError &&
      error.code !== "unsupported_node_version"
    ) {
      return {
        catalogRevision,
        evidence,
        installBlocker: {
          code: error.code,
          reason: installBlockerReason(error.code),
        },
        node: { version: nodeVersion },
        projectRoot: candidate.projectRoot,
        warnings,
      };
    }
    throw error;
  }
  if (manager === undefined) {
    throw new Error("Submitted toolchain package manager is missing.");
  }
  const install = resolveCommand(manager.name, "frozen", []);
  if (install === null) {
    throw new SubmittedCodeToolchainResolutionError(
      "missing_immutable_install",
      `Package manager ${manager.name} does not define an immutable install command.`,
    );
  }

  return {
    catalogRevision,
    evidence,
    install: { argv: install.args, executable: install.command },
    node: { version: nodeVersion },
    packageManager: manager,
    projectRoot: candidate.projectRoot,
    warnings,
  };
}

function installBlockerReason(
  code: Exclude<
    SubmittedCodeToolchainResolutionError["code"],
    "unsupported_node_version"
  >,
): string {
  switch (code) {
    case "missing_immutable_install":
      return "The selected package manager has no catalog-owned immutable install.";
    case "missing_lockfile":
      return "The selected package manager requires its canonical lockfile.";
    case "unsupported_package_manager":
      return "The submitted package manager is not available in the active catalog.";
    case "unsupported_package_manager_version":
      return "The submitted package-manager version is not available in the active catalog.";
  }
}

function selectProjectRoot(
  candidates: readonly SubmittedCodeToolchainCandidate[],
): SubmittedCodeToolchainCandidate {
  if (candidates.length === 0) {
    throw new Error("No accepted JavaScript project metadata was found.");
  }
  for (const candidate of candidates) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.projectRoot !== "string" ||
      typeof candidate.files !== "object" ||
      candidate.files === null ||
      Array.isArray(candidate.files)
    ) {
      throw new Error("Submitted toolchain candidate is malformed.");
    }
    normalizeSubmittedProjectRoot(candidate.projectRoot);
    for (const [name, value] of Object.entries(candidate.files)) {
      if (!acceptedMetadataFiles.has(name) || typeof value !== "string") {
        throw new Error(
          `Unsupported submitted toolchain metadata file: ${name}`,
        );
      }
      if (Buffer.byteLength(value) > metadataFileMaxBytes) {
        throw new Error(
          `Submitted toolchain metadata exceeds ${metadataFileMaxBytes} bytes.`,
        );
      }
    }
  }

  const root = candidates.filter((candidate) => candidate.projectRoot === ".");
  if (root.length === 1) return root[0] as SubmittedCodeToolchainCandidate;
  if (root.length > 1 || candidates.length > 1) {
    throw new Error(
      `Ambiguous JavaScript project roots: ${candidates
        .map((candidate) => candidate.projectRoot)
        .sort()
        .join(", ")}`,
    );
  }
  return candidates[0] as SubmittedCodeToolchainCandidate;
}

type PackageJson = {
  devEngines?: { packageManager?: EngineValue; runtime?: EngineValue };
  engines?: { node?: unknown; npm?: unknown; pnpm?: unknown; yarn?: unknown };
  packageManager?: unknown;
  volta?: { node?: unknown; npm?: unknown; pnpm?: unknown; yarn?: unknown };
  workspaces?: unknown;
};
type EngineValue = { name?: unknown; version?: unknown } | string;
type Constraint = { source: string; value: string };

function readPackageJson(value: string | undefined): PackageJson {
  if (value === undefined) throw new Error("package.json is required.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Submitted package.json is malformed.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Submitted package.json must contain an object.");
  }
  return parsed as PackageJson;
}

function collectNodeConstraints(
  files: Readonly<Record<string, string>>,
  packageJson: PackageJson,
): Constraint[] {
  const constraints: Constraint[] = [];
  pushStringConstraint(
    constraints,
    "package.json engines.node",
    packageJson.engines?.node,
  );
  pushTrimmedConstraint(constraints, ".nvmrc", files[".nvmrc"]);
  pushTrimmedConstraint(constraints, ".node-version", files[".node-version"]);
  pushStringConstraint(
    constraints,
    "package.json volta.node",
    packageJson.volta?.node,
  );
  const runtime = packageJson.devEngines?.runtime;
  if (typeof runtime === "object" && runtime !== null) {
    if (runtime.name === undefined || runtime.name === "node") {
      pushStringConstraint(
        constraints,
        "package.json devEngines.runtime.version",
        runtime.version,
      );
    }
  }
  const toolVersions = files[".tool-versions"];
  if (toolVersions !== undefined) {
    const nodeLine = toolVersions
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find(([name]) => name === "nodejs");
    if (nodeLine?.[1] !== undefined) {
      constraints.push({ source: ".tool-versions nodejs", value: nodeLine[1] });
    }
  }
  for (const filename of ["mise.toml", ".mise.toml"]) {
    const content = files[filename];
    if (content === undefined) continue;
    const match = /^node\s*=\s*["']([^"']+)["']/m.exec(content);
    if (match?.[1] !== undefined) {
      constraints.push({ source: `${filename} node`, value: match[1] });
    }
  }
  return constraints;
}

function resolveNodeVersion(constraints: Constraint[]): {
  version: (typeof supportedNodeVersions)[number];
  warnings: SubmittedCodeToolchainWarning[];
} {
  const selected = constraints[0];
  if (selected === undefined) {
    return {
      version: supportedNodeVersions[
        supportedNodeVersions.length - 1
      ] as (typeof supportedNodeVersions)[number],
      warnings: [],
    };
  }
  const range = validRange(selected.value);
  if (range === null) {
    throw new Error(
      `Invalid Node constraint: ${selected.source}=${selected.value}.`,
    );
  }
  const version = maxSatisfying([...supportedNodeVersions], range, {
    includePrerelease: false,
    loose: false,
  });
  if (version === null) {
    throw new SubmittedCodeToolchainResolutionError(
      "unsupported_node_version",
      `Node constraints do not intersect the ${catalogRevision} active catalog (${supportedNodeVersions.join(", ")}): ${selected.source}=${selected.value}.`,
    );
  }
  return {
    version,
    warnings: constraints.slice(1).flatMap((constraint) => {
      const lowerRange = validRange(constraint.value);
      if (
        lowerRange !== null &&
        semverSatisfies(version, lowerRange, {
          includePrerelease: false,
          loose: false,
        })
      ) {
        return [];
      }
      return [
        {
          reason: `Lower-priority Node metadata disagrees with ${selected.source}.`,
          source: constraint.source,
          value: constraint.value,
        },
      ];
    }),
  };
}

function pushStringConstraint(
  constraints: Constraint[],
  source: string,
  value: unknown,
): void {
  if (typeof value === "string" && value.trim() !== "") {
    constraints.push({ source, value: value.trim() });
  }
}
function pushTrimmedConstraint(
  constraints: Constraint[],
  source: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.trim() !== "") {
    constraints.push({ source, value: value.trim() });
  }
}

function resolvePackageManager(
  files: Readonly<Record<string, string>>,
  packageJson: PackageJson,
  evidence: SubmittedCodeToolchainEvidence[],
  warnings: SubmittedCodeToolchainWarning[],
): SubmittedCodeToolchainPlan["packageManager"] {
  const lockArtifacts = collectLockArtifacts(files);
  const duplicateArtifacts = findDuplicateLockArtifacts(lockArtifacts);
  if (duplicateArtifacts.length > 0) {
    throw new Error(
      `Conflicting package-manager lock artifacts: ${duplicateArtifacts
        .map((artifact) => artifact.name)
        .sort()
        .join(", ")}.`,
    );
  }
  const lockManagers = new Set(
    lockArtifacts.map((artifact) => artifact.manager),
  );
  const declarations = collectManagerDeclarations(packageJson);
  if (lockManagers.size > 1) {
    throw new Error(
      `Conflicting package-manager lockfiles: ${[...lockManagers].sort().join(", ")}.`,
    );
  }
  const exact = declarations.find(
    (entry) => entry.source === "package.json packageManager",
  );
  const lockName = [...lockManagers][0];
  if (
    exact !== undefined &&
    lockName !== undefined &&
    exact.name !== lockName
  ) {
    throw new Error(
      `Package-manager metadata selects ${exact.name}, but the lockfile selects ${lockName}.`,
    );
  }
  const lowerDeclarations = declarations.filter((entry) => entry !== exact);
  const lowerNames = new Set(lowerDeclarations.map((entry) => entry.name));
  if (exact === undefined && lockName === undefined && lowerNames.size > 1) {
    throw new Error(
      `Conflicting package-manager metadata: ${[...lowerNames].sort().join(", ")}.`,
    );
  }
  const selectedDeclaration = exact ?? lowerDeclarations[0];
  const name = (exact?.name ??
    lockName ??
    selectedDeclaration?.name ??
    "npm") as SubmittedCodePackageManager;
  if (name !== "pnpm") {
    throw new SubmittedCodeToolchainResolutionError(
      "unsupported_package_manager",
      `Package manager ${name} is not in the ${catalogRevision} active catalog (pnpm 10.27.0, pnpm 11.13.0).`,
    );
  }
  if (lockName === undefined) {
    throw new SubmittedCodeToolchainResolutionError(
      "missing_lockfile",
      "Package manager pnpm requires canonical lock artifact pnpm-lock.yaml before an immutable install can be planned.",
    );
  }
  for (const declaration of declarations) {
    evidence.push({
      kind: "package-manager",
      source: declaration.source,
      value: declaration.version,
    });
  }
  for (const artifact of lockArtifacts) {
    evidence.push({
      kind: "lockfile",
      source: artifact.name,
      value: artifact.manager,
    });
  }
  const versions = supportedPackageManagerVersions[name];
  const selectedConstraint =
    exact ?? lowerDeclarations.find((entry) => entry.name === name);
  const version = selectCatalogVersion(
    name,
    versions,
    selectedConstraint === undefined
      ? []
      : [
          {
            source: selectedConstraint.source,
            value: selectedConstraint.version,
          },
        ],
  );
  for (const declaration of declarations) {
    if (declaration === selectedConstraint) continue;
    const range = validRange(declaration.version);
    if (
      declaration.name === name &&
      range !== null &&
      semverSatisfies(version, range, {
        includePrerelease: false,
        loose: false,
      })
    ) {
      continue;
    }
    warnings.push({
      reason: `Lower-priority package-manager metadata disagrees with ${selectedConstraint?.source ?? lockfileName(name)}.`,
      source: declaration.source,
      value: declaration.version,
    });
  }
  const packageManagerField =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager
      : undefined;
  const corepackHash = packageManagerField?.includes("+")
    ? packageManagerField.slice(packageManagerField.indexOf("+") + 1)
    : undefined;
  return {
    ...(corepackHash === undefined ? {} : { corepackHash }),
    name,
    version,
  };
}

function collectManagerDeclarations(packageJson: PackageJson): Array<{
  name: SubmittedCodePackageManager;
  source: string;
  version: string;
}> {
  const result: Array<{
    name: SubmittedCodePackageManager;
    source: string;
    version: string;
  }> = [];
  const field = packageJson.packageManager;
  if (typeof field === "string") {
    const match =
      /^(bun|npm|pnpm|yarn)@(\d+\.\d+\.\d+)(?:\+(sha(?:224|256|384|512)\.[A-Fa-f0-9]+))?$/.exec(
        field.trim(),
      );
    if (match?.[1] !== undefined && match[2] !== undefined) {
      result.push({
        name: match[1] as SubmittedCodePackageManager,
        source: "package.json packageManager",
        version: match[2],
      });
    } else {
      throw new Error(
        "package.json packageManager must be an exact safe descriptor.",
      );
    }
  }
  for (const name of ["npm", "pnpm", "yarn"] as const) {
    const value = packageJson.engines?.[name];
    if (typeof value === "string" && value.trim() !== "") {
      result.push({
        name,
        source: `package.json engines.${name}`,
        version: value.trim(),
      });
    }
    const volta = packageJson.volta?.[name];
    if (typeof volta === "string" && volta.trim() !== "") {
      result.push({
        name,
        source: `package.json volta.${name}`,
        version: volta.trim(),
      });
    }
  }
  const devManager = packageJson.devEngines?.packageManager;
  if (typeof devManager === "object" && devManager !== null) {
    if (
      (devManager.name === "npm" ||
        devManager.name === "pnpm" ||
        devManager.name === "yarn") &&
      typeof devManager.version === "string"
    ) {
      result.push({
        name: devManager.name,
        source: "package.json devEngines.packageManager",
        version: devManager.version,
      });
    }
  }
  return result;
}

type LockArtifact = {
  manager: SubmittedCodePackageManager;
  name: string;
};

function collectLockArtifacts(
  files: Readonly<Record<string, string>>,
): LockArtifact[] {
  const known = [
    { manager: "pnpm", name: "pnpm-lock.yaml" },
    { manager: "yarn", name: "yarn.lock" },
    { manager: "npm", name: "package-lock.json" },
    { manager: "npm", name: "npm-shrinkwrap.json" },
    { manager: "bun", name: "bun.lock" },
    { manager: "bun", name: "bun.lockb" },
  ] as const;
  return known.filter((artifact) => files[artifact.name] !== undefined);
}

function findDuplicateLockArtifacts(
  artifacts: readonly LockArtifact[],
): LockArtifact[] {
  return artifacts.filter(
    (artifact) =>
      artifacts.filter((other) => other.manager === artifact.manager).length >
      1,
  );
}

function lockfileName(manager: SubmittedCodePackageManager): string {
  if (manager === "pnpm") return "pnpm-lock.yaml";
  if (manager === "yarn") return "yarn.lock";
  if (manager === "bun") return "bun.lock/bun.lockb";
  return "package-lock.json/npm-shrinkwrap.json";
}

function selectCatalogVersion<T extends string>(
  tool: string,
  versions: readonly T[],
  constraints: readonly Constraint[],
): T {
  if (constraints.length === 0) return versions[versions.length - 1] as T;
  for (const constraint of constraints) {
    if (validRange(constraint.value) === null) {
      throw new Error(
        `Invalid ${tool} constraint: ${constraint.source}=${constraint.value}.`,
      );
    }
  }
  const compatible = versions.filter((version) =>
    constraints.every((constraint) => {
      const range = validRange(constraint.value);
      return (
        range !== null &&
        semverSatisfies(version, range, {
          includePrerelease: false,
          loose: false,
        })
      );
    }),
  );
  const selected = compatible[compatible.length - 1];
  if (selected === undefined) {
    throw new SubmittedCodeToolchainResolutionError(
      "unsupported_package_manager_version",
      `${tool} constraints do not intersect the ${catalogRevision} active catalog (${versions.join(", ")}): ${constraints.map((entry) => `${entry.source}=${entry.value}`).join(", ")}.`,
    );
  }
  return selected;
}

export const submittedCodeToolchainCatalog = {
  node: supportedNodeVersions,
  pnpm: supportedPackageManagerVersions.pnpm,
  revision: catalogRevision,
} as const;
