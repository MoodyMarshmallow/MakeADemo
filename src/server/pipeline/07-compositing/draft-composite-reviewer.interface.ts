import type { AgentSession } from "../../agent-harness/agent-session";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScript } from "../04-script-generation/demo-script/demo-script.schema";
import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "./composite-video";

export type DraftCompositeReviewDecision =
  | {
      decision: "accept";
      reason?: string;
    }
  | {
      decision: "repair";
      reason: string;
      repairScope: "demo-script" | "workspace";
    };

export type DraftCompositeReviewerInput = {
  attempt: number;
  captureManifest: CaptureManifest;
  derivedEvidence: {
    contactSheetPaths: string[];
    draftDurationSeconds?: number;
    evidenceManifestPath?: string;
    ffmpegFindings: string[];
    markerSummary: Array<Record<string, unknown>>;
    qualityFindings: string[];
    rawDraftCompositePath?: string;
    rawTakePath?: string;
    sampledFramePaths: string[];
  };
  draftComposite: CompositedVideoManifest;
  agentSession?: AgentSession;
  preparationWorkspace?: PreparationWorkspaceHandle;
  demoScript: DemoScript;
};

/**
 * Reviews a Draft Composite and returns an explicit final acceptance or bounded
 * repair scope. Implementations should only use the supplied evidence and
 * preserve the same-session context when one is provided.
 */
export type DraftCompositeReviewer = (
  input: DraftCompositeReviewerInput,
) => Promise<DraftCompositeReviewDecision>;
