import { posix } from "node:path";

import { isRepoSecurityPackageManifestPath } from "../repo-security-package-manifest";

export type RepoSecurityEvidenceLimits = {
  readonly maxEvidenceBytes: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxInventorySamplePaths: number;
};

export const repoSecurityEvidenceLimits = {
  maxEvidenceBytes: 512 * 1_024,
  maxFileBytes: 32 * 1_024,
  maxFiles: 128,
  maxInventorySamplePaths: 128,
} as const satisfies RepoSecurityEvidenceLimits;

const repoSecurityDeterministicManifestLimits = {
  maxBytes: 128 * 32 * 1_024,
  maxFileBytes: 32 * 1_024,
  maxFiles: 128,
} as const;

export type RepoSecurityInventoryFile = {
  path: string;
  sizeBytes: number;
};

export type RepoSecurityEvidenceSelection = {
  files: Array<
    RepoSecurityInventoryFile & {
      excerptLimitBytes: number;
    }
  >;
  inventory: {
    eligibleFileCount: number;
    eligibleSizeBytes: number;
    omittedEligibleFileCount: number;
    omittedEligibleSizeBytes: number;
    sampledPathOmissionCount: number;
    sampledPaths: string[];
    totalFileCount: number;
    totalSizeBytes: number;
  };
  limits: RepoSecurityEvidenceLimits;
};

export type RepoSecurityEvidenceFile = RepoSecurityInventoryFile & {
  excerpt: string;
  excerptBytes: number;
  excerptSha256: string;
  truncated: boolean;
};

/**
 * Bounded, static repository evidence supplied to Stage 02's read-only agent.
 * Every excerpt must come from an inventoried safe path and fit the declared
 * per-file and aggregate limits; omission and truncation are always explicit.
 */
export type RepoSecurityEvidence = {
  coverage: {
    excerptBytes: number;
    omittedEligibleFileCount: number;
    omittedEligibleSizeBytes: number;
    selectedFileCount: number;
    truncatedFileCount: number;
  };
  files: RepoSecurityEvidenceFile[];
  inventory: RepoSecurityEvidenceSelection["inventory"];
  limits: RepoSecurityEvidenceLimits;
};

export type RepoSecurityDeterministicManifestSelection = {
  files: Array<
    RepoSecurityInventoryFile & {
      excerptLimitBytes: number;
    }
  >;
  omittedManifestCount: number;
};

