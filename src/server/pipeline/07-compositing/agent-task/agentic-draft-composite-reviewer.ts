import { stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AgentTaskRunner } from "../../../agent-harness/agent-session-runner.interface";
import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { throwIfPipelineDeadlineReached } from "../../00-orchestration/job/pipeline-cancellation";
import { createRepoPreparationAgentWorkspace } from "../../03-repo-preparation/agent-task/repo-preparation-agent-workspace";
import type { PreparationWorkspaceUploadOptions } from "../../03-repo-preparation/preparation-workspace.interface";
import type {
  DraftCompositeReviewDecision,
  DraftCompositeReviewerInput,
} from "../draft-composite-reviewer.interface";

const draftCompositeReviewPath =
  "/workspace/.makeademo/draft-composite-review.json";
const draftReviewDirectory = "/workspace/.makeademo/draft-review";

export type AgenticDraftCompositeReviewerOptions = {
  draftReviewEvidenceUploadAttemptTimeoutMs: number;
  draftReviewEvidenceUploadRetryDelaysMs: readonly number[];
  draftReviewEvidenceUploadTimeoutMs: number;
  hardTimeoutMs: number;
  logger: PipelineEventLogger;
  onStatus: (message: string) => void;
  runner: AgentTaskRunner;
  timeoutMs: number;
};

/** Implements the Compositing-stage review contract over a shared agent session. */
export class AgenticDraftCompositeReviewer {
  private readonly options: AgenticDraftCompositeReviewerOptions;

  constructor(options: AgenticDraftCompositeReviewerOptions) {
    this.options = options;
  }

