import type { RepoSecurityInput } from "../repo-security-screen";

/**
 * Safe provider-facing context for a Repo Security Screen infrastructure
 * failure. It must never contain a provider error, repository content,
 * sandbox identity, or credential.
 */
export type RepoSecurityInputInfrastructureDiagnostic = Readonly<{
  provider: "railway";
  phase:
    | "template-build-or-create"
    | "command-or-clone"
    | "inventory"
    | "release-settlement";
}>;

/**
 * An optional safe diagnostic a provider may attach before the Pipeline turns
 * a loading failure into its durable, provider-neutral terminal result.
 */
export interface RepoSecurityInputInfrastructureFailure {
  readonly repoSecurityInputInfrastructureDiagnostic: RepoSecurityInputInfrastructureDiagnostic;
}

/** Returns only explicitly safe Repo Security Screen infrastructure context. */
export function readRepoSecurityInputInfrastructureDiagnostic(
  error: unknown,
): RepoSecurityInputInfrastructureDiagnostic | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("repoSecurityInputInfrastructureDiagnostic" in error)
  ) {
    return undefined;
  }
  const diagnostic = (error as Partial<RepoSecurityInputInfrastructureFailure>)
    .repoSecurityInputInfrastructureDiagnostic;
  if (
    diagnostic?.provider !== "railway" ||
    ![
      "template-build-or-create",
      "command-or-clone",
      "inventory",
      "release-settlement",
    ].includes(diagnostic.phase)
  ) {
    return undefined;
  }
  return diagnostic;
}

export type RepoSecurityInputLoadInput = {
  commitSha?: string;
  /** Absolute Pipeline Job deadline shared with repository loading. */
  deadlineAt?: number;
  repoUrl: string;
  /** Cancels repository loading and requires owned workspace release. */
  signal?: AbortSignal;
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
