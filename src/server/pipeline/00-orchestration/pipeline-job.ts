import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../02-repo-security-screen/repo-security-screen";
import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type {
  AcceptedDemoScript,
  DemoScriptPackage,
} from "../04-script-generation/demo-script-package";
import type { CapturePathValidationResult } from "../05-capture-path-validation/capture-path-validator.interface";

export type PipelineJobInput = {
  commitSha?: string;
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  repoSecurity: RepoSecurityInput;
  repoUrl: string;
  workspaceId: string;
};

export type PipelineJobResult =
  | {
      security: RepoSecurityResult;
      status: "security-rejected";
    }
  | {
      fallbackPrompt: string;
      status: "preparation-failed";
    }
  | {
      capturePathValidation: CapturePathValidationResult;
      status: "capture-path-validation-failed";
    }
  | {
      preparationManifest: PreparationManifest;
      opencodeSessionID?: string;
      /** Retained authoritative workspace used by validation, capture, and repair. */
      preparationWorkspace: PreparationWorkspaceHandle;
      capturePathValidation: CapturePathValidationResult;
      status: "succeeded";
      acceptedDemoScript: AcceptedDemoScript;
      demoScriptPackage: DemoScriptPackage;
    };
