import { preparationManifestPath } from "../repo-preparation-artifact-handoff";

/** Provider-neutral contract for a Repo Preparation stage tool. */
export type RepoPreparationToolDefinition = {
  acceptance: string;
  argumentDescription?: string;
  argumentName?: string;
  description: string;
  name: string;
  precondition: string;
};

/**
 * Repo Preparation owns these names, descriptions, schemas, and artifact
 * invariants. Composition adapters may render this contract for a provider,
 * but must not redefine its semantics.
 */
export const repoPreparationToolDefinitions = {
  dependencyRequestInstall: {
    acceptance:
      "The backend selects and runs the plan-owned immutable dependency install before continuing.",
    description: "Request the backend-selected immutable dependency install.",
    name: "makeademo_dependency_request_install",
    precondition:
      "The backend records and validates the request before running the install.",
  },
  dependencyInstallAlias: {
    acceptance:
      "The backend selects and runs the plan-owned immutable dependency install before continuing.",
    description: "Request the backend-selected immutable dependency install.",
    name: "makeademo_install_dependencies",
    precondition:
      "The backend records and validates the request before running the install.",
  },
  submitPreparationResult: {
    acceptance:
      "A succeeded submission is accepted only when the latest passed validation manifest matches the current preparation manifest; a failed submission requires blockers.",
    description:
      "Submit the final Repo Preparation result exactly once after preparation succeeds or is blocked.",
    name: "makeademo_submit_preparation_result",
    precondition:
      "A succeeded submission requires a backend-held passed preflight for the unchanged Preparation Manifest; failed submissions require blockers.",
  },
  validatePreparation: {
    acceptance:
      "The backend reads the requested manifest, runs preparation preflight, and writes validation feedback before the agent continues.",
    argumentDescription: `Preparation Manifest path; must be ${preparationManifestPath}.`,
    argumentName: "manifestPath",
    description:
      "Ask the MakeADemo backend to run preparation preflight and return repair feedback.",
    name: "makeademo_validate_preparation",
    precondition:
      "The backend owns the validation request and its result; the agent receives repair feedback before continuing.",
  },
} as const satisfies Record<string, RepoPreparationToolDefinition>;

export const repoPreparationToolNames = [
  repoPreparationToolDefinitions.dependencyRequestInstall.name,
  repoPreparationToolDefinitions.dependencyInstallAlias.name,
  repoPreparationToolDefinitions.validatePreparation.name,
] as const;

export const repoPreparationSubmitToolName =
  repoPreparationToolDefinitions.submitPreparationResult.name;
