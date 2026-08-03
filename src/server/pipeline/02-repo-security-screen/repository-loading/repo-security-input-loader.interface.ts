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
  /** Returns true only for paths whose text Stage 02 authorizes the loader to read. */
  shouldReadText(path: string): boolean;
};

/** Static security evidence plus the untouched pinned parent workspace. */
export type RepoSecurityInputLoadResult = {
  baselineSourceControlledPaths: string[];
  preparationWorkspace: PreparationWorkspaceHandle;
  repoSecurity: RepoSecurityInput;
};

/**
 * Loads static repository metadata for the Repo Security Screen.
 *
 * Implementations must not install dependencies or execute submitted code,
 * must return every inventoried path, and must omit text for any path rejected
 * by `shouldReadText`. Remote adapters must also populate bounded review
 * evidence from that same temporary clone before releasing it; evidence reads
 * may target only the selector-authorized inventory paths.
 */
export interface RepoSecurityInputLoader {
  load(input: RepoSecurityInputLoadInput): Promise<RepoSecurityInputLoadResult>;
}
