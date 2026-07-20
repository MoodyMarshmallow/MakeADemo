import { join } from "node:path";

import type {
  CaptureManifest,
  CaptureScenesFromScriptInput,
} from "../../06-footage-capture/capture-scenes";
import { captureScenesFromScript } from "../../06-footage-capture/capture-scenes";
import type {
  CompositeVideoFromScriptInput,
  CompositedVideoManifest,
} from "../../07-compositing/composite-video";
import { compositeVideoFromScript } from "../../07-compositing/composite-video";
import {
  DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS,
  type DraftCompositeEvidence,
  collectDraftCompositeQualityFindings,
  inspectDraftCompositeEvidence,
} from "../../07-compositing/draft-composite-quality-review";
import type {
  DraftCompositeReviewDecision,
  DraftCompositeReviewer,
} from "../../07-compositing/draft-composite-reviewer.interface";
import {
  isPipelineCancellationError,
  runSettledPipelineOperation,
  throwIfPipelineDeadlineReached,
} from "./pipeline-cancellation";
import type { PipelineJobInput } from "./pipeline-job";
import { noopPipelineObserver } from "./pipeline-observer";
import {
  runCapturePathValidationAndRepair,
  runPipelineJob,
} from "./pipeline-orchestrator";
import type {
  PipelineOrchestratorDependencies,
  PipelineOrchestratorOptions,
} from "./pipeline-orchestrator";

type PreparedDemoResult = Extract<
  Awaited<ReturnType<typeof runPipelineJob>>,
  { status: "succeeded" }
>;

export type ScriptPersistence = {
  demoRequestId?: string;
  scriptPath?: string;
};

export type DraftCompositeReviewSummary = {
  attempts: number;
  findings: string[];
  status: "accepted" | "exhausted";
  warnings: string[];
};

type DraftCompositeReviewLoopOptions = PipelineOrchestratorOptions & {
  captureScenes?: (
    input: CaptureScenesFromScriptInput,
  ) => Promise<CaptureManifest>;
  compositeVideo?: (
    input: CompositeVideoFromScriptInput,
  ) => Promise<CompositedVideoManifest>;
  evidenceCommandTimeoutMs?: number;
  inspectDraftCompositeEvidence?: (input: {
    captureManifest: CaptureManifest;
    deadlineAt?: number;
    draftComposite: CompositedVideoManifest;
    demoScript: PreparedDemoResult["demoScript"];
    signal?: AbortSignal;
  }) => Promise<DraftCompositeEvidence>;
  prepareFreshCaptureState?: (input: {
    attempt: number;
    browserUrl: string;
    preparedDemo: PreparedDemoResult;
  }) => Promise<{ browserUrl?: string }>;
  reviewDraftComposite?: DraftCompositeReviewer;
};

export type DraftCompositeReviewLoopInput = {
  browserUrl: string;
  dependencies: PipelineOrchestratorDependencies;
  input: PipelineJobInput;
  log: (
    entry: {
      event: string;
      message: string;
      severity?: "debug" | "error" | "info" | "warn";
    } & Record<string, unknown>,
  ) => Promise<void>;
  options: DraftCompositeReviewLoopOptions;
  persistScript: (
    demoScript: PreparedDemoResult["demoScript"],
  ) => Promise<ScriptPersistence>;
  runDirectory: string;
  scriptPersistence: ScriptPersistence;
  preparedDemo: PreparedDemoResult;
};

export type DraftCompositeReviewLoopResult = {
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
  reviewSummary: DraftCompositeReviewSummary;
  scriptPersistence: ScriptPersistence;
  preparedDemo: PreparedDemoResult;
};

type ValidDraftCheckpoint = {
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
  scriptPersistence: ScriptPersistence;
  preparedDemo: PreparedDemoResult;
};

