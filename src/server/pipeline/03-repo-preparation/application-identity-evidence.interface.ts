/** Deterministic discovery labels attached to pinned source paths. */
export type ApplicationUiIdentityRole =
  | "feature-root"
  | "layout"
  | "navigation-shell"
  | "route"
  | "source-path"
  | "ui-root"
  | "ui-source";

/** One pinned source path and its observable UI identity roles. */
type ApplicationUiIdentityEntry = Readonly<{
  path: string;
  roles: readonly ApplicationUiIdentityRole[];
}>;

/** A bounded, content-addressed index of the pinned application's source identity. */
type ApplicationUiIdentityIndex = Readonly<{
  entries: readonly ApplicationUiIdentityEntry[];
  entryCount: number;
  indexSha256: string;
  sizeBytes: number;
}>;

/** Immutable pre-mutation identity captured from an exact pinned Git revision. */
export type ApplicationIdentityBaseline = Readonly<{
  pathInventorySha256: string;
  pinnedRevision: string;
  repoUrl: string;
  sourceControlledPaths: readonly string[];
  sourceTreeObjectId: string;
  uiIdentityIndex: ApplicationUiIdentityIndex;
}>;

/** Complete, bounded workspace mutation evidence captured by the backend. */
export type PreparedWorkspaceDiff = Readonly<{
  artifactId: string;
  createdPaths: readonly string[];
  deletedPaths: readonly string[];
  modifiedPaths: readonly string[];
  patch: string;
  patchSha256: string;
  sizeBytes: number;
}>;
