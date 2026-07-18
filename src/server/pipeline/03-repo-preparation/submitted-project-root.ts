const safeRootSegment = /^[A-Za-z0-9._-]+$/;

/**
 * Validates and normalizes a submitted JavaScript project root.
 * The whole-workspace root is ".", while nested roots must contain only
 * ordinary relative segments and must never include "." or ".." segments.
 */
export function normalizeSubmittedProjectRoot(value: string): string {
  if (value === ".") return value;
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || !safeRootSegment.test(segment),
    )
  ) {
    throw new Error(`Unsafe submitted project root: ${value}`);
  }
  return segments.join("/");
}

/** Resolves a validated submitted project root beneath the fixed workspace. */
export function resolveSubmittedProjectCwd(value: string): string {
  const root = normalizeSubmittedProjectRoot(value);
  return root === "." ? "/workspace" : `/workspace/${root}`;
}
