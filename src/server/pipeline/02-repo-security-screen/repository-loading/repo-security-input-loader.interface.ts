import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { RepoSecurityInput } from "../repo-security-screen";

export type RepoSecurityInputLoadInput = {
  commitSha: string;
  /** Absolute Pipeline Job deadline shared with repository loading. */
  deadlineAt?: number;
  /** Stable GitHub App installation authority; never a credential or token. */
  githubInstallationId?: string;
  repoUrl: string;
  repoVisibility?: "private" | "public";
  /** Cancels repository loading and requires owned workspace release. */
  signal?: AbortSignal;
};

/** Advisory scanner reports plus the untouched pinned parent workspace. */
export type RepoSecurityInputLoadResult = {
  baselineSourceControlledPaths: string[];
  preparationWorkspace: PreparationWorkspaceHandle;
  repoSecurity: RepoSecurityInput;
};

/**
 * Loads static repository metadata for the Repo Security Screen.
 *
 * Implementations must not install dependencies or execute submitted code,
 * must retain the exact pinned parent clone, and must run trusted static
 * scanners there without reading repository files into backend memory.
 */
export interface RepoSecurityInputLoader {
  load(input: RepoSecurityInputLoadInput): Promise<RepoSecurityInputLoadResult>;
}
