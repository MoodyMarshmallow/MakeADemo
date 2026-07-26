import type { AgentToolDefinition } from "../../../../agent-harness/agent-session-runner.interface";
import { preparationManifestPath } from "../repo-preparation-artifact-handoff";
import type { RepoPreparationControlState } from "../repo-preparation-control-state";
import {
  repoPreparationSubmitToolName,
  repoPreparationToolDefinitions,
  repoPreparationToolNames,
} from "./repo-preparation-tool-definitions";

type RepoPreparationStageToolArgument = {
  description: string;
  optional?: boolean;
  type: "enum" | "string" | "string[]";
  values?: readonly string[];
};

/** A provider-neutral executable capability owned by Repo Preparation. */
export type RepoPreparationStageTool = AgentToolDefinition & {
  acceptance: string;
  precondition: string;
};

/**
 * Binds Repo Preparation's stage tools to backend-only control state.
 *
 * The returned tools are the only stage-owned capabilities this factory
 * exposes. Their names, validation rules, and authorization invariants remain
 * pipeline-owned while a harness adapter is free to render them for Pi or any
 * future provider.
 */
export function createRepoPreparationStageTools(
  state: RepoPreparationControlState,
): readonly RepoPreparationStageTool[] {
  const validationArgs = {
    manifestPath: {
      description:
        repoPreparationToolDefinitions.validatePreparation
          .argumentDescription ?? "Preparation Manifest path.",
      type: "string" as const,
    },
  };
  const submitArgs = {
    status: {
      description: "Whether Repo Preparation completed successfully.",
      type: "enum" as const,
      values: ["succeeded", "failed"] as const,
    },
    blockers: {
      description: "Required when status is failed. User-actionable blockers.",
      optional: true,
      type: "string[]" as const,
    },
    assumptions: {
      description: "Assumptions made during preparation.",
      optional: true,
      type: "string[]" as const,
    },
    suggestedChanges: {
      description: "Suggested changes for failed preparation.",
      optional: true,
      type: "string[]" as const,
    },
  };

  return [
    createDependencyInstallTool({
      definition: repoPreparationToolDefinitions.dependencyRequestInstall,
      name: repoPreparationToolNames[0],
      state,
    }),
    createDependencyInstallTool({
      definition: repoPreparationToolDefinitions.dependencyInstallAlias,
      name: repoPreparationToolNames[1],
      state,
    }),
    {
      acceptance: repoPreparationToolDefinitions.validatePreparation.acceptance,
      args: validationArgs,
      description:
        repoPreparationToolDefinitions.validatePreparation.description,
      async execute(args) {
        const manifestPath = stringArg(args, "manifestPath");
        assertManifestPath(manifestPath, preparationManifestPath);
        await state.requestValidation({ manifestPath });
        return "Preparation preflight requested. Stop now and wait for MakeADemo preflight feedback before continuing.";
      },
      name: repoPreparationToolNames[2],
      precondition:
        repoPreparationToolDefinitions.validatePreparation.precondition,
    },
    {
      acceptance:
        repoPreparationToolDefinitions.submitPreparationResult.acceptance,
      args: submitArgs,
      description:
        repoPreparationToolDefinitions.submitPreparationResult.description,
      async execute(args) {
        const status = stringArg(args, "status");
        if (status !== "succeeded" && status !== "failed") {
          throw new Error(
            "Repo Preparation status must be succeeded or failed.",
          );
        }

        if (status === "succeeded") {
          await state.submit({ status });
          return `Submitted Repo Preparation ${status} result.`;
        }

        await state.submit({
          assumptions: optionalStringArray(args, "assumptions"),
          blockers: requiredNonEmptyStringArray(args.blockers),
          status,
          suggestedChanges: optionalStringArray(args, "suggestedChanges"),
        });
        return `Submitted Repo Preparation ${status} result.`;
      },
      name: repoPreparationSubmitToolName,
      precondition:
        repoPreparationToolDefinitions.submitPreparationResult.precondition,
    },
  ];
}

function createDependencyInstallTool(input: {
  definition:
    | (typeof repoPreparationToolDefinitions)["dependencyRequestInstall"]
    | (typeof repoPreparationToolDefinitions)["dependencyInstallAlias"];
  name: string;
  state: RepoPreparationControlState;
}): RepoPreparationStageTool {
  return {
    acceptance: input.definition.acceptance,
    args: {},
    description: input.definition.description,
    async execute(args) {
      if (Object.keys(args).length > 0) {
        throw new Error(
          "Dependency install requests do not accept command arguments; the backend selects the immutable install.",
        );
      }
      await input.state.requestDependencyInstall({});
      return "Requested the backend-selected immutable dependency install.";
    },
    name: input.name,
    precondition: input.definition.precondition,
  };
}

function assertManifestPath(path: string, expectedPath: string): void {
  if (path !== expectedPath) {
    throw new Error(`Preparation manifest path must be ${expectedPath}.`);
  }
}

function requiredNonEmptyStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new Error(
      "Failed Repo Preparation submissions require a non-empty blockers array of non-empty strings.",
    );
  }
  return value;
}

function optionalStringArray(
  args: Record<string, unknown>,
  name: string,
): string[] {
  const value = args[name];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(
      `Repo Preparation ${name} must be an array of strings when supplied.`,
    );
  }
  return value;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new Error(`Tool argument ${name} must be a string.`);
  }
  return value;
}
