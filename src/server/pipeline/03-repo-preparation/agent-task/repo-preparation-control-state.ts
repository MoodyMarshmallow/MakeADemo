import { isDeepStrictEqual } from "node:util";

import type { RepoPreparationPlaybookId } from "../preparation-mocking-plan.schema";
import type { RepoPreparationAgent } from "../repo-preparation-agent.interface";
import type { RepoPreparationPreflightResult } from "../repo-preparation-preflight.interface";
import type {
  DependencyInstallRequest,
  ValidationRequest,
} from "./repo-preparation-artifact-handoff";

type PreparationResult = Awaited<ReturnType<RepoPreparationAgent["prepare"]>>;

export type RepoPreparationControlState = {
  readSubmittedResult(): PreparationResult | undefined;
  readLoadedPlaybooks(): RepoPreparationPlaybookId[];
  readValidation():
    | { manifest: unknown; runtimePreflight: RepoPreparationPreflightResult }
    | undefined;
  recordValidation(input: {
    manifest: unknown;
    runtimePreflight: RepoPreparationPreflightResult;
  }): void;
  recordLoadedPlaybook(playbook: RepoPreparationPlaybookId): void;
  requestDependencyInstall(input: DependencyInstallRequest): Promise<void>;
  requestValidation(input: ValidationRequest): Promise<void>;
  submit(input: RepoPreparationSubmission): Promise<void>;
  takeDependencyInstallRequest(): DependencyInstallRequest | undefined;
  takeValidationRequest(): ValidationRequest | undefined;
};

type RepoPreparationSubmission =
  | { status: "succeeded" }
  | {
      assumptions: string[];
      blockers: string[];
      status: "failed";
      suggestedChanges: string[];
    };

/**
 * Holds Repo Preparation control decisions in backend memory for one agent
 * task loop. The agent can author the Preparation Manifest in /workspace, but
 * it cannot forge dependency, validation, or final-result authority through
 * workspace files, symlinks, or shell commands.
 */
export function createRepoPreparationControlState(input: {
  baselineSourceControlledPaths: string[];
  readManifest(): Promise<unknown>;
}): RepoPreparationControlState {
  let dependencyInstallRequest: DependencyInstallRequest | undefined;
  const loadedPlaybooks = new Set<RepoPreparationPlaybookId>();
  let submittedResult: PreparationResult | undefined;
  let validation:
    | { manifest: unknown; runtimePreflight: RepoPreparationPreflightResult }
    | undefined;
  let validationRequest: ValidationRequest | undefined;

  return {
    readSubmittedResult: () => submittedResult,
    readLoadedPlaybooks: () => [...loadedPlaybooks],
    readValidation: () => validation,
    recordValidation(value) {
      validation = value;
    },
    recordLoadedPlaybook(playbook) {
      const loadedPlaybookCount = loadedPlaybooks.size;
      loadedPlaybooks.add(playbook);
      if (loadedPlaybooks.size !== loadedPlaybookCount) {
        validation = undefined;
      }
    },
    async requestDependencyInstall(value) {
      dependencyInstallRequest = value;
    },
    async requestValidation(value) {
      validationRequest = value;
    },
    async submit(value) {
      if (value.status === "failed") {
        submittedResult = value;
        return;
      }

      const latestValidation = validation;
      if (
        latestValidation === undefined ||
        latestValidation.runtimePreflight.status !== "succeeded"
      ) {
        throw new Error(
          "Run makeademo_validate_preparation and wait for a passing preparation preflight result before submitting.",
        );
      }

      const currentManifest = await input.readManifest();
      if (validation !== latestValidation) {
        throw new Error(
          "Run makeademo_validate_preparation and wait for a passing preparation preflight result before submitting.",
        );
      }
      if (
        !samePreparationManifest(latestValidation.manifest, currentManifest)
      ) {
        throw new Error(
          "Preparation manifest file must match the latest passed preflight manifest in full.",
        );
      }
      submittedResult = {
        baselineSourceControlledPaths: input.baselineSourceControlledPaths,
        manifest: latestValidation.manifest,
        status: "succeeded",
      };
    },
    takeDependencyInstallRequest() {
      const result = dependencyInstallRequest;
      dependencyInstallRequest = undefined;
      return result;
    },
    takeValidationRequest() {
      const result = validationRequest;
      validationRequest = undefined;
      return result;
    },
  };
}

function samePreparationManifest(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
