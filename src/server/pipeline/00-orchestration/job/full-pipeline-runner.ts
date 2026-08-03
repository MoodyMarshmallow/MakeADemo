import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type PipelineLogSink,
  createFilePipelineLogSink,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";
import {
  type PreparationWorkspaceInfrastructureDiagnostic,
  readPreparationWorkspaceInfrastructureDiagnostic,
} from "../../03-repo-preparation/preparation-workspace-infrastructure.interface";
import type { DemoRequestScriptStore } from "../../04-script-generation/demo-request-script-store.interface";
import type { RuntimeNetworkPolicy } from "../../05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";
import type {
  CaptureManifest,
  CaptureScenesFromScriptInput,
} from "../../06-footage-capture/capture-scenes";
import type {
  CompositeVideoFromScriptInput,
  CompositedVideoManifest,
} from "../../07-compositing/composite-video";
import type { DraftCompositeEvidence } from "../../07-compositing/draft-composite-quality-review";
import type { DraftCompositeReviewer } from "../../07-compositing/draft-composite-reviewer.interface";
import type {
  FinalVideoPublicationWarning,
  FinalVideoPublisher,
} from "../../07-compositing/final-video-publisher.interface";
import type { PipelineInfrastructureFailureKind } from "../../pipeline-infrastructure-failure";
import {
  type DraftCompositeReviewSummary,
  type ScriptPersistence,
  runDraftCompositeReviewLoop,
} from "./draft-composite-review-loop";
import {
  type PipelineCancellationReason,
  isPipelineCancellationError,
  runSettledPipelineOperation,
  throwIfPipelineDeadlineReached,
} from "./pipeline-cancellation";
import type { PipelineJobInput } from "./pipeline-job";
import { runPipelineJob } from "./pipeline-orchestrator";
import type {
  PipelineOrchestratorDependencies,
  PipelineOrchestratorOptions,
} from "./pipeline-orchestrator";

export type FullPipelineResult = {
  captureManifest: CaptureManifest;
  draftCompositeReview: DraftCompositeReviewSummary;
  finalVideo: CompositedVideoManifest;
  logPath: string;
  resultPath: string;
  sandboxProvider?: "daytona";
  sandboxLogPath?: string;
  scriptPath?: string;
  preparedDemo: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >;
  publicationWarnings?: FinalVideoPublicationWarning[];
  status: "succeeded";
};

export type FullPipelineFailureContext = {
  cause?: unknown;
  failure: FullPipelineFailure;
  logPath: string;
  agentAuditLogPath: string | undefined;
  resultPath: string;
  stage: "pipeline" | "repo-security-screen";
  status:
    | Exclude<
        Awaited<ReturnType<typeof runPipelineJob>>,
        { status: "succeeded" }
      >["status"]
    | "cancelled";
};

type PreparationWorkspaceCleanupMetadata = {
  status: "failed";
  workspaces: Array<{
    infrastructure?: PreparationWorkspaceInfrastructureDiagnostic;
    workspaceId: string;
  }>;
};

type FullPipelineFailure =
  | (ReturnType<typeof readPipelineFailure> & {
      cleanup?: PreparationWorkspaceCleanupMetadata;
    })
  | (ReturnType<typeof createRepoSecurityInputFailureSummary>["failure"] & {
      cleanup?: PreparationWorkspaceCleanupMetadata;
    })
  | (ReturnType<typeof createUnexpectedFailureSummary>["failure"] & {
      cleanup?: PreparationWorkspaceCleanupMetadata;
    })
  | (ReturnType<
      typeof createPreparationWorkspaceCleanupFailureSummary
    >["failure"] & {
      cleanup?: PreparationWorkspaceCleanupMetadata;
    });

export class FullPipelineStageFailure extends Error {
  readonly failure: FullPipelineFailureContext["failure"];
  readonly logPath: string;
  readonly agentAuditLogPath: string | undefined;
  readonly resultPath: string;
  readonly stage: FullPipelineFailureContext["stage"];
  readonly status: FullPipelineFailureContext["status"];
  override readonly cause?: unknown;

  constructor(context: FullPipelineFailureContext) {
    super(`Pipeline failed with status ${context.status}`);
    this.name = "FullPipelineStageFailure";
    this.failure = context.failure;
    this.logPath = context.logPath;
    this.agentAuditLogPath = context.agentAuditLogPath;
    this.cause = context.cause;
    this.resultPath = context.resultPath;
    this.stage = context.stage;
    this.status = context.status;
  }
}

type PreparedDemoResult = Extract<
  Awaited<ReturnType<typeof runPipelineJob>>,
  { status: "succeeded" }
>;

type FullPipelineArtifactSummary = {
  artifacts: {
    captureManifestPath: string;
    compositeManifestPath: string;
    finalVideoPath: string;
    generatedScriptDemoRequestId?: string;
    generatedScriptPath?: string;
    logPath: string;
    renderPlanPath: string;
    scriptGenerationAuditLogPath?: string;
    sandboxLogPath?: string;
    viewUrl: string;
  };
  draftCompositeReview: DraftCompositeReviewSummary;
  runDirectory: string;
  runId: string;
  sandboxProvider?: "daytona";
  publicationWarnings?: FinalVideoPublicationWarning[];
  script: {
    sceneCount: number;
    scriptId: string;
    title: string;
  };
  status: "ready-for-publication" | "succeeded";
};

