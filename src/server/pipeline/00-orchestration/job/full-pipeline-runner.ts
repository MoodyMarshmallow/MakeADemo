import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type PipelineLogSink,
  createFilePipelineLogSink,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";
import type { RepoSecurityInputInfrastructureDiagnostic } from "../../02-repo-security-screen/repository-loading/repo-security-input-loader.interface";
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
import {
  type DraftCompositeReviewSummary,
  type ScriptPersistence,
  runDraftCompositeReviewLoop,
} from "./draft-composite-review-loop";
import {
  type PipelineCancellationReason,
  isPipelineCancellationError,
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
  sandboxProvider?: "daytona" | "railway";
  sandboxLogPath?: string;
  scriptPath?: string;
  preparedDemo: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >;
  status: "succeeded";
};

export type FullPipelineFailureContext = {
  failure: ReturnType<typeof readPipelineFailure>;
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

export class FullPipelineStageFailure extends Error {
  readonly failure: FullPipelineFailureContext["failure"];
  readonly logPath: string;
  readonly agentAuditLogPath: string | undefined;
  readonly resultPath: string;
  readonly stage: FullPipelineFailureContext["stage"];
  readonly status: FullPipelineFailureContext["status"];

  constructor(context: FullPipelineFailureContext) {
    super(`Pipeline failed with status ${context.status}`);
    this.name = "FullPipelineStageFailure";
    this.failure = context.failure;
    this.logPath = context.logPath;
    this.agentAuditLogPath = context.agentAuditLogPath;
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
  sandboxProvider?: "daytona" | "railway";
  script: {
    sceneCount: number;
    scriptId: string;
    title: string;
  };
  status: "succeeded";
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
  repoSecurityInputFailure?: true | RepoSecurityInputInfrastructureDiagnostic;
  runId?: string;
  /** Controller-owned provider provenance persisted in terminal summaries. */
  sandboxProvider?: "daytona" | "railway";
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
  const orchestratorDependencies: PipelineOrchestratorDependencies = {
    ...dependencies,
    async prepareRepo(preparationInput) {
      const result = await dependencies.prepareRepo(preparationInput);
      if (result.status === "succeeded" && result.workspace !== undefined) {
        preparationWorkspaces.add(result.workspace);
      }
      return result;
    },
  };
  let terminalFailureLogged = false;
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
        ...(options.repoSecurityInputFailure === true
          ? {}
          : { diagnostic: options.repoSecurityInputFailure }),
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
        status: "security-rejected",
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
        status: "security-rejected",
      });
    }

    const initialPreparedDemo = await runPipelineJob(
      input,
      orchestratorDependencies,
      pipelineOptions,
    );
    if (initialPreparedDemo.status !== "succeeded") {
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
        status: initialPreparedDemo.status,
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
        status: initialPreparedDemo.status,
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
      terminalFailureLogged = true;
      throw new Error("Capture Path Validation did not return a browser URL.");
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
    const { captureManifest, finalVideo, reviewSummary } = reviewResult;
    await writeDraftCompositeReviewMetadata({
      finalVideo,
      reviewSummary,
    });
    await log({
      event: "pipeline-succeeded",
      message: "Full pipeline succeeded.",
      severity: "info",
      viewUrl: finalVideo.viewUrl,
    });
    const resultPath = join(runDirectory, "full-pipeline-result.json");
    const artifactSummary: FullPipelineArtifactSummary = {
      artifacts: {
        captureManifestPath: captureManifest.manifestPath,
        compositeManifestPath: finalVideo.manifestPath,
        finalVideoPath: finalVideo.outputVideoPath ?? finalVideo.viewUrl,
        ...(scriptPersistence.demoRequestId === undefined
          ? {}
          : { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }),
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
      status: "succeeded",
    };
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
    return {
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
  } catch (error) {
    if (isPipelineCancellationError(error)) {
      const resultPath = join(runDirectory, "full-pipeline-result.json");
      const cancellationSummary = createCancellationSummary({
        agentAuditLogPath: options.agentAuditLogPath,
        cancellationReason: error.reason,
        logPath,
        runDirectory,
        runId,
        sandboxLogPath,
        sandboxProvider: options.sandboxProvider,
        scriptGenerationAuditLogPath: options.scriptGenerationAuditLogPath,
      });
      await cleanupPreparationWorkspaces({
        handles: preparationWorkspaces,
        log,
      });
      preparationWorkspaces.clear();
      await log({
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
      await log({
        event: "result-written",
        message: "Full pipeline cancellation result written.",
        resultPath,
        severity: "info",
      });
      throw new FullPipelineStageFailure({
        failure: cancellationSummary.failure,
        logPath,
        agentAuditLogPath: options.agentAuditLogPath,
        resultPath,
        stage: "pipeline",
        status: "cancelled",
      });
    }
    if (!terminalFailureLogged) {
      await log({
        error: readErrorMessage(error),
        event: "pipeline-failed",
        message: "Full pipeline failed unexpectedly.",
        severity: "error",
      });
      terminalFailureLogged = true;
    }
    throw error;
  } finally {
    await cleanupPreparationWorkspaces({
      handles: preparationWorkspaces,
      log,
    });
  }
}

function createCancellationSummary(input: {
  agentAuditLogPath: string | undefined;
  cancellationReason: PipelineCancellationReason;
  logPath: string;
  runDirectory: string;
  runId: string;
  sandboxLogPath: string | undefined;
  sandboxProvider: "daytona" | "railway" | undefined;
  scriptGenerationAuditLogPath: string | undefined;
}) {
  const blocker =
    input.cancellationReason === "deadline-exceeded"
      ? "Pipeline deadline exceeded before the full Pipeline Job completed."
      : "Pipeline cancelled by process signal before the full Pipeline Job completed.";
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
    failure: { blockers: [blocker], suggestedChanges: [] },
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
  sandboxProvider: "daytona" | "railway" | undefined;
  scriptGenerationAuditLogPath: string | undefined;
  diagnostic?: RepoSecurityInputInfrastructureDiagnostic;
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
        ...(input.diagnostic === undefined
          ? []
          : [
              `Railway Repo Security infrastructure failed during ${input.diagnostic.phase.replaceAll("-", " ")}.`,
            ]),
      ],
      suggestedChanges: [],
    },
    runDirectory: input.runDirectory,
    runId: input.runId,
    ...(input.sandboxProvider === undefined
      ? {}
      : { sandboxProvider: input.sandboxProvider }),
    status: "security-rejected" as const,
  };
}

