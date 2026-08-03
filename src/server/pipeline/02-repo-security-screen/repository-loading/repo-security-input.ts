import { isRepoSecurityPackageManifestPath } from "../repo-security-package-manifest";
import type { RepoSecurityInputLoader } from "./repo-security-input-loader.interface";

/** Loads Repo Security Screen input while enforcing Stage 02's text policy. */
export function readRepoSecurityInput(
  loader: RepoSecurityInputLoader,
  repoUrl: string,
  options: {
    commitSha: string;
    deadlineAt?: number;
    githubInstallationId?: string;
    repoVisibility?: "private" | "public";
    signal?: AbortSignal;
  },
) {
  return loader.load({
    commitSha: options.commitSha,
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    repoUrl,
    ...(options.repoVisibility === undefined
      ? {}
      : { repoVisibility: options.repoVisibility }),
    ...(options.githubInstallationId === undefined
      ? {}
      : { githubInstallationId: options.githubInstallationId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    shouldReadText: readRepoSecurityInputTextPolicy,
  });
}

/** Allows static screen text only from package manifests and shell scripts. */
export function readRepoSecurityInputTextPolicy(path: string): boolean {
  return isRepoSecurityPackageManifestPath(path) || path.endsWith(".sh");
}
