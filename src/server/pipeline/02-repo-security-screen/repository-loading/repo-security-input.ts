import type { RepoSecurityInputLoader } from "./repo-security-input-loader.interface";

/** Loads scanner reports and the retained pinned parent for Stage 02. */
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
  });
}