export async function runDraftCompositeReviewLoop(
  input: DraftCompositeReviewLoopInput,
): Promise<DraftCompositeReviewLoopResult> {
  const reviewRepairLimit = readDraftCompositeReviewAttemptLimit();
  const reviewer = input.options.reviewDraftComposite ?? defaultDraftReview;
  let preparedDemo = input.preparedDemo;
  let browserUrl = input.browserUrl;
  let scriptPersistence = input.scriptPersistence;
  let candidateNeedsPersistence = false;
  let latestCaptureManifest: CaptureManifest | undefined;
  let latestFinalVideo: CompositedVideoManifest | undefined;
  let latestFindings: string[] = [];
  let latestRepairReason: string | undefined;
  let validDraftCheckpoint: ValidDraftCheckpoint | undefined;
  let abortedReviewFailure:
    | { attempt: number; failureReason: string; phase: string }
    | undefined;

  for (let attempt = 1; attempt <= reviewRepairLimit + 1; attempt += 1) {
    throwIfPipelineDeadlineReached(
      input.options.signal,
      input.options.deadlineAt,
    );
    let phase = "capture";
    try {
      const runSuffix = String(attempt);
      if (
        input.options.prepareFreshCaptureState === undefined &&
        input.options.captureScenes === undefined
      ) {
        throw new Error(
          "Footage Capture requires a fresh deterministic app-state reset before recording.",
        );
      }
      const freshStateOperation = input.options.prepareFreshCaptureState?.({
        attempt,
        browserUrl,
        preparedDemo,
      });
      const freshState =
        freshStateOperation === undefined
          ? undefined
          : await runSettledPipelineOperation({
              deadlineAt: input.options.deadlineAt,
              onCancel: async () => {
                await preparedDemo.preparationWorkspace?.workspace.cancelActiveCommands?.();
              },
              operation: freshStateOperation,
              signal: input.options.signal,
            });
      throwIfPipelineDeadlineReached(
        input.options.signal,
        input.options.deadlineAt,
      );
      browserUrl = freshState?.browserUrl ?? browserUrl;
      const captureBaseUrl = preparedDemo.preparationManifest.url;
      await emitDraftStageProgress(input, "footage-capture", "started");
      await input.log({
        attempt,
        baseUrl: captureBaseUrl,
        event: "capture-started",
        message: "Footage Capture started.",
        severity: "info",
        ...(scriptPersistence.scriptPath === undefined
          ? { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }
          : { scriptPath: scriptPersistence.scriptPath }),
      });
      const captureStartedAt = Date.now();
      let captureManifest: CaptureManifest;
      try {
        const captureOperation = (
          input.options.captureScenes ?? captureScenesFromScript
        )({
          baseUrl: captureBaseUrl,
          keepTemp: true,
          log: input.log,
          runId: `capture-${runSuffix}`,
          demoScript: preparedDemo.demoScript,
          ...(scriptPersistence.scriptPath === undefined
            ? {}
            : { scriptPath: scriptPersistence.scriptPath }),
          preparationWorkspace: preparedDemo.preparationWorkspace,
          tempRoot: join(input.runDirectory, "capture"),
        });
        captureManifest = await runSettledPipelineOperation({
          deadlineAt: input.options.deadlineAt,
          onCancel: async () => {
            await preparedDemo.preparationWorkspace?.workspace.cancelActiveCommands?.();
          },
          operation: captureOperation,
          signal: input.options.signal,
        });
        throwIfPipelineDeadlineReached(
          input.options.signal,
          input.options.deadlineAt,
        );
      } catch (error) {
        await emitDraftStageProgress(input, "footage-capture", "failed");
        await input.log({
          attempt,
          durationMs: elapsedMs(captureStartedAt),
          error: readErrorMessage(error),
          event: "capture-failed",
          message: "Footage Capture failed.",
          severity: "warn",
        });
        throw error;
      }
      latestCaptureManifest = captureManifest;
      await emitDraftStageProgress(input, "footage-capture", "succeeded");
      await input.log({
        attempt,
        artifacts: {
          manifestPath: captureManifest.manifestPath,
          ...(captureManifest.rawTakePath === undefined
            ? {}
            : { rawTakePath: captureManifest.rawTakePath }),
          sceneVideoPaths: captureManifest.scenes.map(
            (scene) => scene.videoPath,
          ),
        },
        durationMs: elapsedMs(captureStartedAt),
        event: "capture-succeeded",
        manifestPath: captureManifest.manifestPath,
        message: `Footage Capture succeeded: ${captureManifest.scenes.length} scene video(s).`,
        runDirectory: captureManifest.runDirectory,
        sceneCount: captureManifest.scenes.length,
        severity: "info",
      });

      phase = "composite";
      throwIfPipelineDeadlineReached(
        input.options.signal,
        input.options.deadlineAt,
      );
      await emitDraftStageProgress(input, "compositing", "started");
      await input.log({
        attempt,
        captureManifestPath: captureManifest.manifestPath,
        event: "compositing-started",
        message: "Compositing started.",
        severity: "info",
        ...(scriptPersistence.scriptPath === undefined
          ? { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }
          : { scriptPath: scriptPersistence.scriptPath }),
      });
      const compositingStartedAt = Date.now();
      let finalVideo: CompositedVideoManifest;
      try {
        finalVideo = await (
          input.options.compositeVideo ?? compositeVideoFromScript
        )({
          captureManifestPath: captureManifest.manifestPath,
          ...(input.options.deadlineAt === undefined
            ? {}
            : { deadlineAt: input.options.deadlineAt }),
          outputRoot: join(input.runDirectory, "composite"),
          runId: `composite-${runSuffix}`,
          scriptDirectory: input.runDirectory,
          demoScript: preparedDemo.demoScript,
          ...(scriptPersistence.scriptPath === undefined
            ? {}
            : { scriptPath: scriptPersistence.scriptPath }),
          ...(input.options.signal === undefined
            ? {}
            : { signal: input.options.signal }),
        });
        throwIfPipelineDeadlineReached(
          input.options.signal,
          input.options.deadlineAt,
        );
      } catch (error) {
        await emitDraftStageProgress(input, "compositing", "failed");
        await input.log({
          attempt,
          captureManifestPath: captureManifest.manifestPath,
          durationMs: elapsedMs(compositingStartedAt),
          error: readErrorMessage(error),
          event: "compositing-failed",
          message: "Compositing failed.",
          severity: "warn",
        });
        throw error;
      }
      latestFinalVideo = finalVideo;
      await emitDraftStageProgress(input, "compositing", "succeeded");

      if (candidateNeedsPersistence) {
        scriptPersistence = await input.persistScript(preparedDemo.demoScript);
        candidateNeedsPersistence = false;
      }
      validDraftCheckpoint = {
        captureManifest,
        finalVideo,
        scriptPersistence,
        preparedDemo,
      };
      await input.log({
        attempt,
        artifacts: {
          captureManifestPath: captureManifest.manifestPath,
          manifestPath: finalVideo.manifestPath,
          ...(finalVideo.outputVideoPath === undefined
            ? {}
            : { outputVideoPath: finalVideo.outputVideoPath }),
          renderPlanPath: finalVideo.renderPlanPath,
        },
        durationMs: elapsedMs(compositingStartedAt),
        event: "compositing-succeeded",
        manifestPath: finalVideo.manifestPath,
        message: "Compositing succeeded.",
        outputVideoPath: finalVideo.outputVideoPath,
        renderPlanPath: finalVideo.renderPlanPath,
        severity: "info",
        viewUrl: finalVideo.viewUrl,
      });

      phase = "evidence";
      throwIfPipelineDeadlineReached(
        input.options.signal,
        input.options.deadlineAt,
      );
      await emitDraftStageProgress(input, "draft-composite-review", "started");
      const evidenceArtifacts = {
        captureManifestPath: captureManifest.manifestPath,
        compositeManifestPath: finalVideo.manifestPath,
        ...(finalVideo.outputVideoPath === undefined
          ? {}
          : { draftCompositePath: finalVideo.outputVideoPath }),
      };
      const evidenceStartedAt = Date.now();
      await input.log({
        attempt,
        artifacts: evidenceArtifacts,
        event: "draft-composite-evidence-started",
        message: "Draft Composite evidence generation started.",
        severity: "info",
      });
      let draftEvidence: DraftCompositeEvidence;
      try {
        draftEvidence = await readDraftCompositeEvidence({
          captureManifest,
          finalVideo,
          options: input.options,
          demoScript: preparedDemo.demoScript,
        });
        throwIfPipelineDeadlineReached(
          input.options.signal,
          input.options.deadlineAt,
        );
      } catch (error) {
        await emitDraftStageProgress(input, "draft-composite-review", "failed");
        await input.log({
          attempt,
          artifacts: evidenceArtifacts,
          durationMs: elapsedMs(evidenceStartedAt),
          error: readErrorMessage(error),
          event: "draft-composite-evidence-failed",
          message: "Draft Composite evidence generation failed.",
          severity: "warn",
        });
        throw error;
      }
      await input.log({
        attempt,
        artifacts: {
          ...evidenceArtifacts,
          contactSheetPaths: draftEvidence.contactSheetPaths,
          ...(draftEvidence.evidenceManifestPath === undefined
            ? {}
            : { evidenceManifestPath: draftEvidence.evidenceManifestPath }),
          sampledFramePaths: draftEvidence.sampledFramePaths,
        },
        durationMs: elapsedMs(evidenceStartedAt),
        event: "draft-composite-evidence-succeeded",
        failedSceneProbeCount:
          draftEvidence.staticProbeFailedSceneIds?.length ?? 0,
        ffmpegFindingCount: draftEvidence.ffmpegFindings.length,
        message: "Draft Composite evidence generation succeeded.",
        severity: "info",
        staticSceneCount: draftEvidence.staticSceneIds.length,
      });
      latestFindings = collectDraftCompositeQualityFindings({
        captureManifest,
        draftEvidence,
        finalVideo,
        demoScript: preparedDemo.demoScript,
      });

      phase = "reviewer";
      throwIfPipelineDeadlineReached(
        input.options.signal,
        input.options.deadlineAt,
      );
      const reviewerArtifacts = {
        ...evidenceArtifacts,
        ...(captureManifest.rawTakePath === undefined
          ? {}
          : { rawTakePath: captureManifest.rawTakePath }),
      };
      const reviewerStartedAt = Date.now();
      await input.log({
        attempt,
        artifacts: reviewerArtifacts,
        event: "draft-composite-reviewer-started",
        message: "Draft Composite reviewer started.",
        severity: "info",
      });
      let agentDecision: DraftCompositeReviewDecision;
      try {
        agentDecision = await reviewer({
          attempt,
          ...(input.options.deadlineAt === undefined
            ? {}
            : { deadlineAt: input.options.deadlineAt }),
          captureManifest,
          derivedEvidence: {
            contactSheetPaths: draftEvidence.contactSheetPaths,
            draftDurationSeconds: finalVideo.durationInFrames / finalVideo.fps,
            ...(draftEvidence.evidenceManifestPath === undefined
              ? {}
              : { evidenceManifestPath: draftEvidence.evidenceManifestPath }),
            ffmpegFindings: draftEvidence.ffmpegFindings,
            markerSummary: captureManifest.scenes.map((scene) => ({
              durationSeconds: scene.durationSeconds,
              sceneId: scene.sceneId,
            })),
            qualityFindings: latestFindings,
            ...(finalVideo.outputVideoPath === undefined
              ? {}
              : { rawDraftCompositePath: finalVideo.outputVideoPath }),
            ...(captureManifest.rawTakePath === undefined
              ? {}
              : { rawTakePath: captureManifest.rawTakePath }),
            sampledFramePaths: draftEvidence.sampledFramePaths,
          },
          draftComposite: finalVideo,
          ...(preparedDemo.agentSession === undefined
            ? {}
            : { agentSession: preparedDemo.agentSession }),
          ...(preparedDemo.preparationWorkspace === undefined
            ? {}
            : { preparationWorkspace: preparedDemo.preparationWorkspace }),
          ...(input.options.signal === undefined
            ? {}
            : { signal: input.options.signal }),
          demoScript: preparedDemo.demoScript,
        });
        throwIfPipelineDeadlineReached(
          input.options.signal,
          input.options.deadlineAt,
        );
      } catch (error) {
        await emitDraftStageProgress(input, "draft-composite-review", "failed");
        await input.log({
          attempt,
          artifacts: reviewerArtifacts,
          durationMs: elapsedMs(reviewerStartedAt),
          error: readErrorMessage(error),
          event: "draft-composite-reviewer-failed",
          message: "Draft Composite reviewer failed.",
          severity: "warn",
        });
        throw error;
      }
      await input.log({
        attempt,
        artifacts: reviewerArtifacts,
        decision: agentDecision.decision,
        durationMs: elapsedMs(reviewerStartedAt),
        event: "draft-composite-reviewer-succeeded",
        message: "Draft Composite reviewer succeeded.",
        severity: "info",
      });
      const decision: DraftCompositeReviewDecision =
        latestFindings.length > 0
          ? {
              decision: "repair",
              reason: latestFindings.join("; "),
              repairScope: "demo-script",
            }
          : agentDecision;

      await input.log({
        attempt,
        decision: decision.decision,
        event: "draft-composite-review-completed",
        findingCount: latestFindings.length,
        message: `Draft Composite review ${decision.decision}.`,
        severity: decision.decision === "repair" ? "warn" : "info",
        ...(decision.decision === "repair"
          ? { reason: decision.reason, repairScope: decision.repairScope }
          : { reason: decision.reason }),
      });
      await emitDraftStageProgress(
        input,
        "draft-composite-review",
        "succeeded",
      );

      if (decision.decision === "accept") {
        return {
          captureManifest,
          finalVideo,
          reviewSummary: {
            attempts: attempt,
            findings: latestFindings,
            status: "accepted",
            warnings: [],
          },
          scriptPersistence,
          preparedDemo,
        };
      }

      latestRepairReason = decision.reason;
      if (attempt > reviewRepairLimit) {
        break;
      }

      phase = "repair";
      if (decision.repairScope === "workspace") {
        const repairedPreparedDemo = await runPipelineJob(
          input.input,
          input.dependencies,
          input.options,
        );
        if (repairedPreparedDemo.status !== "succeeded") {
          throw new Error(
            `Workspace repair rerun failed with status ${repairedPreparedDemo.status}`,
          );
        }
        preparedDemo = repairedPreparedDemo;
        browserUrl =
          preparedDemo.capturePathValidation.browserUrl ?? browserUrl;
        candidateNeedsPersistence = true;
      } else {
        phase = "repair-revalidation";
        const repairOperation = runCapturePathValidationAndRepair({
          ...(preparedDemo.agentSession === undefined
            ? {}
            : { agentSession: preparedDemo.agentSession }),
          context: {
            ...input.options.context,
            workspaceId: input.input.workspaceId,
          },
          dependencies: input.dependencies,
          ...(input.options.deadlineAt === undefined
            ? {}
            : { deadlineAt: input.options.deadlineAt }),
          demoScript: preparedDemo.demoScript,
          failure: {
            blockedNetworkAttempts: [],
            failureReason: `Draft Composite review requested Demo Script repair: ${decision.reason}`,
            logs: [decision.reason],
            status: "failed",
            warnings: [],
          },
          now: input.options.now ?? Date.now,
          observer: input.options.observer ?? noopPipelineObserver,
          onProgress: input.options.onProgress,
          preparationManifest: preparedDemo.preparationManifest,
          preparationWorkspace: preparedDemo.preparationWorkspace,
          repoUrl: input.input.repoUrl,
          ...(input.options.signal === undefined
            ? {}
            : { signal: input.options.signal }),
        });
        const repairLifecycle = await runSettledPipelineOperation({
          deadlineAt: input.options.deadlineAt,
          onCancel: async () => {
            await preparedDemo.preparationWorkspace?.workspace.cancelActiveCommands?.();
          },
          operation: repairOperation,
          signal: input.options.signal,
        });
        if (repairLifecycle.status === "failed") {
          throw new Error(
            `Demo Script repair failed Capture Path Validation: ${repairLifecycle.capturePathValidation.failureReason ?? repairLifecycle.capturePathValidation.errorMessage ?? "unknown failure"}`,
          );
        }
        preparedDemo = {
          ...preparedDemo,
          demoScript: repairLifecycle.demoScript,
          capturePathValidation: repairLifecycle.capturePathValidation,
          preparationManifest: repairLifecycle.preparationManifest,
        };
        browserUrl =
          repairLifecycle.capturePathValidation.browserUrl ?? browserUrl;
        candidateNeedsPersistence = true;
      }
    } catch (error) {
      if (isPipelineCancellationError(error)) throw error;
      if (validDraftCheckpoint === undefined) {
        throw error;
      }
      abortedReviewFailure = {
        attempt,
        failureReason: readErrorMessage(error),
        phase,
      };
      latestCaptureManifest = validDraftCheckpoint.captureManifest;
      latestFinalVideo = validDraftCheckpoint.finalVideo;
      preparedDemo = validDraftCheckpoint.preparedDemo;
      scriptPersistence = validDraftCheckpoint.scriptPersistence;
      break;
    }
  }

  if (latestCaptureManifest === undefined || latestFinalVideo === undefined) {
    throw new Error("Draft Composite review did not produce a draft.");
  }

  const warnings = [
    abortedReviewFailure === undefined
      ? "Draft Composite review retry limit exceeded; using latest draft."
      : "Draft Composite review could not complete; using latest valid draft.",
    ...(abortedReviewFailure === undefined
      ? []
      : [abortedReviewFailure.failureReason]),
    ...(latestRepairReason === undefined
      ? []
      : [`Draft Composite review requested repair: ${latestRepairReason}`]),
    ...latestFindings.map((finding) => `Remaining quality gate: ${finding}`),
  ];
  if (abortedReviewFailure !== undefined) {
    await input.log({
      attempt: abortedReviewFailure.attempt,
      error: abortedReviewFailure.failureReason,
      event: "draft-composite-review-aborted",
      failureReason: abortedReviewFailure.failureReason,
      fallbackCaptureManifestPath: latestCaptureManifest.manifestPath,
      fallbackCompositeManifestPath: latestFinalVideo.manifestPath,
      fallbackManifestPaths: {
        capture: latestCaptureManifest.manifestPath,
        composite: latestFinalVideo.manifestPath,
      },
      message:
        "Draft Composite review aborted; returning the last valid draft.",
      phase: abortedReviewFailure.phase,
      severity: "warn",
    });
  }
  await input.log({
    event: "draft-composite-review-exhausted",
    message: warnings[0] as string,
    severity: "warn",
    warningCount: warnings.length,
    warnings,
  });

  return {
    captureManifest: latestCaptureManifest,
    finalVideo: latestFinalVideo,
    reviewSummary: {
      attempts: abortedReviewFailure?.attempt ?? reviewRepairLimit + 1,
      findings: latestFindings,
      status: "exhausted",
      warnings,
    },
    scriptPersistence,
    preparedDemo,
  };
}

