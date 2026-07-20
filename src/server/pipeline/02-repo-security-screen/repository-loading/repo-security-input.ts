import type { RepoSecurityInput } from "../repo-security-screen";
import type { RepoSecurityInputLoader } from "./repo-security-input-loader.interface";

/** Loads Repo Security Screen input while enforcing Stage 02's text policy. */
export function readRepoSecurityInput(
  loader: RepoSecurityInputLoader,
  repoUrl: string,
  options: { commitSha?: string } = {},
): Promise<RepoSecurityInput> {
  return loader.load({
    ...(options.commitSha === undefined
      ? {}
      : { commitSha: options.commitSha }),
    repoUrl,
    shouldReadText: readRepoSecurityInputTextPolicy,
  });
}

/** Allows static screen text only from package manifests and shell scripts. */
export function readRepoSecurityInputTextPolicy(path: string): boolean {
  return path === "package.json" || path.endsWith(".sh");
}