  async review(
    input: DraftCompositeReviewerInput,
  ): Promise<DraftCompositeReviewDecision> {
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (input.agentSession === undefined) {
      throw new Error("Draft Composite review requires an agent session ID.");
    }
    if (input.preparationWorkspace === undefined) {
      throw new Error(
        "Draft Composite review requires the prepared workspace.",
      );
    }

    const workspace = input.preparationWorkspace;
    const hardDeadlineAt = Math.min(
      Date.now() + this.options.hardTimeoutMs,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    const upload = await collectDraftReviewFiles(input);
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    logEvidenceUpload(this.options.logger, {
      bytes: upload.bytes,
      event: "draft-composite-review.evidence-upload.started",
      fileCount: upload.files.length,
    });
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (upload.files.length > 0) {
      try {
        await uploadWithRetry({
          bytes: upload.bytes,
          files: upload.files,
          logger: this.options.logger,
          timeoutMs: boundedTimeout(
            this.options.draftReviewEvidenceUploadTimeoutMs,
            hardDeadlineAt,
          ),
          attemptTimeoutMs: boundedTimeout(
            this.options.draftReviewEvidenceUploadAttemptTimeoutMs,
            hardDeadlineAt,
          ),
          retryDelaysMs: this.options.draftReviewEvidenceUploadRetryDelaysMs,
          upload: (options) =>
            workspace.workspace.uploadFiles(upload.files, options),
        });
      } catch (error) {
        logEvidenceUpload(this.options.logger, {
          bytes: upload.bytes,
          event: "draft-composite-review.evidence-upload.failed",
          fileCount: upload.files.length,
          reason: readErrorMessage(error),
        });
        throw error;
      }
    }
    logEvidenceUpload(this.options.logger, {
      bytes: upload.bytes,
      event: "draft-composite-review.evidence-upload.succeeded",
      fileCount: upload.files.length,
    });
    this.options.onStatus(
      `Draft Composite review attempt ${input.attempt} starting in the retained agent session.`,
    );
    const result = await this.options.runner.run({
      attempt: input.attempt,
      taskPrompt: createDraftCompositeReviewPrompt(input),
      session: input.agentSession,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      stage: "draft-composite-review",
      hardDeadlineAt,
      inactivityTimeoutMs: this.options.timeoutMs,
      hardTimeoutMs: this.options.hardTimeoutMs,
      workspace: createRepoPreparationAgentWorkspace(workspace.workspace),
    });
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (result.exitCode !== 0) {
      throw new Error(
        `Draft Composite review agent task exited with ${result.exitCode}: ${result.failure?.message ?? "agent task failed before artifact validation."}`,
      );
    }
    const readTimeoutMs = boundedTimeout(
      this.options.timeoutMs,
      hardDeadlineAt,
    );
    const artifact = await withTimeout(
      workspace.workspace.execute(
        `cat ${shellQuote(draftCompositeReviewPath)}`,
        {
          timeoutMs: readTimeoutMs,
        },
      ),
      readTimeoutMs,
      `Draft Composite review artifact read timed out after ${readTimeoutMs}ms.`,
    );
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (artifact.exitCode !== 0) {
      throw new Error(
        `Draft Composite review agent task did not write ${draftCompositeReviewPath}: ${artifact.stderr}`,
      );
    }
    return parseDecision(artifact.stdout);
  }
}

function createDraftCompositeReviewPrompt(
  input: DraftCompositeReviewerInput,
): string {
  return [
    "# MakeADemo Draft Composite Review",
    "",
    "Review the Draft Composite generated from the Demo Script in this same agent session.",
    "Use your preparation and Script Generation context, plus the structured evidence below, to decide whether the draft is a good demo video.",
    `Write exactly one JSON artifact to ${draftCompositeReviewPath}.`,
    "",
    "## Required Decision Shape",
    "Accept:",
    "```json",
    JSON.stringify(
      { decision: "accept", reason: "Concise acceptance reason." },
      null,
      2,
    ),
    "```",
    "Repair:",
    "```json",
    JSON.stringify(
      {
        decision: "repair",
        reason: "Concise repair reason.",
        repairScope: "demo-script",
      },
      null,
      2,
    ),
    "```",
    "Use repairScope `demo-script` for script pacing, Scene boundaries, visible outcomes, overlays, music intent, or narrative issues.",
    "Use repairScope `workspace` only when the prepared app or deterministic demo data must change.",
    "Do not request repair only for ffmpeg/contact-sheet/sampled-frame findings unless they reveal an actual demo quality issue. Deterministic quality gates are already supplied separately.",
    "",
    "## Available Local Evidence In Workspace",
    `${draftReviewDirectory} contains uploaded draft/review files when they were available from the backend host.`,
    "You may use shell tools such as ffmpeg/ffprobe against those files if useful.",
    "",
    "## Structured Evidence",
    "```json",
    truncateForPrompt(
      JSON.stringify(
        {
          attempt: input.attempt,
          captureManifest: input.captureManifest,
          derivedEvidence: input.derivedEvidence,
          draftComposite: input.draftComposite,
          scriptId: input.demoScript.scriptId,
          title: input.demoScript.title,
        },
        null,
        2,
      ),
    ),
    "```",
  ].join("\n");
}

function truncateForPrompt(value: string, maxLength = 20_000): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated]`;
}

async function collectDraftReviewFiles(input: DraftCompositeReviewerInput) {
  const paths = [
    ...input.derivedEvidence.contactSheetPaths,
    ...input.derivedEvidence.sampledFramePaths,
    input.derivedEvidence.evidenceManifestPath,
    input.derivedEvidence.rawDraftCompositePath,
  ].filter((path): path is string => path !== undefined);
  const files: Array<{ destinationPath: string; sourcePath: string }> = [];
  let bytes = 0;
  for (const sourcePath of paths) {
    try {
      bytes += (await stat(sourcePath)).size;
      files.push({
        destinationPath: join(draftReviewDirectory, basename(sourcePath)),
        sourcePath,
      });
    } catch {
      // Missing optional evidence is reported through the review prompt.
    }
  }
  return { bytes, files };
}

type EvidenceEvent = {
  bytes: number;
  event:
    | "draft-composite-review.evidence-upload.started"
    | "draft-composite-review.evidence-upload.retrying"
    | "draft-composite-review.evidence-upload.succeeded"
    | "draft-composite-review.evidence-upload.failed";
  fileCount: number;
  uploadAttempt?: number;
  nextAttempt?: number;
  delayMs?: number;
  reason?: string;
};

function logEvidenceUpload(
  logger: PipelineEventLogger,
  entry: EvidenceEvent,
): void {
  try {
    void logger[evidenceUploadSeverity(entry.event)]({
      ...entry,
      stage: "draft-composite-review",
    }).catch(() => undefined);
  } catch {
    // Evidence logging is best effort and must not block review.
  }
}

function evidenceUploadSeverity(
  event: EvidenceEvent["event"],
): "error" | "info" | "warn" {
  if (event === "draft-composite-review.evidence-upload.failed") {
    return "error";
  }
  if (event === "draft-composite-review.evidence-upload.retrying") {
    return "warn";
  }
  return "info";
}

async function uploadWithRetry(input: {
  bytes: number;
  files: Array<{ destinationPath: string; sourcePath: string }>;
  logger: PipelineEventLogger;
  timeoutMs: number;
  attemptTimeoutMs: number;
  retryDelaysMs: readonly number[];
  upload: (options: PreparationWorkspaceUploadOptions) => Promise<void>;
}): Promise<void> {
  const timeoutMessage = `Draft Composite review evidence upload timed out after ${input.timeoutMs}ms.`;
  const deadline = Date.now() + input.timeoutMs;
  for (
    let attempt = 1;
    attempt <= input.retryDelaysMs.length + 1;
    attempt += 1
  ) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(timeoutMessage);
    try {
      await uploadWithTimeout(
        input.upload,
        Math.min(input.attemptTimeoutMs, remaining),
        timeoutMessage,
      );
      return;
    } catch (error) {
      const retryable =
        attempt <= input.retryDelaysMs.length &&
        (isTransientSocketError(error) ||
          (error instanceof Error && error.message === timeoutMessage));
      if (!retryable) throw error;
      const delayMs = input.retryDelaysMs[attempt - 1] ?? 0;
      logEvidenceUpload(input.logger, {
        bytes: input.bytes,
        delayMs,
        event: "draft-composite-review.evidence-upload.retrying",
        fileCount: input.files.length,
        nextAttempt: attempt + 1,
        reason: isTransientSocketError(error)
          ? `Transient Daytona socket closure while uploading Draft Composite review evidence: ${readErrorMessage(error)}`
          : `Draft Composite review evidence attempt timed out: ${readErrorMessage(error)}`,
        uploadAttempt: attempt,
      });
      await withTimeout(wait(delayMs), deadline - Date.now(), timeoutMessage);
    }
  }
}

async function uploadWithTimeout(
  upload: (options: PreparationWorkspaceUploadOptions) => Promise<void>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  const controller = new AbortController();
  const operation = upload({ signal: controller.signal, timeoutMs });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve("timed-out");
      },
      Math.max(1, timeoutMs),
    );
  });
  try {
    const result = await Promise.race([
      operation.then(
        () => "settled" as const,
        (error) => ({ error }) as const,
      ),
      timeout,
    ]);
    if (result === "timed-out") {
      // A retry may start only once the SDK has fully settled the aborted
      // operation; never leave a detached upload running in the background.
      await operation.catch(() => undefined);
      throw new Error(timeoutMessage);
    }
    if (typeof result === "object" && "error" in result) {
      throw result.error;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseDecision(value: string): DraftCompositeReviewDecision {
  const record = JSON.parse(value) as Record<string, unknown>;
  if (record.decision === "accept") {
    return typeof record.reason === "string"
      ? { decision: "accept", reason: record.reason }
      : { decision: "accept" };
  }
  if (
    record.decision === "repair" &&
    typeof record.reason === "string" &&
    (record.repairScope === "demo-script" || record.repairScope === "workspace")
  ) {
    return {
      decision: "repair",
      reason: record.reason,
      repairScope: record.repairScope,
    };
  }
  throw new Error(
    "Draft Composite review artifact must contain accept or repair decision.",
  );
}

function boundedTimeout(timeoutMs: number, hardDeadlineAt: number): number {
  return Math.max(1, Math.min(timeoutMs, hardDeadlineAt - Date.now()));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(message)),
      Math.max(1, timeoutMs),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

function isTransientSocketError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("socket connection was closed") ||
    message.includes("socket was closed") ||
    message.includes("socket closed")
  );
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
