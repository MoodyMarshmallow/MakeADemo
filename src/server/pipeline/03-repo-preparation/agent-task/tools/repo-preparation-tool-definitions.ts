import {
  dependencyInstallRequestPath,
  preparationManifestPath,
  preparationResultPath,
  validationRequestPath,
  validationResultPath,
} from "../repo-preparation-artifact-handoff";

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
      "The backend accepts only an allowlisted package-manager install command and writes the request artifact before continuing.",
    argumentDescription:
      "Exact allowlisted dependency install command, such as npm ci --ignore-scripts or pnpm install --frozen-lockfile.",
    argumentName: "command",
    description:
      "Request one backend-controlled dependency install with temporary outbound network access.",
    name: "makeademo_dependency_request_install",
    precondition: `The request is written to ${dependencyInstallRequestPath}; the backend validates the command before execution.`,
  },
  dependencyInstallAlias: {
    acceptance:
      "The backend accepts only an allowlisted package-manager install command and writes the request artifact before continuing.",
    argumentDescription:
      "Exact allowlisted dependency install command, such as npm ci --ignore-scripts or pnpm install --frozen-lockfile.",
    argumentName: "command",
    description:
      "Request one backend-controlled dependency install with temporary outbound network access.",
    name: "makeademo_install_dependencies",
    precondition: `The request is written to ${dependencyInstallRequestPath}; the backend validates the command before execution.`,
  },
  submitPreparationResult: {
    acceptance:
      "A succeeded submission is accepted only when the latest passed validation manifest matches the current preparation manifest; a failed submission requires blockers.",
    description:
      "Submit the final Repo Preparation result exactly once after preparation succeeds or is blocked.",
    name: "makeademo_submit_preparation_result",
    precondition: `A succeeded submission requires a passed validation artifact at ${validationResultPath}; failed submissions require blockers.`,
  },
  validatePreparation: {
    acceptance:
      "The backend reads the requested manifest, runs preparation preflight, and writes validation feedback before the agent continues.",
    argumentDescription: `Preparation Manifest path; must be ${preparationManifestPath}.`,
    argumentName: "manifestPath",
    description:
      "Ask the MakeADemo backend to run preparation preflight and return repair feedback.",
    name: "makeademo_validate_preparation",
    precondition: `The request is written to ${validationRequestPath}; the backend owns validation and writes ${validationResultPath}.`,
  },
} as const satisfies Record<string, RepoPreparationToolDefinition>;

export const repoPreparationToolNames = [
  repoPreparationToolDefinitions.dependencyRequestInstall.name,
  repoPreparationToolDefinitions.dependencyInstallAlias.name,
  repoPreparationToolDefinitions.validatePreparation.name,
] as const;

export const repoPreparationSubmitToolName =
  repoPreparationToolDefinitions.submitPreparationResult.name;

export const repoPreparationArtifactPaths = {
  dependencyInstallRequestPath,
  preparationManifestPath,
  preparationResultPath,
  validationRequestPath,
  validationResultPath,
} as const;

export type RepoPreparationArtifactPaths = {
  [Key in keyof typeof repoPreparationArtifactPaths]: string;
};