type FullPipelineLogEntry = {
  event: string;
  message: string;
  time: string;
} & Record<string, unknown>;

type FullPipelineLogSeverity = "debug" | "error" | "info" | "warn";

type FullPipelineLogInput = {
  event: string;
  message: string;
  severity?: FullPipelineLogSeverity;
} & Record<string, unknown>;

const cleanupLogTimeoutMs = 50;

export type FullPipelineRunnerOptions = PipelineOrchestratorOptions & {
  captureScenes?: (
    input: CaptureScenesFromScriptInput,
  ) => Promise<CaptureManifest>;
  compositeVideo?: (
    input: CompositeVideoFromScriptInput,
  ) => Promise<CompositedVideoManifest>;
  demoRequestScriptStore?: DemoRequestScriptStore;
  /** Maximum duration for each ffmpeg or ffprobe evidence command. */
  evidenceCommandTimeoutMs?: number;
  finalVideoPublisher?: FinalVideoPublisher;
  onLog?: (entry: FullPipelineLogEntry) => void;
  logSinks?: PipelineLogSink[];
  outputRoot?: string;
  agentAuditLogPath?: string;
  reviewDraftComposite?: DraftCompositeReviewer;
  inspectDraftCompositeEvidence?: (input: {
    captureManifest: CaptureManifest;
    draftComposite: CompositedVideoManifest;
    demoScript: PreparedDemoResult["demoScript"];
  }) => Promise<DraftCompositeEvidence>;
  prepareFreshCaptureState?: (input: {
    attempt: number;
    browserUrl: string;
    preparedDemo: PreparedDemoResult;
  }) => Promise<{ browserUrl?: string }>;
  /** Controller-owned marker for a failed Repo Security input infrastructure load. */
  repoSecurityInputFailure?: true;
  runId?: string;
  /** Controller-owned provider provenance persisted in terminal summaries. */
  sandboxProvider?: "daytona";
  /** Composition-owned browser/runtime public-egress policy. */
  runtimeNetworkPolicy?: RuntimeNetworkPolicy;
  sandboxLogPath?: string;
  scriptGenerationAuditLogPath?: string;
};

