import { createHash } from "node:crypto";
import {
  compare,
  major,
  maxSatisfying,
  prerelease,
  satisfies as semverSatisfies,
  valid,
  validRange,
} from "semver";
import {
  type SubmittedCodeNodeFamily,
  type SubmittedCodeNodeReleaseSnapshot,
  submittedCodeNodeCompatibility,
} from "./submitted-code-node-release-catalog.interface";
import { normalizeSubmittedProjectRoot } from "./submitted-project-root";

const catalogRevision = "submitted-js-2026-07-26.1" as const;
const supportedNodeFamilies = [18, 20, 22, 24] as const;
const defaultNodeFamily = 24 as const;
const bunDigestBackedProvisionerRange = ">=1.2.16 <2";

type SubmittedCodePackageManager = "bun" | "npm" | "pnpm" | "yarn";
type SubmittedCodePackageManagerGeneration =
  | "bun-1"
  | "npm-modern"
  | "pnpm-modern"
  | "yarn-berry"
  | "yarn-classic";

const packageManagerSafeDefaults: Record<
  Exclude<SubmittedCodePackageManager, "yarn">,
  readonly string[]
> = {
  bun: ["1.2.22"],
  npm: ["8.19.4", "9.9.4", "10.9.2", "11.6.2"],
  pnpm: ["8.15.9", "9.15.9", "10.27.0", "11.17.0"],
};

const yarnSafeDefaults: Record<
  Extract<SubmittedCodePackageManagerGeneration, "yarn-berry" | "yarn-classic">,
  readonly string[]
> = {
  "yarn-berry": ["2.4.2", "3.8.7", "4.12.0"],
  "yarn-classic": ["1.22.22"],
};

/**
 * A normalized, bounded file view produced by MakeADemo's trusted metadata
 * inspector. Keys must be accepted metadata basenames and values must never
 * exceed the inspector's file-size limit.
 */
type SubmittedCodeCanonicalLockfileEvidence = {
  kind: "canonical-lockfile";
  prefixBase64: string;
  sha256: `sha256:${string}`;
  size: number;
};

type SubmittedCodeToolchainFile =
  | string
  | SubmittedCodeCanonicalLockfileEvidence;

