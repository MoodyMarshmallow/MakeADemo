import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";

export type BrowserAction =
  | { kind: "check" | "click" | "hover" | "uncheck"; ref: string }
  | { kind: "fill"; ref: string; text: string }
  | { kind: "press"; key: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "type"; text: string };

export type BrowserInspectionKind = "console" | "requests" | "snapshot";

export type BrowserToolFailureKind =
  | "cli-error"
  | "invalid-cli-output"
  | "navigation-outside-demo-origin"
  | "output-too-large";

/** Stable provider-neutral browser failure returned across agent adapters. */
export class BrowserToolError extends Error {
  constructor(
    readonly failureKind: BrowserToolFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "BrowserToolError";
  }
}

/** The constrained browser capability exposed to a single retained workspace. */
export interface BrowserToolController {
  act(input: BrowserAction): Promise<{ output: string }>;
  inspect(input: { kind: BrowserInspectionKind }): Promise<{
    kind: BrowserInspectionKind;
    output: string;
  }>;
  navigate(input: { path: string }): Promise<{ output: string; url: string }>;
  reset(): Promise<void>;
  screenshot(input?: {
    fullPage?: boolean;
    target?: string;
  }): Promise<{ path: string; sizeBytes: number }>;
  updateContext(input: {
    deadlineAt: number | undefined;
    localUrl: string;
    signal?: AbortSignal;
  }): void;
}

/** Backend-owned context which can be refreshed across retained Pipeline Stages. */
type BrowserToolControllerContext = {
  deadlineAt: number | undefined;
  localUrl: string;
  signal?: AbortSignal;
};

export type BrowserToolControllerInput = BrowserToolControllerContext & {
  workspace: PreparationWorkspace;
};