export async function runFullPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
  options: FullPipelineRunnerOptions = {},
): Promise<FullPipelineResult> {
  const outputRoot = options.outputRoot ?? ".makeademo-full-pipeline-runs";
  const runId = options.runId ?? createRunId();
  const runDirectory = join(outputRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  const logPath = join(runDirectory, "pipeline-log.jsonl");
  const sandboxLogPath = options.sandboxLogPath;
  const log = createPipelineLogger(logPath, {
    extraSinks: options.logSinks ?? [],
    onLog: options.onLog,
  });
  const preparationWorkspaces = new Set<
    NonNullable<PreparedDemoResult["preparationWorkspace"]>
  >();
  const approvedPreparationWorkspaces = new Set<
    NonNullable<PreparedDemoResult["preparationWorkspace"]>
  >();
  if (input.preparationWorkspace !== undefined) {
    preparationWorkspaces.add(input.preparationWorkspace);
  }
  const orchestratorDependencies: PipelineOrchestratorDependencies = {
    ...dependencies,
    async prepareRepo(preparationInput) {
      const result = await dependencies.prepareRepo(preparationInput);
      if (result.status === "succeeded" && result.workspace !== undefined) {
        preparationWorkspaces.add(result.workspace);
        approvedPreparationWorkspaces.add(result.workspace);
      }
      return result;
    },
  };
  let terminalFailureLogged = false;
  let terminalFailure: FullPipelineStageFailure | undefined;
  let pendingArtifactSummary: FullPipelineArtifactSummary | undefined;
  const reportPipelineProgress: NonNullable<
    PipelineOrchestratorOptions["onProgress"]
  > = async (event) => {
    await options.onProgress?.(event);
    await log({
      event: "stage-progress",
      message: `${event.stage} ${event.status}.`,
      severity: severityForPipelineStageStatus(event.status),
      stage: event.stage,
      status: event.status,
    });
  };
  const pipelineOptions: FullPipelineRunnerOptions = {
    ...options,
    onProgress: reportPipelineProgress,
  };

  const completed = await (async () => {
    try {
      await log({
        event: "pipeline-started",
        message: "Full pipeline started.",
        outputRoot,
        repoUrl: input.repoUrl,
        runDirectory,
        runId,
        severity: "info",
        workspaceId: input.workspaceId,
      });
      throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);

      if (options.repoSecurityInputFailure !== undefined) {
        const resultPath = join(runDirectory, "full-pipeline-result.json");
        const failureSummary = createRepoSecurityInputFailureSummary({
          agentAuditLogPath: options.agentAuditLogPath,
          logPath,
          runDirectory,
          runId,
          sandboxLogPath,
          sandboxProvider: options.sandboxProvider,
          scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
        });
        await reportPipelineProgress({
          stage: "repo-security-screen",
          status: "failed",
        });
        await log({
          event: "pipeline-failed",
          message: "Repo Security Screen input loading failed.",
          severity: "error",
          stage: "repo-security-screen",
          status: "infrastructure-failed",
        });
        terminalFailureLogged = true;
        await writeFile(
          resultPath,
          `${JSON.stringify(failureSummary, null, 2)}\n`,
        );
        await log({
          event: "result-written",
          message: "Full pipeline failure result written.",
          resultPath,
          severity: "info",
        });
        throw new FullPipelineStageFailure({
          failure: failureSummary.failure,
          logPath,
          agentAuditLogPath: options.agentAuditLogPath,
          resultPath,
          stage: "repo-security-screen",
          status: "infrastructure-failed",
        });
      }

      const initialPreparedDemo = await runPipelineJob(
        input,
        orchestratorDependencies,
        pipelineOptions,
      );
      if (initialPreparedDemo.status !== "succeeded") {
        const status = initialPreparedDemo.status;
        const resultPath = join(runDirectory, "full-pipeline-result.json");
        const failureSummary = createFailureSummary({
          logPath,
          agentAuditLogPath: options.agentAuditLogPath,
          runDirectory,
          runId,
          sandboxLogPath,
          sandboxProvider: options.sandboxProvider,
          scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
          preparedDemo: initialPreparedDemo,
        });
        await log({
          event: "pipeline-failed",
          message: `Pipeline failed with status ${initialPreparedDemo.status}.`,
          severity: "error",
          status,
        });
        terminalFailureLogged = true;
        await writeFile(
          resultPath,
          `${JSON.stringify(failureSummary, null, 2)}\n`,
        );
        await log({
          event: "result-written",
          message: "Full pipeline failure result written.",
          resultPath,
          severity: "info",
        });
        throw new FullPipelineStageFailure({
          failure: failureSummary.failure,
          logPath,
          agentAuditLogPath: options.agentAuditLogPath,
          resultPath,
          stage: "pipeline",
          status,
        });
      }

      let preparedDemo: PreparedDemoResult = initialPreparedDemo;

      const browserUrl = preparedDemo.capturePathValidation.browserUrl;
      if (browserUrl === undefined || browserUrl.trim().length === 0) {
        await log({
          event: "pipeline-failed",
          message: "Capture Path Validation did not return a browser URL.",
          severity: "error",
        });
        throw new Error(
          "Capture Path Validation did not return a browser URL.",
        );
      }

      let scriptSummary = summarizeDemoScript(preparedDemo.demoScript);
      let scriptPersistence = await persistGeneratedScript({
        demoRequestId: options.context?.demoRequestId,
        log,
        runDirectory,
        demoScript: preparedDemo.demoScript,
        scriptStore: options.demoRequestScriptStore,
        scriptSummary,
      });

      const reviewResult = await runDraftCompositeReviewLoop({
        browserUrl,
        dependencies: orchestratorDependencies,
        input,
        log,
        options: pipelineOptions,
        runDirectory,
        persistScript: (demoScript) =>
          persistGeneratedScript({
            demoRequestId: options.context?.demoRequestId,
            log,
            runDirectory,
            demoScript,
            scriptStore: options.demoRequestScriptStore,
            scriptSummary: summarizeDemoScript(demoScript),
          }),
        scriptPersistence,
        preparedDemo,
      });
      throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
      preparedDemo = reviewResult.preparedDemo;
      scriptSummary = summarizeDemoScript(preparedDemo.demoScript);
      scriptPersistence = reviewResult.scriptPersistence;
      const { captureManifest, reviewSummary } = reviewResult;
      const finalVideo = reviewResult.finalVideo;
      await writeDraftCompositeReviewMetadata({
        finalVideo,
        reviewSummary,
      });
      const resultPath = join(runDirectory, "full-pipeline-result.json");
      const artifactSummary: FullPipelineArtifactSummary = {
        artifacts: {
          captureManifestPath: captureManifest.manifestPath,
          compositeManifestPath: finalVideo.manifestPath,
          finalVideoPath: finalVideo.outputVideoPath ?? finalVideo.viewUrl,
          ...(scriptPersistence.demoRequestId === undefined
            ? {}
            : {
                generatedScriptDemoRequestId: scriptPersistence.demoRequestId,
              }),
          ...(scriptPersistence.scriptPath === undefined
            ? {}
            : { generatedScriptPath: scriptPersistence.scriptPath }),
          logPath,
          ...(options.agentAuditLogPath === undefined
            ? {}
            : { agentAuditLogPath: options.agentAuditLogPath }),
          renderPlanPath: finalVideo.renderPlanPath,
          ...(sandboxLogPath === undefined ? {} : { sandboxLogPath }),
          ...(options.scriptGenerationAuditLogPath === undefined
            ? {}
            : {
                scriptGenerationAuditLogPath:
                  options.scriptGenerationAuditLogPath,
              }),
          viewUrl: finalVideo.viewUrl,
        },
        draftCompositeReview: reviewSummary,
        runDirectory,
        runId,
        ...(options.sandboxProvider === undefined
          ? {}
          : { sandboxProvider: options.sandboxProvider }),
        script: {
          sceneCount: scriptSummary.sceneCount,
          scriptId: preparedDemo.demoScript.scriptId,
          title: preparedDemo.demoScript.title,
        },
        status: "ready-for-publication",
      };
      pendingArtifactSummary = artifactSummary;
      await log({
        event: "pipeline-ready-for-publication",
        message:
          "Full pipeline bookkeeping completed before final publication.",
        severity: "info",
        viewUrl: finalVideo.viewUrl,
      });
      await writeFile(
        resultPath,
        `${JSON.stringify(artifactSummary, null, 2)}\n`,
      );
      await log({
        event: "result-written",
        message: "Full pipeline result written.",
        resultPath,
        severity: "info",
      });
      const result: FullPipelineResult = {
        captureManifest,
        draftCompositeReview: reviewSummary,
        finalVideo,
        logPath,
        resultPath,
        ...(options.sandboxProvider === undefined
          ? {}
          : { sandboxProvider: options.sandboxProvider }),
        ...(sandboxLogPath === undefined ? {} : { sandboxLogPath }),
        ...(scriptPersistence.scriptPath === undefined
          ? {}
          : { scriptPath: scriptPersistence.scriptPath }),
        preparedDemo,
        status: "succeeded",
      };
      return result;
    } catch (error) {
      if (isPipelineCancellationError(error)) {
        const resultPath = join(runDirectory, "full-pipeline-result.json");
        const cleanup = await cleanupPreparationWorkspaces({
          approvedHandles: approvedPreparationWorkspaces,
          handles: preparationWorkspaces,
          log,
        });
        const infrastructure =
          readPreparationWorkspaceInfrastructureDiagnostic(error);
        const cancellationSummary = createCancellationSummary({
          agentAuditLogPath: options.agentAuditLogPath,
          cancellationReason: error.reason,
          cleanup,
          ...(infrastructure === undefined ? {} : { infrastructure }),
          logPath,
          runDirectory,
          runId,
          sandboxLogPath,
          sandboxProvider: options.sandboxProvider,
          scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
        });
        logBestEffort(log, {
          cancellationReason: error.reason,
          event: "pipeline-cancelled",
          message: error.message,
          severity: "warn",
          status: "cancelled",
        });
        terminalFailureLogged = true;
        await writeFile(
          resultPath,
          `${JSON.stringify(cancellationSummary, null, 2)}\n`,
        );
        preparationWorkspaces.clear();
        logBestEffort(log, {
          event: "result-written",
          message: "Full pipeline cancellation result written.",
          resultPath,
          severity: "info",
        });
        const failure = new FullPipelineStageFailure({
          failure: cancellationSummary.failure,
          logPath,
          agentAuditLogPath: options.agentAuditLogPath,
          resultPath,
          stage: "pipeline",
          status: "cancelled",
        });
        terminalFailure = failure;
        throw failure;
      }
      if (!terminalFailureLogged) {
        const resultPath = join(runDirectory, "full-pipeline-result.json");
        const failureSummary = createUnexpectedFailureSummary({
          agentAuditLogPath: options.agentAuditLogPath,
          logPath,
          runDirectory,
          runId,
          sandboxLogPath,
          sandboxProvider: options.sandboxProvider,
          scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
        });
        await log({
          error: readErrorMessage(error),
          event: "pipeline-failed",
          message: "Full pipeline failed unexpectedly.",
          severity: "error",
        });
        terminalFailureLogged = true;
        await writeFile(
          resultPath,
          `${JSON.stringify(failureSummary, null, 2)}\n`,
        );
        await log({
          event: "result-written",
          message: "Full pipeline failure result written.",
          resultPath,
          severity: "info",
        });
        const failure = new FullPipelineStageFailure({
          cause: error,
          failure: failureSummary.failure,
          logPath,
          agentAuditLogPath: options.agentAuditLogPath,
          resultPath,
          stage: "pipeline",
          status: "infrastructure-failed",
        });
        terminalFailure = failure;
        throw failure;
      }
      if (error instanceof FullPipelineStageFailure) {
        terminalFailure = error;
      }
      throw error;
    }
  })().then(
    (result) => ({ result, status: "succeeded" as const }),
    (error: unknown) => ({ error, status: "failed" as const }),
  );
  const cleanup = await cleanupPreparationWorkspaces({
    approvedHandles: approvedPreparationWorkspaces,
    handles: preparationWorkspaces,
    log,
  });
  if (cleanup !== undefined && completed.status === "succeeded") {
    const failureSummary = createPreparationWorkspaceCleanupFailureSummary({
      agentAuditLogPath: options.agentAuditLogPath,
      cleanup,
      logPath,
      runDirectory,
      runId,
      sandboxLogPath,
      sandboxProvider: options.sandboxProvider,
      scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
    });
    logBestEffort(log, {
      event: "pipeline-failed",
      message:
        "Preparation Workspace release failed after all Pipeline stages completed.",
      severity: "error",
      status: "infrastructure-failed",
    });
    await writeFile(
      completed.result.resultPath,
      `${JSON.stringify(failureSummary, null, 2)}\n`,
    );
    logBestEffort(log, {
      event: "result-written",
      message: "Full pipeline failure result written.",
      resultPath: completed.result.resultPath,
      severity: "info",
    });
    throw new FullPipelineStageFailure({
      failure: failureSummary.failure,
      logPath,
      agentAuditLogPath: options.agentAuditLogPath,
      resultPath: completed.result.resultPath,
      stage: "pipeline",
      status: "infrastructure-failed",
    });
  }
  if (cleanup !== undefined && terminalFailure !== undefined) {
    const failure = withPreparationWorkspaceCleanupMetadata(
      terminalFailure.failure,
      cleanup,
    );
    await writePreparationWorkspaceCleanupMetadata({
      cleanup,
      resultPath: terminalFailure.resultPath,
    });
    throw new FullPipelineStageFailure({
      ...(terminalFailure.cause === undefined
        ? {}
        : { cause: terminalFailure.cause }),
      failure,
      logPath: terminalFailure.logPath,
      agentAuditLogPath: terminalFailure.agentAuditLogPath,
      resultPath: terminalFailure.resultPath,
      stage: terminalFailure.stage,
      status: terminalFailure.status,
    });
  }
  if (completed.status === "failed") throw completed.error;
  try {
    throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
    const finalVideoPublisher = options.finalVideoPublisher;
    let publicationCommitted = finalVideoPublisher === undefined;
    const publication = finalVideoPublisher
      ? await (async () => {
          const operation = finalVideoPublisher.publishFinalVideo({
            ...(options.deadlineAt === undefined
              ? {}
              : { deadlineAt: options.deadlineAt }),
            draftComposite: completed.result.finalVideo,
            onPublicationCommitted() {
              publicationCommitted = true;
            },
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          try {
            return await runSettledPipelineOperation({
              deadlineAt: options.deadlineAt,
              onCancel: async () => undefined,
              operation,
              signal: options.signal,
            });
          } catch (error) {
            if (!publicationCommitted || !isPipelineCancellationError(error)) {
              throw error;
            }
            return await operation;
          }
        })()
      : { finalVideo: completed.result.finalVideo, warnings: [] };
    const { finalVideo, warnings: publicationWarnings } = publication;
    const artifactSummary = pendingArtifactSummary;
    if (artifactSummary === undefined) {
      throw new Error(
        "Full pipeline publication bookkeeping was not prepared.",
      );
    }
    const publishedArtifactSummary: FullPipelineArtifactSummary = {
      ...artifactSummary,
      artifacts: {
        ...artifactSummary.artifacts,
        compositeManifestPath: finalVideo.manifestPath,
        finalVideoPath: finalVideo.outputVideoPath ?? finalVideo.viewUrl,
        renderPlanPath: finalVideo.renderPlanPath,
        viewUrl: finalVideo.viewUrl,
      },
      ...(publicationWarnings.length === 0 ? {} : { publicationWarnings }),
      status: "succeeded",
    };
    await writeFile(
      completed.result.resultPath,
      `${JSON.stringify(publishedArtifactSummary, null, 2)}\n`,
    );
    await log({
      event: "pipeline-succeeded",
      message: "Full pipeline succeeded.",
      severity: "info",
      viewUrl: finalVideo.viewUrl,
    });
    await log({
      event: "result-written",
      message: "Full pipeline result written after final publication.",
      resultPath: completed.result.resultPath,
      severity: "info",
    });
    return {
      ...completed.result,
      finalVideo,
      ...(publicationWarnings.length === 0 ? {} : { publicationWarnings }),
    };
  } catch (error) {
    if (isPipelineCancellationError(error)) {
      const cancellationSummary = createCancellationSummary({
        agentAuditLogPath: options.agentAuditLogPath,
        cancellationReason: error.reason,
        cleanup: undefined,
        logPath,
        runDirectory,
        runId,
        sandboxLogPath,
        sandboxProvider: options.sandboxProvider,
        scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
      });
      await writeFile(
        completed.result.resultPath,
        `${JSON.stringify(cancellationSummary, null, 2)}\n`,
      );
      logBestEffort(log, {
        cancellationReason: error.reason,
        event: "pipeline-cancelled",
        message: error.message,
        severity: "warn",
        status: "cancelled",
      });
      throw new FullPipelineStageFailure({
        failure: cancellationSummary.failure,
        logPath,
        agentAuditLogPath: options.agentAuditLogPath,
        resultPath: completed.result.resultPath,
        stage: "pipeline",
        status: "cancelled",
      });
    }

    const failureSummary = createUnexpectedFailureSummary({
      agentAuditLogPath: options.agentAuditLogPath,
      logPath,
      runDirectory,
      runId,
      sandboxLogPath,
      sandboxProvider: options.sandboxProvider,
      scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
    });
    await log({
      error: readErrorMessage(error),
      event: "pipeline-failed",
      message: "Final publication failed.",
      severity: "error",
    });
    await writeFile(
      completed.result.resultPath,
      `${JSON.stringify(failureSummary, null, 2)}\n`,
    );
    throw new FullPipelineStageFailure({
      cause: error,
      failure: failureSummary.failure,
      logPath,
      agentAuditLogPath: options.agentAuditLogPath,
      resultPath: completed.result.resultPath,
      stage: "pipeline",
      status: "infrastructure-failed",
    });
  }
}

function createCancellationSummary(input: {
  agentAuditLogPath: string | undefined;
  cancellationReason: PipelineCancellationReason;
  cleanup: PreparationWorkspaceCleanupMetadata | undefined;
  infrastructure?: PreparationWorkspaceInfrastructureDiagnostic;
  logPath: string;
  runDirectory: string;
  runId: string;
  sandboxLogPath: string | undefined;
  sandboxProvider: "daytona" | undefined;
  scriptGenerationAuditLogPath: string | undefined;
}) {
  const blocker =
    input.cancellationReason === "deadline-exceeded"
      ? "Pipeline deadline exceeded before the full Pipeline Job completed."
      : "Pipeline cancelled by process signal before the full Pipeline Job completed.";
  const failure = {
    blockers: [blocker],
    suggestedChanges: [],
    ...(input.infrastructure === undefined
      ? {}
      : { infrastructure: input.infrastructure }),
  } as FullPipelineFailure;
  return {
    artifacts: {
      logPath: input.logPath,
      ...(input.agentAuditLogPath === undefined
        ? {}
        : { agentAuditLogPath: input.agentAuditLogPath }),
      ...(input.scriptGenerationAuditLogPath === undefined
        ? {}
        : { scriptGenerationAuditLogPath: input.scriptGenerationAuditLogPath }),
      ...(input.sandboxLogPath === undefined
        ? {}
        : { sandboxLogPath: input.sandboxLogPath }),
    },
    cancellation: { reason: input.cancellationReason },
    failure:
      input.cleanup === undefined
        ? failure
        : withPreparationWorkspaceCleanupMetadata(failure, input.cleanup),
    runDirectory: input.runDirectory,
    runId: input.runId,
    ...(input.sandboxProvider === undefined
      ? {}
      : { sandboxProvider: input.sandboxProvider }),
    status: "cancelled" as const,
  };
}

function createRepoSecurityInputFailureSummary(input: {
  agentAuditLogPath: string | undefined;
  logPath: string;
  runDirectory: string;
  runId: string;
  sandboxLogPath: string | undefined;
  sandboxProvider: "daytona" | undefined;
  scriptGenerationAuditLogPath: string | undefined;
}) {
  return {
    artifacts: {
      logPath: input.logPath,
      ...(input.agentAuditLogPath === undefined
        ? {}
        : { agentAuditLogPath: input.agentAuditLogPath }),
      ...(input.scriptGenerationAuditLogPath === undefined
        ? {}
        : {
            scriptGenerationAuditLogPath: input.scriptGenerationAuditLogPath,
          }),
      ...(input.sandboxLogPath === undefined
        ? {}
        : { sandboxLogPath: input.sandboxLogPath }),
    },
    failure: {
      blockers: [
        "Repo Security Screen input could not be loaded because sandbox infrastructure was unavailable.",
      ],
      failureKind:
        "sandbox-infrastructure-failed" satisfies PipelineInfrastructureFailureKind,
      suggestedChanges: [],
    },
    runDirectory: input.runDirectory,
    runId: input.runId,
    ...(input.sandboxProvider === undefined
      ? {}
      : { sandboxProvider: input.sandboxProvider }),
    status: "infrastructure-failed" as const,
  };
}

function createUnexpectedFailureSummary(input: {
  agentAuditLogPath: string | undefined;
  logPath: string;
  runDirectory: string;
  runId: string;
  sandboxLogPath: string | undefined;
  sandboxProvider: "daytona" | undefined;
  scriptGenerationAuditLogPath: string | undefined;
}) {
  return {
    artifacts: {
      logPath: input.logPath,
      ...(input.agentAuditLogPath === undefined
        ? {}
        : { agentAuditLogPath: input.agentAuditLogPath }),
      ...(input.scriptGenerationAuditLogPath === undefined
        ? {}
        : { scriptGenerationAuditLogPath: input.scriptGenerationAuditLogPath }),
      ...(input.sandboxLogPath === undefined
        ? {}
        : { sandboxLogPath: input.sandboxLogPath }),
    },
    failure: {
      blockers: [
        "Full Pipeline infrastructure failed unexpectedly. Please report this issue to MakeADemo.",
      ],
      failureKind:
        "unexpected-pipeline-error" satisfies PipelineInfrastructureFailureKind,
      suggestedChanges: [],
    },
    runDirectory: input.runDirectory,
    runId: input.runId,
    ...(input.sandboxProvider === undefined
      ? {}
      : { sandboxProvider: input.sandboxProvider }),
    status: "infrastructure-failed" as const,
  };
}

function createPreparationWorkspaceCleanupFailureSummary(input: {
  agentAuditLogPath: string | undefined;
  cleanup: PreparationWorkspaceCleanupMetadata;
  logPath: string;
  runDirectory: string;
  runId: string;
  sandboxLogPath: string | undefined;
  sandboxProvider: "daytona" | undefined;
  scriptGenerationAuditLogPath: string | undefined;
}) {
  return {
    artifacts: {
      logPath: input.logPath,
      ...(input.agentAuditLogPath === undefined
        ? {}
        : { agentAuditLogPath: input.agentAuditLogPath }),
      ...(input.scriptGenerationAuditLogPath === undefined
        ? {}
        : { scriptGenerationAuditLogPath: input.scriptGenerationAuditLogPath }),
      ...(input.sandboxLogPath === undefined
        ? {}
        : { sandboxLogPath: input.sandboxLogPath }),
    },
    failure: {
      blockers: [
        "Preparation Workspace release could not be confirmed after the Pipeline completed. Demo artifacts are inconclusive.",
      ],
      cleanup: input.cleanup,
      failureKind:
        "preparation-workspace-cleanup-failed" satisfies PipelineInfrastructureFailureKind,
      suggestedChanges: [],
    },
    runDirectory: input.runDirectory,
    runId: input.runId,
    ...(input.sandboxProvider === undefined
      ? {}
      : { sandboxProvider: input.sandboxProvider }),
    status: "infrastructure-failed" as const,
  };
}

async function cleanupPreparationWorkspaces(input: {
  approvedHandles: ReadonlySet<
    NonNullable<PreparedDemoResult["preparationWorkspace"]>
  >;
  handles: Iterable<NonNullable<PreparedDemoResult["preparationWorkspace"]>>;
  log: (entry: FullPipelineLogInput) => Promise<void>;
}): Promise<PreparationWorkspaceCleanupMetadata | undefined> {
  const workspaces: PreparationWorkspaceCleanupMetadata["workspaces"] = [];
  for (const handle of input.handles) {
    const startedAt = Date.now();
    const release = input.approvedHandles.has(handle)
      ? handle.release()
      : (handle.discard?.() ?? handle.release());
    logBestEffort(input.log, {
      event: "preparation-workspace-cleanup.started",
      message: "Preparation workspace cleanup started.",
      severity: "info",
      workspaceId: handle.id,
    });

    try {
      await release;
      await logBestEffort(input.log, {
        durationMs: Date.now() - startedAt,
        event: "preparation-workspace-cleanup.succeeded",
        message: "Preparation workspace cleanup succeeded.",
        severity: "info",
        workspaceId: handle.id,
      });
    } catch (error) {
      const infrastructure =
        readPreparationWorkspaceInfrastructureDiagnostic(error);
      workspaces.push({
        ...(infrastructure === undefined ? {} : { infrastructure }),
        workspaceId: handle.id,
      });
      await logBestEffort(input.log, {
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error),
        event: "preparation-workspace-cleanup.failed",
        message: "Preparation workspace cleanup failed.",
        severity: "warn",
        workspaceId: handle.id,
      });
    }
  }
  return workspaces.length === 0 ? undefined : { status: "failed", workspaces };
}

function withPreparationWorkspaceCleanupMetadata(
  failure: FullPipelineFailure,
  cleanup: PreparationWorkspaceCleanupMetadata,
): FullPipelineFailure {
  const infrastructure = cleanup.workspaces.find(
    (workspace) => workspace.infrastructure !== undefined,
  )?.infrastructure;
  return {
    ...failure,
    cleanup,
    ...(infrastructure === undefined || "infrastructure" in failure
      ? {}
      : { infrastructure }),
  } as FullPipelineFailure;
}

async function writePreparationWorkspaceCleanupMetadata(input: {
  cleanup: PreparationWorkspaceCleanupMetadata;
  resultPath: string;
}) {
  const artifact = JSON.parse(await readFile(input.resultPath, "utf8")) as {
    failure: FullPipelineFailure;
  };
  await writeFile(
    input.resultPath,
    `${JSON.stringify(
      {
        ...artifact,
        failure: withPreparationWorkspaceCleanupMetadata(
          artifact.failure,
          input.cleanup,
        ),
      },
      null,
      2,
    )}\n`,
  );
}

async function logBestEffort(
  log: (entry: FullPipelineLogInput) => Promise<void>,
  entry: FullPipelineLogInput,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      log(entry),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, cleanupLogTimeoutMs);
      }),
    ]);
  } catch {
    // Cleanup observability must not hide a terminal Pipeline result.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function writeDraftCompositeReviewMetadata(input: {
  finalVideo: CompositedVideoManifest;
  reviewSummary: DraftCompositeReviewSummary;
}) {
  input.finalVideo.draftCompositeReview = input.reviewSummary;
  await writeFile(
    input.finalVideo.manifestPath,
    `${JSON.stringify(input.finalVideo, null, 2)}\n`,
  );
}