async function readDraftCompositeEvidence(input: {
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
  options: DraftCompositeReviewLoopOptions;
  demoScript: PreparedDemoResult["demoScript"];
}): Promise<DraftCompositeEvidence> {
  const evidence = await input.options.inspectDraftCompositeEvidence?.({
    captureManifest: input.captureManifest,
    ...(input.options.deadlineAt === undefined
      ? {}
      : { deadlineAt: input.options.deadlineAt }),
    draftComposite: input.finalVideo,
    demoScript: input.demoScript,
    ...(input.options.signal === undefined
      ? {}
      : { signal: input.options.signal }),
  });

  return (
    evidence ??
    (await inspectDraftCompositeEvidence({
      captureManifest: input.captureManifest,
      ...(input.options.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.options.deadlineAt }),
      draftComposite: input.finalVideo,
      ...(input.options.signal === undefined
        ? {}
        : { signal: input.options.signal }),
      timeoutMs:
        input.options.evidenceCommandTimeoutMs ??
        DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS,
    }))
  );
}

async function defaultDraftReview(): Promise<DraftCompositeReviewDecision> {
  throw new Error(
    "Draft Composite review requires a configured reviewer; production runs should pass the retained-agent reviewer.",
  );
}

function readDraftCompositeReviewAttemptLimit() {
  const rawValue = process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return 2;
  }
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return 2;
  }
  return parsedValue;
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Date.now() - startedAt);
}

async function emitDraftStageProgress(
  input: DraftCompositeReviewLoopInput,
  stage: "compositing" | "draft-composite-review" | "footage-capture",
  status: "failed" | "started" | "succeeded",
) {
  await input.options.onProgress?.({ stage, status });
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      errorMessage?: unknown;
      failureReason?: unknown;
      message?: unknown;
    };
    for (const value of [
      candidate.failureReason,
      candidate.errorMessage,
      candidate.message,
    ]) {
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return String(error);
}
