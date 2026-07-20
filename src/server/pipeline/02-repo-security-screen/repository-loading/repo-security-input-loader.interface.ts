import type { RepoSecurityInput } from "../repo-security-screen";

export type RepoSecurityInputLoadInput = {
  commitSha?: string;
  repoUrl: string;
  /** Returns true only for paths whose text Stage 02 authorizes the loader to read. */
  shouldReadText(path: string): boolean;
};

/**
 * Loads static repository metadata for the Repo Security Screen.
 *
 * Implementations must not install dependencies or execute submitted code,
 * must return every inventoried path, and must omit text for any path rejected
 * by `shouldReadText`.
 */
export interface RepoSecurityInputLoader {
  load(input: RepoSecurityInputLoadInput): Promise<RepoSecurityInput>;
}