async function persistGeneratedScript(input: {
  demoRequestId: string | undefined;
  log: (entry: FullPipelineLogInput) => Promise<void>;
  runDirectory: string;
  demoScript: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >["demoScript"];
  scriptStore: DemoRequestScriptStore | undefined;
  scriptSummary: ReturnType<typeof summarizeDemoScript>;
}): Promise<ScriptPersistence> {
  if (input.scriptStore === undefined) {
    const scriptPath = join(input.runDirectory, "demo-script.json");
    await writeFile(
      scriptPath,
      `${JSON.stringify(input.demoScript, null, 2)}\n`,
    );
    await input.log({
      event: "demo-script-written",
      message: scriptGeneratedMessage(input.scriptSummary),
      sceneCount: input.scriptSummary.sceneCount,
      scriptId: input.demoScript.scriptId,
      scriptPath,
      severity: "info",
      title: input.demoScript.title,
    });

    return { scriptPath };
  }

  if (input.demoRequestId === undefined) {
    throw new Error(
      "context.demoRequestId is required to save the generated script to the database.",
    );
  }

  await input.scriptStore.saveGeneratedScript({
    demoRequestId: input.demoRequestId,
    script: input.demoScript,
  });
  await input.log({
    demoRequestId: input.demoRequestId,
    event: "demo-script-saved",
    message: scriptGeneratedMessage(input.scriptSummary),
    sceneCount: input.scriptSummary.sceneCount,
    scriptId: input.demoScript.scriptId,
    severity: "info",
    title: input.demoScript.title,
  });

  return { demoRequestId: input.demoRequestId };
}