async function cleanupPreparationWorkspaces(input: {
  handles: Iterable<NonNullable<PreparedDemoResult["preparationWorkspace"]>>;
  log: (entry: FullPipelineLogInput) => Promise<void>;
}) {
  for (const handle of input.handles) {
    await logCleanupEvent(input.log, {
      event: "preparation-workspace-cleanup.started",
      message: "Preparation workspace cleanup started.",
      severity: "info",
      workspaceId: handle.id,
    });

    const startedAt = Date.now();
    try {
      await handle.release();
      await logCleanupEvent(input.log, {
        durationMs: Date.now() - startedAt,
        event: "preparation-workspace-cleanup.succeeded",
        message: "Preparation workspace cleanup succeeded.",
        severity: "info",
        workspaceId: handle.id,
      });
    } catch (error) {
      await logCleanupEvent(input.log, {
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error),
        event: "preparation-workspace-cleanup.failed",
        message: "Preparation workspace cleanup failed.",
        severity: "warn",
        workspaceId: handle.id,
      });
    }
  }
}

async function logCleanupEvent(
  log: (entry: FullPipelineLogInput) => Promise<void>,
  entry: FullPipelineLogInput,
) {
  try {
    await log(entry);
  } catch {
    // Cleanup observability must not hide an already durable successful result.
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
  sandboxProvider: "daytona" | "railway" | undefined;
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
        failedAction: capturePathValidation.failedAction,
        failedSceneId: capturePathValidation.failedSceneId,
        failureReason: capturePathValidation.failureReason,
        runDirectory: capturePathValidation.runDirectory,
        screenshotArtifactId: capturePathValidation.screenshotArtifactId,
        scriptPath: capturePathValidation.scriptPath,
        stderrPath: capturePathValidation.stderrPath,
        stdoutPath: capturePathValidation.stdoutPath,
      }),
      suggestedChanges: preparedDemo.capturePathValidation.warnings,
    };
  }

  return {
    blockers: preparedDemo.security.rejections,
    suggestedChanges: preparedDemo.security.warnings,
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
