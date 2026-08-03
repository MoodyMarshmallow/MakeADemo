/**
 * Exact dependency/toolchain cache paths excluded from workspace snapshots.
 * Repository-owned application state, including `.cache`, `.bun`, `.npm`, and
 * `.next/dev/cache`, must remain snapshot state. Every exclusion is
 * backend-owned and relative to the workspace archive root; submitted
 * repositories cannot add exclusions or preserve arbitrary paths.
 */
const generatedWorkspaceCacheDirectories = [
  "node_modules",
  ".vite",
  ".turbo",
  ".pnpm-store",
  ".yarn/cache",
  ".next/cache",
] as const;

export const generatedWorkspaceCachePathPatterns =
  generatedWorkspaceCacheDirectories.flatMap((directory) => [
    `./${directory}`,
    `./${directory}/*`,
    `./*/${directory}`,
    `./*/${directory}/*`,
  ]) as readonly string[];

/** Backend-owned `find` predicates matching the shared generated-cache policy. */
export const generatedWorkspaceCacheFindPredicates =
  generatedWorkspaceCacheDirectories.map(
    (directory) => `-path '*/${directory}'`,
  ) as readonly string[];