function scriptGeneratedMessage(
  scriptSummary: ReturnType<typeof summarizeDemoScript>,
) {
  return `Accepted Demo Script ready: ${scriptSummary.sceneCount} scene(s).`;
}

function createPipelineLogger(
  logPath: string,
  options: {
    extraSinks: PipelineLogSink[];
    onLog: ((entry: FullPipelineLogEntry) => void) | undefined;
  },
) {
  const sinks: PipelineLogSink[] = [
    createFilePipelineLogSink(logPath),
    ...options.extraSinks,
  ];
  if (options.onLog !== undefined) {
    sinks.push({
      write(line) {
        options.onLog?.(JSON.parse(line) as FullPipelineLogEntry);
      },
    });
  }

  const logger = createPipelineEventLogger({
    base: { component: "full-pipeline" },
    sinks,
  });

  return async (entry: FullPipelineLogInput) => {
    const { severity = "info", ...fields } = entry;
    await logger[severity](fields, entry.message);
  };
}

function severityForPipelineStageStatus(
  status: "failed" | "retrying" | "started" | "succeeded",
): FullPipelineLogSeverity {
  if (status === "failed") {
    return "error";
  }
  if (status === "retrying") {
    return "warn";
  }
  return "info";
}

function summarizeDemoScript(
  demoScript: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >["demoScript"],
) {
  return {
    sceneCount: demoScript.scenes.length,
  };
}