const excludedDirectoryNames = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".turbo",
  "assets",
  "build",
  "cache",
  "coverage",
  "dist",
  "external",
  "images",
  "node_modules",
  "out",
  "public",
  "static",
  "target",
  "third-party",
  "third_party",
  "vendor",
  "vendors",
]);
const evidenceDirectoryNames = new Set(["bin", "scripts", "tools"]);
const executableFileExtensions = new Set([
  ".bash",
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".sh",
  ".ts",
  ".tsx",
  ".zsh",
]);
const privateKeyNames = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const secretExtensions = new Set([".key", ".p12", ".pem", ".pfx"]);
const binaryOrAssetExtensions = new Set([
  ".7z",
  ".a",
  ".avi",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tgz",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

/**
 * Selects deterministic scan manifests independently from the agent evidence
 * budget. Root manifests always precede bounded nested manifests.
 */
export function selectRepoSecurityDeterministicManifestFiles(
  inventory: readonly RepoSecurityInventoryFile[],
): RepoSecurityDeterministicManifestSelection {
  const manifests = normalizeInventory(inventory)
    .filter((file) => isRepoSecurityPackageManifestPath(file.path))
    .sort(compareRootFirst);
  const files: RepoSecurityDeterministicManifestSelection["files"] = [];
  let remainingBytes = repoSecurityDeterministicManifestLimits.maxBytes;

  for (const file of manifests) {
    if (
      files.length >= repoSecurityDeterministicManifestLimits.maxFiles ||
      remainingBytes <= 0
    ) {
      break;
    }
    const excerptLimitBytes = Math.min(
      file.sizeBytes,
      repoSecurityDeterministicManifestLimits.maxFileBytes,
      remainingBytes,
    );
    files.push({ ...file, excerptLimitBytes });
    remainingBytes -= excerptLimitBytes;
  }

  return {
    files,
    omittedManifestCount: manifests.length - files.length,
  };
}

/** Selects the only repository files Stage 02 may read as agent evidence. */
export function selectRepoSecurityEvidenceFiles(
  inventory: readonly RepoSecurityInventoryFile[],
): RepoSecurityEvidenceSelection {
  const normalizedInventory = normalizeInventory(inventory);
  const manifestDirectories = new Set(
    normalizedInventory
      .filter((file) => isRepoSecurityPackageManifestPath(file.path))
      .map((file) => posix.dirname(file.path)),
  );
  const eligible = normalizedInventory
    .map((file) => ({
      file,
      priority: evidencePriority(file.path, manifestDirectories),
    }))
    .filter(
      (entry): entry is { file: RepoSecurityInventoryFile; priority: number } =>
        entry.priority !== undefined,
    )
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        compareRootFirst(left.file, right.file),
    );
  const files: RepoSecurityEvidenceSelection["files"] = [];
  let remainingBytes = repoSecurityEvidenceLimits.maxEvidenceBytes;

  for (const { file } of eligible) {
    if (
      files.length >= repoSecurityEvidenceLimits.maxFiles ||
      remainingBytes <= 0
    ) {
      break;
    }
    const excerptLimitBytes = Math.min(
      file.sizeBytes,
      repoSecurityEvidenceLimits.maxFileBytes,
      remainingBytes,
    );
    files.push({ ...file, excerptLimitBytes });
    remainingBytes -= excerptLimitBytes;
  }

  const selectedPaths = new Set(files.map((file) => file.path));
  const omittedEligible = eligible
    .map(({ file }) => file)
    .filter((file) => !selectedPaths.has(file.path));
  const sampledPaths = normalizedInventory
    .filter((file) => isFilenameSafe(file.path))
    .slice(0, repoSecurityEvidenceLimits.maxInventorySamplePaths)
    .map((file) => file.path);

  return {
    files,
    inventory: {
      eligibleFileCount: eligible.length,
      eligibleSizeBytes: sumBytes(eligible.map(({ file }) => file)),
      omittedEligibleFileCount: omittedEligible.length,
      omittedEligibleSizeBytes: sumBytes(omittedEligible),
      sampledPathOmissionCount:
        normalizedInventory.length - sampledPaths.length,
      sampledPaths,
      totalFileCount: normalizedInventory.length,
      totalSizeBytes: sumBytes(normalizedInventory),
    },
    limits: repoSecurityEvidenceLimits,
  };
}

function evidencePriority(
  path: string,
  manifestDirectories: ReadonlySet<string>,
): number | undefined {
  if (!isSafeEvidencePath(path)) return undefined;
  const components = path.split("/");
  const filename = components.at(-1) ?? "";
  const lowerFilename = filename.toLowerCase();

  if (isRepoSecurityPackageManifestPath(path)) return 0;
  if (isRuntimeConfigurationFilename(lowerFilename) || isWorkflowPath(path)) {
    return 1;
  }
  if (
    components.some((component) =>
      evidenceDirectoryNames.has(component.toLowerCase()),
    )
  ) {
    return 2;
  }
  if (
    manifestDirectories.has(posix.dirname(path)) &&
    executableFileExtensions.has(posix.extname(lowerFilename))
  ) {
    return 3;
  }
  return undefined;
}

function isSafeEvidencePath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    !isFilenameSafe(normalized)
  ) {
    return false;
  }
  const components = normalized.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        excludedDirectoryNames.has(component.toLowerCase()),
    )
  ) {
    return false;
  }
  const filename = components.at(-1)?.toLowerCase() ?? "";
  if (
    filename === ".env" ||
    filename.startsWith(".env.") ||
    privateKeyNames.has(filename)
  ) {
    return false;
  }
  const extension = posix.extname(filename);
  return (
    !secretExtensions.has(extension) && !binaryOrAssetExtensions.has(extension)
  );
}

function isFilenameSafe(path: string): boolean {
  return [...path].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
}

function isRuntimeConfigurationFilename(filename: string): boolean {
  return (
    filename === "dockerfile" ||
    filename.startsWith("dockerfile.") ||
    filename === "makefile" ||
    filename.startsWith("makefile.") ||
    /^(?:docker-)?compose(?:\.[a-z0-9_-]+)?\.ya?ml$/.test(filename)
  );
}

function isWorkflowPath(path: string): boolean {
  const components = path.split("/");
  return (
    components.length === 3 &&
    components[0] === ".github" &&
    components[1] === "workflows" &&
    /\.ya?ml$/i.test(components[2] ?? "")
  );
}

function normalizeInventory(
  inventory: readonly RepoSecurityInventoryFile[],
): RepoSecurityInventoryFile[] {
  return inventory
    .filter(isValidInventoryFile)
    .map((file) => ({
      path: file.path.replace(/^\.\//, ""),
      sizeBytes: file.sizeBytes,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function isValidInventoryFile(file: RepoSecurityInventoryFile): boolean {
  return (
    typeof file.path === "string" &&
    Number.isSafeInteger(file.sizeBytes) &&
    file.sizeBytes >= 0
  );
}

function compareRootFirst(
  left: RepoSecurityInventoryFile,
  right: RepoSecurityInventoryFile,
): number {
  return (
    pathDepth(left.path) - pathDepth(right.path) ||
    left.path.localeCompare(right.path, "en")
  );
}

function sumBytes(files: readonly RepoSecurityInventoryFile[]): number {
  return files.reduce((total, file) => total + file.sizeBytes, 0);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}