type SubmittedCodeToolchainCandidate = {
  files: Readonly<Record<string, SubmittedCodeToolchainFile>>;
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
 * The immutable install requirement resolved from safe metadata. It is not
 * executable until a trusted artifact provider has hydrated and attested the
 * exact requested package-manager release.
 */
export type SubmittedCodeToolchainPlan = {
  catalogRevision: typeof catalogRevision;
  evidence: readonly SubmittedCodeToolchainEvidence[];
  /** Present only when the package manager has its canonical lockfile. */
  install?: {
    argv: readonly string[];
    executable: string;
  };
  /** A bounded reason an install must be blocked; runtime remains catalog-owned. */
  installBlocker?: {
    code: Exclude<
      SubmittedCodeToolchainResolutionError["code"],
      | "conflicting_node_constraints"
      | "invalid_node_constraint"
      | "unsupported_node_version"
    >;
    reason: string;
  };
  node: {
    family: SubmittedCodeNodeFamily;
    lifecycle: "legacy-eol" | "supported";
    version: string;
  };
  packageManager?: {
    corepackHash?: string;
    generation: SubmittedCodePackageManagerGeneration;
    name: SubmittedCodePackageManager;
    /** Hash of the canonical lockfile in the provider-private plan/runtime binding. */
    projectIntegrity?: `sha256:${string}`;
    version: string;
  };
  projectRoot: string;
  warnings?: readonly SubmittedCodeToolchainWarning[];
};

export class SubmittedCodeToolchainResolutionError extends Error {
  constructor(
    readonly code:
      | "conflicting_node_constraints"
      | "incompatible_node_package_manager"
      | "invalid_node_constraint"
      | "missing_immutable_install"
      | "missing_lockfile"
      | "unsupported_node_version"
      | "unsupported_package_manager"
      | "unsupported_provisioner"
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

type SubmittedCodeNodeClaimRole =
  | "hard-compatibility"
  | "hard-pin"
  | "soft-preference";

/** One normalized metadata claim retained for audit, never for execution. */
type SubmittedCodeToolchainEvidence =
  | {
      kind: "node";
      role: SubmittedCodeNodeClaimRole;
      source: string;
      value: string;
    }
  | {
      kind: "lockfile" | "package-manager" | "project-root";
      source: string;
      value: string;
    };

const metadataFileMaxBytes = 64 * 1024;
const canonicalLockfileMaxBytes = 64 * 1024 * 1024;
const canonicalLockfilePrefixMaxBytes = 64 * 1024;
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
const canonicalLockfileNames = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function isCanonicalLockfileEvidence(
  value: unknown,
): value is SubmittedCodeCanonicalLockfileEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const evidence = value as Partial<SubmittedCodeCanonicalLockfileEvidence>;
  if (
    evidence.kind !== "canonical-lockfile" ||
    typeof evidence.prefixBase64 !== "string" ||
    typeof evidence.sha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(evidence.sha256) ||
    typeof evidence.size !== "number" ||
    !Number.isSafeInteger(evidence.size) ||
    evidence.size < 0 ||
    evidence.size > canonicalLockfileMaxBytes ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      evidence.prefixBase64,
    )
  ) {
    return false;
  }
  const prefix = Buffer.from(evidence.prefixBase64, "base64");
  return (
    prefix.length <= canonicalLockfilePrefixMaxBytes &&
    prefix.length <= evidence.size &&
    prefix.toString("base64") === evidence.prefixBase64
  );
}

function readTextFile(
  files: Readonly<Record<string, SubmittedCodeToolchainFile>>,
  name: string,
): string | undefined {
  const value = files[name];
  return typeof value === "string" ? value : undefined;
}

function readLockfilePrefix(
  value: SubmittedCodeToolchainFile | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  if (!isCanonicalLockfileEvidence(value)) return undefined;
  return Buffer.from(value.prefixBase64, "base64").toString("utf8");
}

/** Resolves safe submitted-project metadata against the revisioned catalog. */
export function resolveSubmittedCodeToolchain(
  metadata: SubmittedCodeToolchainMetadata,
  nodeReleases: SubmittedCodeNodeReleaseSnapshot,
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
    ...nodeConstraints.map(({ role, source, value }) => ({
      kind: "node" as const,
      role,
      source,
      value,
    })),
  );
  const warnings: SubmittedCodeToolchainWarning[] = [];
  const node = resolveNodeVersion(nodeConstraints, nodeReleases, warnings);
  let manager: SubmittedCodeToolchainPlan["packageManager"];
  try {
    manager = resolvePackageManager(
      candidate.files,
      packageJson,
      evidence,
      warnings,
      node.version,
    );
  } catch (error) {
    if (
      error instanceof SubmittedCodeToolchainResolutionError &&
      isPackageManagerResolutionCode(error.code)
    ) {
      return {
        catalogRevision,
        evidence,
        installBlocker: {
          code: error.code,
          reason: installBlockerReason(error.code),
        },
        node,
        projectRoot: candidate.projectRoot,
        warnings,
      };
    }
    throw error;
  }
  if (manager === undefined) {
    throw new Error("Submitted toolchain package manager is missing.");
  }
  const install = readSubmittedPackageManagerPolicy(manager).install;

  return {
    catalogRevision,
    evidence,
    install,
    node,
    packageManager: manager,
    projectRoot: candidate.projectRoot,
    warnings,
  };
}

function installBlockerReason(
  code: Exclude<
    SubmittedCodeToolchainResolutionError["code"],
    | "conflicting_node_constraints"
    | "invalid_node_constraint"
    | "unsupported_node_version"
  >,
): string {
  switch (code) {
    case "incompatible_node_package_manager":
      return "The selected package manager does not support the resolved Node release.";
    case "missing_immutable_install":
      return "The selected package manager has no catalog-owned immutable install.";
    case "missing_lockfile":
      return "The selected package manager requires its canonical lockfile.";
    case "unsupported_package_manager":
      return "The submitted package manager is not available in the active catalog.";
    case "unsupported_provisioner":
      return "The submitted package manager has no verified artifact provisioner.";
    case "unsupported_package_manager_version":
      return "The submitted package-manager version is not available in the active catalog.";
  }
}

