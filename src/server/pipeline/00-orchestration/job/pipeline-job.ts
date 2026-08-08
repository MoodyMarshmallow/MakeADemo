import type { AgentSession } from "../../../agent-harness/agent-session";
import type { DemoBrief } from "../../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../../01-context-gathering/supporting-documents";
import type { RepoSecurityAgentReviewResult } from "../../02-repo-security-screen/agent-review/repo-security-agent-reviewer.interface";
import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../../02-repo-security-screen/repo-security-screen";
import type { PreparedApplicationIdentityReviewResult } from "../../03-prepared-application-identity-review/prepared-application-identity-reviewer.interface";
import type { PreparedWorkspaceDiff } from "../../03-repo-preparation/application-identity-evidence.interface";
import type { ApplicationIdentityBaseline } from "../../03-repo-preparation/application-identity-evidence.interface";
import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceInfrastructureDiagnostic } from "../../03-repo-preparation/preparation-workspace-infrastructure.interface";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspaceResourceDiagnostics } from "../../03-repo-preparation/preparation-workspace.interface";
import type {
  PreparedApplicationIdentityEvidenceSource,
  RepoPreparationFailureKind,
} from "../../03-repo-preparation/repo-preparation-agent.interface";
import type { DemoScript } from "../../04-script-generation/demo-script/demo-script.schema";
import type { CapturePathValidationResult } from "../../05-capture-path-validation/capture-path-validator.interface";
import type { PipelineInfrastructureFailureKind } from "../../pipeline-infrastructure-failure";
import type { PipelineStage } from "./pipeline-observer";

export type PipelineJobInput = {
  applicationIdentityBaseline?: ApplicationIdentityBaseline;
  commitSha: string;
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  repoSecurity: RepoSecurityInput;
  repoUrl: string;
  preparationWorkspace?: PreparationWorkspaceHandle;
  workspaceId: string;
};

export type PipelineJobResult =
  | {
      review?: Extract<
        RepoSecurityAgentReviewResult,
        { status: "succeeded" }
      > & { verdict: "rejected" };
      security: RepoSecurityResult;
      status: "security-rejected";
    }
  | {
      failureKind: PipelineInfrastructureFailureKind;
      failureReason: string;
      identityEvidenceSource?: PreparedApplicationIdentityEvidenceSource;
      identityReview?: Extract<
        PreparedApplicationIdentityReviewResult,
        { status: "failed" }
      >;
      infrastructure?: PreparationWorkspaceInfrastructureDiagnostic;
      resourceDiagnostics?: PreparationWorkspaceResourceDiagnostics;
      stage: PipelineStage;
      status: "infrastructure-failed";
    }
  | {
      fallbackPrompt: string;
      failureKind?: RepoPreparationFailureKind;
      status: "preparation-failed";
    }
  | {
      identityReview: Extract<
        PreparedApplicationIdentityReviewResult,
        { status: "succeeded"; verdict: "fail" }
      >;
      identityEvidenceSource: PreparedApplicationIdentityEvidenceSource;
      status: "identity-review-failed";
    }
  | {
      capturePathValidation: CapturePathValidationResult;
      status: "capture-path-validation-failed";
    }
  | {
      preparationManifest: PreparationManifest;
      agentSession?: AgentSession;
      /** Retained authoritative workspace used by validation, capture, and repair. */
      preparationWorkspace: PreparationWorkspaceHandle;
      capturePathValidation: CapturePathValidationResult;
      identityReview?: Extract<
        PreparedApplicationIdentityReviewResult,
        { status: "succeeded"; verdict: "pass" }
      >;
      identityEvidenceSource: PreparedApplicationIdentityEvidenceSource;
      /** Source authority that every later writable stage must preserve exactly. */
      reviewedPreparedWorkspaceDiff: PreparedWorkspaceDiff;
      status: "succeeded";
      demoScript: DemoScript;
    };
