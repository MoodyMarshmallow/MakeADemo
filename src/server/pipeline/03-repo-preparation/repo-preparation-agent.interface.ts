import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type { ProjectValidationResult } from "../05-capture-path-validation/project-runtime-preflight/validation-result";
import type { PreparationManifest } from "./preparation-manifest";
import type { PreparationWorkspaceHandle } from "./preparation-workspace-runner";

export type RepoPreparationInput = {
  commitSha?: string;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  repoUrl: string;
  structuredDemoIntent: DemoBrief;
  workspaceId: string;
};

type RepoPreparationAgentResult =
  | {
      /**
       * Backend-captured source-controlled paths from the submitted pinned
       * repository, collected before Repo Preparation can edit the workspace.
       */
      baselineSourceControlledPaths?: string[];
      manifest: unknown;
      opencodeSessionID?: string;
      status: "succeeded";
      validation?: ProjectValidationResult;
      workspace?: PreparationWorkspaceHandle;
    }
  | {
      assumptions: string[];
      blockers: string[];
      status: "failed";
      suggestedChanges: string[];
    };

/**
 * Prepares an ephemeral cloned workspace for deterministic demo validation.
 * Implementations may edit and execute only that workspace, should check for
 * existing demos before creating new setup, must check out commitSha when one is
 * supplied, must capture the submitted source-controlled path baseline before
 * edits, and must not modify the source repo.
 */
export interface RepoPreparationAgent {
  prepare(input: RepoPreparationInput): Promise<RepoPreparationAgentResult>;
}

export type RepoPreparationResult =
  | {
      manifest: PreparationManifest;
      opencodeSessionID?: string;
      status: "succeeded";
      validation?: ProjectValidationResult;
      workspace?: PreparationWorkspaceHandle;
    }
  | {
      fallbackPrompt: string;
      status: "failed";
    };