function isPackageManagerResolutionCode(
  code: SubmittedCodeToolchainResolutionError["code"],
): code is Exclude<
  SubmittedCodeToolchainResolutionError["code"],
  | "conflicting_node_constraints"
  | "invalid_node_constraint"
  | "unsupported_node_version"
> {
  return ![
    "conflicting_node_constraints",
    "invalid_node_constraint",
    "unsupported_node_version",
  ].includes(code);
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
      if (
        !acceptedMetadataFiles.has(name) ||
        (typeof value !== "string" &&
          (!canonicalLockfileNames.has(name) ||
            !isCanonicalLockfileEvidence(value)))
      ) {
        throw new Error(
          `Unsupported submitted toolchain metadata file: ${name}`,
        );
      }
      if (
        typeof value === "string" &&
        Buffer.byteLength(value) > metadataFileMaxBytes
      ) {
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
type Constraint = {
  role: SubmittedCodeNodeClaimRole;
  source: string;
  value: string;
};

function readPackageJson(
  value: SubmittedCodeToolchainFile | undefined,
): PackageJson {
  if (typeof value !== "string") throw new Error("package.json is required.");
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
  files: Readonly<Record<string, SubmittedCodeToolchainFile>>,
  packageJson: PackageJson,
): Constraint[] {
  const constraints: Constraint[] = [];
  pushStringConstraint(
    constraints,
    "package.json engines.node",
    packageJson.engines?.node,
    "engine",
  );
  pushTrimmedConstraint(
    constraints,
    ".nvmrc",
    readTextFile(files, ".nvmrc"),
    "tool-file",
  );
  pushTrimmedConstraint(
    constraints,
    ".node-version",
    readTextFile(files, ".node-version"),
    "tool-file",
  );
  pushStringConstraint(
    constraints,
    "package.json volta.node",
    packageJson.volta?.node,
    "volta",
  );
  const runtime = packageJson.devEngines?.runtime;
  if (typeof runtime === "object" && runtime !== null) {
    if (runtime.name === undefined || runtime.name === "node") {
      pushStringConstraint(
        constraints,
        "package.json devEngines.runtime.version",
        runtime.version,
        "runtime-engine",
      );
    }
  }
  const toolVersions = readTextFile(files, ".tool-versions");
  if (toolVersions !== undefined) {
    const nodeLine = toolVersions
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find(([name]) => name === "nodejs");
    if (nodeLine?.[1] !== undefined) {
      constraints.push({
        role: classifyNodeClaimRole(
          ".tool-versions nodejs",
          nodeLine.slice(1).join(" "),
          "tool-file",
        ),
        source: ".tool-versions nodejs",
        value: nodeLine.slice(1).join(" "),
      });
    }
  }
  for (const filename of ["mise.toml", ".mise.toml"]) {
    const content = readTextFile(files, filename);
    if (content === undefined) continue;
    const constraint = readMiseNodeConstraint(content);
    if (constraint !== undefined) {
      constraints.push({
        role: classifyNodeClaimRole(
          `${filename} node`,
          constraint,
          "tool-file",
        ),
        source: `${filename} node`,
        value: constraint,
      });
    }
  }
  return constraints;
}

function readMiseNodeConstraint(content: string): string | undefined {
  let inTools = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inTools = trimmed === "[tools]";
      continue;
    }
    if (!inTools || trimmed === "" || trimmed.startsWith("#")) continue;
    const declaration = /^(node|nodejs)\s*=\s*(.+)$/.exec(trimmed);
    if (declaration?.[2] === undefined) continue;
    const encoded = declaration[2].replace(/\s+#.*$/, "").trim();
    const quoted = /^(["'])([^"']+)\1$/.exec(encoded);
    if (quoted?.[2] !== undefined) return quoted[2];
    const array = /^\[(.*)\]$/.exec(encoded);
    if (array?.[1] !== undefined) {
      const entries = array[1].split(",").map((entry) => entry.trim());
      const values = entries.map(
        (entry) => /^(["'])([^"']+)\1$/.exec(entry)?.[2],
      );
      if (
        values.length > 0 &&
        values.every((value): value is string => value !== undefined)
      ) {
        return values.join(" || ");
      }
    }
    return encoded;
  }
  return undefined;
}

function resolveNodeVersion(
  constraints: Constraint[],
  snapshot: SubmittedCodeNodeReleaseSnapshot,
  warnings: SubmittedCodeToolchainWarning[],
): SubmittedCodeToolchainPlan["node"] {
  const hardRanges = constraints
    .filter(({ role }) => role !== "soft-preference")
    .map((constraint) => ({
      ...constraint,
      range:
        constraint.role === "hard-pin"
          ? parseExactStableNodeVersion(constraint)
          : parseStableNodeRange(constraint),
    }));
  const preferences = constraints
    .filter(({ role }) => role === "soft-preference")
    .map((constraint) => ({
      ...constraint,
      family: parseIncompleteNodeFamily(constraint),
    }));
  const releases = snapshot.releases
    .filter(isEligibleNodeRelease)
    .sort((left, right) => compare(right.version, left.version));
  const candidates =
    hardRanges.length === 0
      ? releases.filter((release) => release.family === defaultNodeFamily)
      : releases.filter((release) =>
          hardRanges.every(({ range }) =>
            semverSatisfies(release.version, range, {
              includePrerelease: false,
              loose: false,
            }),
          ),
        );
  const selected = candidates[0];
  if (selected === undefined) {
    const everyClaimHasCandidate = hardRanges.every(({ range }) =>
      releases.some((release) =>
        semverSatisfies(release.version, range, {
          includePrerelease: false,
          loose: false,
        }),
      ),
    );
    const code =
      hardRanges.length > 1 && everyClaimHasCandidate
        ? "conflicting_node_constraints"
        : "unsupported_node_version";
    throw new SubmittedCodeToolchainResolutionError(
      code,
      `Node constraints do not resolve against the active release snapshot: ${
        constraints.length === 0
          ? `default family ${defaultNodeFamily}`
          : constraints
              .map(({ source, value }) => `${source}=${value}`)
              .join(", ")
      }.`,
    );
  }
  for (const preference of preferences) {
    if (preference.family !== selected.family) {
      warnings.push({
        reason: `Selected Node ${selected.version} from hard compatibility constraints instead of the soft Node ${preference.family} preference.`,
        source: preference.source,
        value: preference.value,
      });
    }
  }
  return {
    family: selected.family,
    lifecycle: submittedCodeNodeCompatibility[selected.family].lifecycle,
    version: selected.version,
  };
}

function parseExactStableNodeVersion(constraint: Constraint): string {
  const normalized = constraint.value.replace(/^v(?=\d)/, "");
  if (valid(normalized) !== normalized || prerelease(normalized) !== null) {
    throw new SubmittedCodeToolchainResolutionError(
      "invalid_node_constraint",
      `Invalid exact stable Node constraint: ${constraint.source}=${constraint.value}.`,
    );
  }
  return normalized;
}

function parseIncompleteNodeFamily(constraint: Constraint): number {
  const family = /^v?(\d+)(?:\.x)?$/.exec(constraint.value)?.[1];
  if (family === undefined) {
    throw new SubmittedCodeToolchainResolutionError(
      "invalid_node_constraint",
      `Invalid soft Node preference: ${constraint.source}=${constraint.value}.`,
    );
  }
  return Number(family);
}

function parseStableNodeRange(constraint: Constraint): string {
  const range = validRange(constraint.value, { loose: false });
  if (
    range === null ||
    /(?:^|\s)(?:https?:|git\+|file:)/i.test(constraint.value) ||
    /(?:^|[\s<>=~^|])v?\d+(?:\.\d+){0,2}-[0-9A-Za-z]/.test(constraint.value)
  ) {
    throw new SubmittedCodeToolchainResolutionError(
      "invalid_node_constraint",
      `Invalid stable Node constraint: ${constraint.source}=${constraint.value}.`,
    );
  }
  return range;
}

function isEligibleNodeRelease(
  release: SubmittedCodeNodeReleaseSnapshot["releases"][number],
): boolean {
  if (!supportedNodeFamilies.includes(release.family)) return false;
  if (valid(release.version) !== release.version) return false;
  if (prerelease(release.version) !== null) return false;
  if (major(release.version) !== release.family) return false;
  return semverSatisfies(
    release.version,
    `>=${submittedCodeNodeCompatibility[release.family].compatibilityMinimum}`,
  );
}

function pushStringConstraint(
  constraints: Constraint[],
  source: string,
  value: unknown,
  origin: "engine" | "runtime-engine" | "tool-file" | "volta",
): void {
  if (typeof value === "string" && value.trim() !== "") {
    const normalized = value.trim();
    constraints.push({
      role: classifyNodeClaimRole(source, normalized, origin),
      source,
      value: normalized,
    });
  }
}

function classifyNodeClaimRole(
  _source: string,
  value: string,
  origin: "engine" | "runtime-engine" | "tool-file" | "volta",
): SubmittedCodeNodeClaimRole {
  if (origin === "engine") return "hard-compatibility";
  if (origin === "volta") return "hard-pin";
  const normalized = value.replace(/^v(?=\d)/, "");
  if (valid(normalized) === normalized && prerelease(normalized) === null) {
    return "hard-pin";
  }
  if (origin === "tool-file" && /^v?\d+(?:\.x)?$/.test(value)) {
    return "soft-preference";
  }
  return "hard-compatibility";
}

function pushTrimmedConstraint(
  constraints: Constraint[],
  source: string,
  value: string | undefined,
  origin: "tool-file",
): void {
  if (value !== undefined && value.trim() !== "") {
    const normalized = value.trim();
    constraints.push({
      role: classifyNodeClaimRole(source, normalized, origin),
      source,
      value: normalized,
    });
  }
}

function resolvePackageManager(
  files: Readonly<Record<string, SubmittedCodeToolchainFile>>,
  packageJson: PackageJson,
  evidence: SubmittedCodeToolchainEvidence[],
  warnings: SubmittedCodeToolchainWarning[],
  nodeVersion: string,
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
  if (lockName === undefined) {
    throw new SubmittedCodeToolchainResolutionError(
      "missing_lockfile",
      `Package manager ${name} requires canonical lock artifact ${lockfileName(name)} before an immutable install can be planned.`,
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
  const selectedConstraint =
    exact ?? lowerDeclarations.find((entry) => entry.name === name);
  const yarnGeneration =
    name === "yarn"
      ? inferYarnGeneration(readLockfilePrefix(files["yarn.lock"]))
      : undefined;
  const version = selectPackageManagerVersion(
    name,
    selectedConstraint,
    yarnGeneration,
    nodeVersion,
  );
  const generation = packageManagerGeneration(name, version);
  if (yarnGeneration !== undefined && generation !== yarnGeneration) {
    throw new Error(
      `Yarn lockfile generation selects ${yarnGeneration}, but package-manager metadata selects ${generation}.`,
    );
  }
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
  const projectIntegrity = lockfileIntegrity(lockArtifacts[0], files);
  return {
    ...(corepackHash === undefined ? {} : { corepackHash }),
    generation,
    name,
    ...(projectIntegrity === undefined ? {} : { projectIntegrity }),
    version,
  };
}

function immutableInstallCommand(
  manager: NonNullable<SubmittedCodeToolchainPlan["packageManager"]>,
): {
  argv: readonly string[];
  executable: string;
} {
  if (manager.name === "npm") {
    return { argv: ["ci", "--maxsockets=4"], executable: "npm" };
  }
  if (manager.name === "pnpm") {
    return {
      argv: [
        "install",
        "--frozen-lockfile",
        "--child-concurrency=2",
        "--network-concurrency=4",
      ],
      executable: "pnpm",
    };
  }
  if (manager.name === "bun") {
    return { argv: ["install", "--frozen-lockfile"], executable: "bun" };
  }
  return {
    argv:
      manager.generation === "yarn-classic"
        ? ["install", "--frozen-lockfile", "--network-concurrency", "4"]
        : ["install", "--immutable"],
    executable: "yarn",
  };
}

/**
 * Returns the one backend-owned execution policy for a resolved package
 * manager. Consumers must reject metadata whose version or generation does not
 * match this policy rather than inventing adapter-specific compatibility.
 */
export function readSubmittedPackageManagerPolicy(
  manager: NonNullable<SubmittedCodeToolchainPlan["packageManager"]>,
) {
  if (
    !/^\d+\.\d+\.\d+$/.test(manager.version) ||
    !isCompatiblePackageManagerVersion(manager.name, manager.version)
  ) {
    throw new Error(
      `Unsupported package-manager compatibility generation: ${manager.name}@${manager.version}`,
    );
  }
  if (
    manager.generation !==
    packageManagerGeneration(manager.name, manager.version)
  ) {
    throw new Error(
      `Package-manager generation does not match ${manager.name}@${manager.version}.`,
    );
  }
  return { install: immutableInstallCommand(manager) };
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
      if (match[1] === "bun" && match[3] !== undefined) {
        throw new Error(
          "package.json packageManager must be an exact safe descriptor.",
        );
      }
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
  files: Readonly<Record<string, SubmittedCodeToolchainFile>>,
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

function selectPackageManagerVersion(
  name: SubmittedCodePackageManager,
  declaration: { source: string; version: string } | undefined,
  yarnGeneration:
    | Extract<
        SubmittedCodePackageManagerGeneration,
        "yarn-berry" | "yarn-classic"
      >
    | undefined,
  nodeVersion: string,
): string {
  if (declaration === undefined) {
    return defaultPackageManagerVersion(name, yarnGeneration, nodeVersion);
  }
  const exact = /^\d+\.\d+\.\d+$/.test(declaration.version);
  const range = validRange(declaration.version);
  if (range === null) {
    throw new Error(
      `Invalid ${name} constraint: ${declaration.source}=${declaration.version}.`,
    );
  }
  if (!exact) {
    const safeVersion = maxSatisfying(
      safePackageManagerVersions(name, yarnGeneration).filter((version) =>
        isNodeCompatiblePackageManager(name, version, nodeVersion),
      ),
      range,
      { includePrerelease: false, loose: false },
    );
    if (safeVersion === null) {
      throw new SubmittedCodeToolchainResolutionError(
        name === "bun"
          ? "unsupported_provisioner"
          : "unsupported_package_manager_version",
        `${name} constraint ${declaration.source}=${declaration.version} does not include a revisioned safe default.`,
      );
    }
    return safeVersion;
  }
  if (
    name === "bun" &&
    !semverSatisfies(declaration.version, bunDigestBackedProvisionerRange)
  ) {
    throw new SubmittedCodeToolchainResolutionError(
      "unsupported_provisioner",
      `bun@${declaration.version} predates authoritative GitHub release-asset digests.`,
    );
  }
  if (!isCompatiblePackageManagerVersion(name, declaration.version)) {
    throw new SubmittedCodeToolchainResolutionError(
      "unsupported_package_manager_version",
      `${name}@${declaration.version} is outside the supported ${packageManagerGeneration(name, declaration.version)} compatibility generation.`,
    );
  }
  if (
    name !== "bun" &&
    !isNodeCompatiblePackageManager(name, declaration.version, nodeVersion)
  ) {
    throw new SubmittedCodeToolchainResolutionError(
      "incompatible_node_package_manager",
      `${name}@${declaration.version} does not support Node ${nodeVersion}.`,
    );
  }
  return declaration.version;
}

function defaultPackageManagerVersion(
  name: SubmittedCodePackageManager,
  yarnGeneration:
    | Extract<
        SubmittedCodePackageManagerGeneration,
        "yarn-berry" | "yarn-classic"
      >
    | undefined,
  nodeVersion: string,
): string {
  const versions = safePackageManagerVersions(name, yarnGeneration).filter(
    (version) => isNodeCompatiblePackageManager(name, version, nodeVersion),
  );
  if (versions.length === 0) {
    throw new SubmittedCodeToolchainResolutionError(
      "incompatible_node_package_manager",
      `${name} has no revisioned safe default compatible with Node ${nodeVersion}.`,
    );
  }
  return versions[versions.length - 1] as string;
}

function safePackageManagerVersions(
  name: SubmittedCodePackageManager,
  yarnGeneration:
    | Extract<
        SubmittedCodePackageManagerGeneration,
        "yarn-berry" | "yarn-classic"
      >
    | undefined,
): readonly string[] {
  if (name === "yarn") {
    return yarnSafeDefaults[yarnGeneration ?? "yarn-berry"];
  }
  return packageManagerSafeDefaults[name];
}

function inferYarnGeneration(
  lockfile: string | undefined,
):
  | Extract<
      SubmittedCodePackageManagerGeneration,
      "yarn-berry" | "yarn-classic"
    >
  | undefined {
  if (lockfile === undefined) return undefined;
  if (/^# yarn lockfile v1\b/m.test(lockfile)) return "yarn-classic";
  if (/^__metadata:\s*$/m.test(lockfile)) return "yarn-berry";
  return undefined;
}

function lockfileIntegrity(
  artifact: LockArtifact | undefined,
  files: Readonly<Record<string, SubmittedCodeToolchainFile>>,
): `sha256:${string}` | undefined {
  if (artifact === undefined) return undefined;
  const value = files[artifact.name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value.sha256;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function packageManagerGeneration(
  name: SubmittedCodePackageManager,
  version: string,
): SubmittedCodePackageManagerGeneration {
  const major = Number(version.split(".")[0]);
  if (name === "yarn") return major === 1 ? "yarn-classic" : "yarn-berry";
  if (name === "pnpm") return "pnpm-modern";
  if (name === "npm") return "npm-modern";
  return "bun-1";
}

function isCompatiblePackageManagerVersion(
  name: SubmittedCodePackageManager,
  version: string,
): boolean {
  const ranges: Record<SubmittedCodePackageManager, string> = {
    bun: bunDigestBackedProvisionerRange,
    npm: ">=8 <12",
    pnpm: ">=8 <12",
    yarn: ">=1 <5",
  };
  return semverSatisfies(version, ranges[name], {
    includePrerelease: false,
    loose: false,
  });
}

function isNodeCompatiblePackageManager(
  name: SubmittedCodePackageManager,
  version: string,
  nodeVersion: string,
): boolean {
  if (name === "bun") return true;
  const managerMajor = major(version);
  const ranges: Record<
    Exclude<SubmittedCodePackageManager, "bun">,
    Record<number, string>
  > = {
    npm: {
      8: ">=16",
      9: ">=18",
      10: "^18.17.0 || >=20.5.0",
      11: "^20.17.0 || >=22.9.0",
    },
    pnpm: {
      8: ">=16.14.0",
      9: ">=18.12.0",
      10: ">=18.12.0",
      11: ">=22.13.0",
    },
    yarn: {
      1: ">=4",
      2: ">=10",
      3: ">14.10.0",
      4: ">=18.12.0",
    },
  };
  const range = ranges[name][managerMajor];
  return (
    range !== undefined &&
    semverSatisfies(nodeVersion, range, {
      includePrerelease: false,
      loose: false,
    })
  );
}

export const submittedCodeToolchainCatalog = {
  node: submittedCodeNodeCompatibility,
  packageManagerSafeDefaults,
  revision: catalogRevision,
  yarnSafeDefaults,
} as const;
