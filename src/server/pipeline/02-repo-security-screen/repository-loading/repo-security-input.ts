import type { RepoSecurityInput } from "../repo-security-screen";
import type { RepoSecurityInputLoader } from "./repo-security-input-loader.interface";

/** Loads Repo Security Screen input while enforcing Stage 02's text policy. */
export function readRepoSecurityInput(
  loader: RepoSecurityInputLoader,
  repoUrl: string,
  options: {
    commitSha?: string;
    deadlineAt?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RepoSecurityInput> {
  return loader.load({
    ...(options.commitSha === undefined
      ? {}
      : { commitSha: options.commitSha }),
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    repoUrl,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    shouldReadText: readRepoSecurityInputTextPolicy,
  });
}

/** Allows static screen text only from package manifests and shell scripts. */
export function readRepoSecurityInputTextPolicy(path: string): boolean {
  return path === "package.json" || path.endsWith(".sh");
}
