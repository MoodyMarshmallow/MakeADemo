import { createHash } from "node:crypto";

import type {
  ApplicationIdentityBaseline,
  ApplicationUiIdentityRole,
  PreparedWorkspaceDiff,
} from "./application-identity-evidence.interface";

export const applicationIdentityEvidenceCaps = {
  pathCount: 100_000,
  pathInventoryBytes: 16 * 1024 * 1024,
  uiIdentityIndexBytes: 32 * 1024 * 1024,
  workspaceDiffBytes: 8 * 1024 * 1024,
} as const;

const uiSourceExtensions = new Set([
  ".astro",
  ".html",
  ".htm",
  ".jsx",
  ".svelte",
  ".tsx",
  ".vue",
]);

const uiIdentityRoleOrder: readonly ApplicationUiIdentityRole[] = [
  "route",
  "layout",
  "navigation-shell",
  "feature-root",
  "ui-root",
  "ui-source",
  "source-path",
];

/** Creates backend-owned source identity after validating the pinned Git inventory. */
export function createApplicationIdentityBaseline(input: {
  pinnedRevision: string;
  repoUrl: string;
  sourceControlledPaths: readonly string[];
  sourceTreeObjectId: string;
}): ApplicationIdentityBaseline {
  const pinnedRevision = readGitObjectId(
    input.pinnedRevision,
    "pinnedRevision",
  );
  const sourceTreeObjectId = readGitObjectId(
    input.sourceTreeObjectId,
    "sourceTreeObjectId",
  );
  if (input.repoUrl.trim().length === 0) {
    throw new Error("repoUrl must be non-empty");
  }
  if (
    input.sourceControlledPaths.length >
    applicationIdentityEvidenceCaps.pathCount
  ) {
    throw new Error(
      "Application Identity Baseline path count exceeds its bound.",
    );
  }
  const sourceControlledPaths = input.sourceControlledPaths
    .map(readRepoPath)
    .sort();
  if (new Set(sourceControlledPaths).size !== sourceControlledPaths.length) {
    throw new Error(
      "Application Identity Baseline source paths must be unique.",
    );
  }
  const inventory = Buffer.from(
    sourceControlledPaths.map((path) => `${path}\0`).join(""),
    "utf8",
  );
  if (inventory.length > applicationIdentityEvidenceCaps.pathInventoryBytes) {
    throw new Error(
      "Application Identity Baseline path inventory exceeds its bound.",
    );
  }

  const uiIdentityIndex = createApplicationUiIdentityIndex({
    sourceControlledPaths,
    sourceTreeObjectId,
  });

  return Object.freeze({
    pathInventorySha256: sha256(inventory),
    pinnedRevision,
    repoUrl: input.repoUrl,
    sourceControlledPaths: Object.freeze([...sourceControlledPaths]),
    sourceTreeObjectId,
    uiIdentityIndex,
  });
}

/** Verifies every deterministic digest and UI index field on a baseline. */
export function applicationIdentityBaselineHasValidDigests(
  baseline: ApplicationIdentityBaseline,
): boolean {
  try {
    const expected = createApplicationIdentityBaseline({
      pinnedRevision: baseline.pinnedRevision,
      repoUrl: baseline.repoUrl,
      sourceControlledPaths: baseline.sourceControlledPaths,
      sourceTreeObjectId: baseline.sourceTreeObjectId,
    });
    return applicationIdentityBaselineFieldsMatch(baseline, expected);
  } catch {
    return false;
  }
}

/** Compares complete, internally valid pre-mutation identity baselines. */
export function applicationIdentityBaselinesMatch(
  actual: ApplicationIdentityBaseline,
  expected: ApplicationIdentityBaseline,
): boolean {
  return (
    applicationIdentityBaselineHasValidDigests(actual) &&
    applicationIdentityBaselineHasValidDigests(expected) &&
    applicationIdentityBaselineFieldsMatch(actual, expected)
  );
}

