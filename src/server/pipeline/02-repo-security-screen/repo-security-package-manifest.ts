const excludedPackageRoots = new Set([
  ".git",
  "external",
  "node_modules",
  "third-party",
  "third_party",
  "vendor",
  "vendors",
]);

const safePathComponent = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Identifies package manifests the deterministic Repo Security Screen may
 * inspect. Supported manifests are at the repository root or below at most
 * two ordinary project directories; hidden, vendored, dependency, and deeper
 * trees are deliberately excluded so an unrelated manifest cannot define the
 * submitted application's security result.
 */
export function isRepoSecurityPackageManifestPath(path: string): boolean {
  const normalizedPath = path.replace(/^\.\//, "");
  const components = normalizedPath.split("/");
  if (components.at(-1) !== "package.json" || components.length > 3) {
    return false;
  }

  return components.slice(0, -1).every((component) => {
    const normalizedComponent = component.toLowerCase();
    return (
      safePathComponent.test(component) &&
      !component.startsWith(".") &&
      !excludedPackageRoots.has(normalizedComponent)
    );
  });
}