function createFailureSummary(input: {
  logPath: string;
  agentAuditLogPath: string | undefined;
  runDirectory: string;
  runId: string;
  sandboxLogPath: string | undefined;
  sandboxProvider: "daytona" | undefined;
  scriptGenerationAuditLogPath: string | undefined;
  preparedDemo: Exclude<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >;
}) {
  return {
    artifacts: {
      logPath: input.logPath,
      ...(input.agentAuditLogPath === undefined
        ? {}
        : { agentAuditLogPath: input.agentAuditLogPath }),
      ...(input.scriptGenerationAuditLogPath === undefined
        ? {}
        : {
            scriptGenerationAuditLogPath: input.scriptGenerationAuditLogPath,
          }),
      ...(input.sandboxLogPath === undefined
        ? {}
        : { sandboxLogPath: input.sandboxLogPath }),
    },
    failure: readPipelineFailure(input.preparedDemo),
    runDirectory: input.runDirectory,
    runId: input.runId,
    ...(input.sandboxProvider === undefined
      ? {}
      : { sandboxProvider: input.sandboxProvider }),
    status: input.preparedDemo.status,
  };
}

function readPipelineFailure(
  preparedDemo: Exclude<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >,
) {
  if (preparedDemo.status === "infrastructure-failed") {
    return {
      blockers:
        preparedDemo.stage === "capture-path-validation"
          ? [
              "Capture Path Validation failed. Please report this issue to MakeADemo.",
              ...(preparedDemo.failureReason.trim().length === 0
                ? []
                : [
                    `Capture Path Validation reason: ${preparedDemo.failureReason}`,
                  ]),
            ]
          : [preparedDemo.failureReason],
      failureKind: preparedDemo.failureKind,
      ...(preparedDemo.infrastructure === undefined
        ? {}
        : { infrastructure: preparedDemo.infrastructure }),
      ...(preparedDemo.resourceDiagnostics === undefined
        ? {}
        : { resourceDiagnostics: preparedDemo.resourceDiagnostics }),
      suggestedChanges: [],
    };
  }
  if (preparedDemo.status === "preparation-failed") {
    return {
      blockers: [preparedDemo.fallbackPrompt],
      ...(preparedDemo.failureKind === undefined
        ? {}
        : { failureKind: preparedDemo.failureKind }),
      suggestedChanges: [],
    };
  }

  if (preparedDemo.status === "capture-path-validation-failed") {
    const capturePathValidation = preparedDemo.capturePathValidation;
    return {
      blockers: [
        "Capture Path Validation failed. Please report this issue to MakeADemo.",
        ...(capturePathValidation.failureReason === undefined ||
        capturePathValidation.failureReason.trim().length === 0
          ? []
          : [
              `Capture Path Validation reason: ${capturePathValidation.failureReason}`,
            ]),
      ],
      capturePathValidation: removeUndefinedFields({
        diagnosticsLogPath: capturePathValidation.diagnosticsLogPath,
        failureKind: capturePathValidation.failureKind,
        failedAction: capturePathValidation.failedAction,
        failedSceneId: capturePathValidation.failedSceneId,
        failureReason: capturePathValidation.failureReason,
        runDirectory: capturePathValidation.runDirectory,
        resourceDiagnostics: capturePathValidation.resourceDiagnostics,
        screenshotArtifactId: capturePathValidation.screenshotArtifactId,
        scriptPath: capturePathValidation.scriptPath,
        stderrPath: capturePathValidation.stderrPath,
        stdoutPath: capturePathValidation.stdoutPath,
      }),
      suggestedChanges: preparedDemo.capturePathValidation.warnings,
    };
  }

  return {
    blockers: [
      ...(preparedDemo.review === undefined
        ? []
        : [
            `Repo Security agent rejected execution: ${preparedDemo.review.rationale}`,
            ...preparedDemo.review.concerns.map(
              (concern) => `Repo Security concern: ${concern}`,
            ),
          ]),
    ],
    suggestedChanges: preparedDemo.security.warnings.map(
      (finding) => finding.message,
    ),
  };
}

function removeUndefinedFields(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}