function applicationIdentityBaselineFieldsMatch(
  actual: ApplicationIdentityBaseline,
  expected: ApplicationIdentityBaseline,
): boolean {
  return (
    actual.pathInventorySha256 === expected.pathInventorySha256 &&
    actual.pinnedRevision === expected.pinnedRevision &&
    actual.repoUrl === expected.repoUrl &&
    actual.sourceTreeObjectId === expected.sourceTreeObjectId &&
    actual.sourceControlledPaths.length ===
      expected.sourceControlledPaths.length &&
    actual.sourceControlledPaths.every(
      (path, index) => path === expected.sourceControlledPaths[index],
    ) &&
    actual.uiIdentityIndex.entryCount === expected.uiIdentityIndex.entryCount &&
    actual.uiIdentityIndex.indexSha256 ===
      expected.uiIdentityIndex.indexSha256 &&
    actual.uiIdentityIndex.sizeBytes === expected.uiIdentityIndex.sizeBytes &&
    actual.uiIdentityIndex.entries.length ===
      expected.uiIdentityIndex.entries.length &&
    actual.uiIdentityIndex.entries.every((entry, index) => {
      const expectedEntry = expected.uiIdentityIndex.entries[index];
      return (
        expectedEntry !== undefined &&
        entry.path === expectedEntry.path &&
        entry.roles.length === expectedEntry.roles.length &&
        entry.roles.every(
          (role, roleIndex) => role === expectedEntry.roles[roleIndex],
        )
      );
    })
  );
}

function createApplicationUiIdentityIndex(input: {
  sourceControlledPaths: readonly string[];
  sourceTreeObjectId: string;
}) {
  const entries = input.sourceControlledPaths.map((path) =>
    Object.freeze({
      path,
      roles: Object.freeze(discoverUiIdentityRoles(path)),
    }),
  );
  const canonical = Buffer.from(
    [
      `${input.sourceTreeObjectId}\0`,
      ...entries.map((entry) => `${entry.path}\0${entry.roles.join(",")}\0`),
    ].join(""),
    "utf8",
  );
  if (canonical.length > applicationIdentityEvidenceCaps.uiIdentityIndexBytes) {
    throw new Error("Application UI Identity Index exceeds its content bound.");
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    entryCount: entries.length,
    indexSha256: sha256(canonical),
    sizeBytes: canonical.length,
  });
}

function discoverUiIdentityRoles(path: string): ApplicationUiIdentityRole[] {
  const lowerPath = path.toLowerCase();
  const segments = lowerPath.split("/");
  const fileName = segments.at(-1) ?? "";
  const extensionIndex = fileName.lastIndexOf(".");
  const extension = extensionIndex < 0 ? "" : fileName.slice(extensionIndex);
  const basename =
    extensionIndex < 0 ? fileName : fileName.slice(0, extensionIndex);
  const isUiSource = uiSourceExtensions.has(extension);
  const roles = new Set<ApplicationUiIdentityRole>();

  if (
    ["page", "route", "screen", "view"].includes(basename) ||
    segments.some((segment) =>
      ["pages", "routes", "screens", "views"].includes(segment),
    )
  ) {
    roles.add("route");
  }
  if (["layout", "template"].includes(basename)) roles.add("layout");
  if (
    [
      "app-shell",
      "header",
      "menu",
      "nav",
      "navbar",
      "navigation",
      "shell",
      "sidebar",
    ].includes(basename) ||
    segments.some((segment) => ["nav", "navigation"].includes(segment))
  ) {
    roles.add("navigation-shell");
  }
  if (
    segments.some((segment) =>
      ["feature", "features", "module", "modules"].includes(segment),
    )
  ) {
    roles.add("feature-root");
  }
  if (
    isUiSource &&
    (["app", "main", "root"].includes(basename) ||
      (basename === "index" && segments.length <= 3))
  ) {
    roles.add("ui-root");
  }
  roles.add(isUiSource ? "ui-source" : "source-path");
  return uiIdentityRoleOrder.filter((role) => roles.has(role));
}

/** Creates a content-addressed backend diff after enforcing its complete size bound. */
export function createPreparedWorkspaceDiff(input: {
  createdPaths: readonly string[];
  deletedPaths: readonly string[];
  modifiedPaths: readonly string[];
  patch: string;
}): PreparedWorkspaceDiff {
  const patchBytes = Buffer.from(input.patch, "utf8");
  if (patchBytes.length > applicationIdentityEvidenceCaps.workspaceDiffBytes) {
    throw new Error("Prepared Workspace diff exceeds its content bound.");
  }
  const patchSha256 = sha256(patchBytes);
  return Object.freeze({
    artifactId: `workspace-diff:sha256:${patchSha256}`,
    createdPaths: Object.freeze(input.createdPaths.map(readRepoPath)),
    deletedPaths: Object.freeze(input.deletedPaths.map(readRepoPath)),
    modifiedPaths: Object.freeze(input.modifiedPaths.map(readRepoPath)),
    patch: input.patch,
    patchSha256,
    sizeBytes: patchBytes.length,
  });
}

function readGitObjectId(value: string, name: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new Error(`${name} must be a full Git object ID`);
  }
  return value.toLowerCase();
}

function readRepoPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `Invalid repository evidence path: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
