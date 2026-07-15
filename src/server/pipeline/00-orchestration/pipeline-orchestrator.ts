import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../02-repo-security-screen/repo-security-screen";
import type {
  RepoPreparationInput,
  RepoPreparationResult,
} from "../03-repo-preparation/repo-preparation-agent.interface";
import type {
  AcceptedDemoScript,
  DemoScriptCandidate,
  DemoScriptPackage,
} from "../04-script-generation/demo-script-package";
import type { ScriptGenerationInput } from "../04-script-generation/script-generation-orchestrator";
import type { CapturePathRepairer } from "../05-capture-path-validation/capture-path-repairer.interface";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "../05-capture-path-validation/capture-path-validator.interface";
import type { PipelineJobInput, PipelineJobResult } from "./pipeline-job";
import {
  type PipelineObservabilityEvent,
  type PipelineObservationContext,
  type PipelineObserver,
  type PipelineStage,
  noopPipelineObserver,
  sanitizeObservabilityError,
} from "./pipeline-observer";

export type PipelineOrchestratorDependencies = {
  generateScriptPackage(
    input: ScriptGenerationInput,
  ): Promise<DemoScriptCandidate>;
  prepareRepo(input: RepoPreparationInput): Promise<RepoPreparationResult>;
  repairCapturePathFailure?: CapturePathRepairer["repairCapturePathFailure"];
  screenRepoSecurity(input: RepoSecurityInput): RepoSecurityResult;
  validateCapturePath(
    input: CapturePathValidationInput,
  ): Promise<CapturePathValidationResult>;
};

type PipelineProgressEvent = {
  stage: PipelineStage;
  status: "failed" | "started" | "succeeded";
};

export type PipelineOrchestratorOptions = {
  context?: Omit<PipelineObservationContext, "workspaceId">;
  now?: () => number;
  observer?: PipelineObserver;
  onProgress?: (event: PipelineProgressEvent) => Promise<unknown> | unknown;
};

export async function runPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
  options: PipelineOrchestratorOptions = {},
): Promise<PipelineJobResult> {
  const context = {
    ...options.context,
    workspaceId: input.workspaceId,
  };
  const observer = options.observer ?? noopPipelineObserver;
  const now = options.now ?? Date.now;

  const securityStartedAt = reportStageStarted("repo-security-screen", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
  });
  await emitProgress(options, {
    stage: "repo-security-screen",
    status: "started",
  });

  let security: RepoSecurityResult;
  try {
    security = dependencies.screenRepoSecurity(input.repoSecurity);
  } catch (error) {
    reportStageFinished("repo-security-screen", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: securityStartedAt,
    });
    await emitProgress(options, {
      stage: "repo-security-screen",
      status: "failed",
    });
    throw error;
  }

  if (security.status === "rejected") {
    reportStageFinished("repo-security-screen", "failed", {
      context,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: securityStartedAt,
      warningCount: security.warnings.length,
    });
    await emitProgress(options, {
      stage: "repo-security-screen",
      status: "failed",
    });
    return { security, status: "security-rejected" };
  }
  reportStageFinished("repo-security-screen", "succeeded", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
    startedAt: securityStartedAt,
    warningCount: security.warnings.length,
  });
  await emitProgress(options, {
    stage: "repo-security-screen",
    status: "succeeded",
  });

  const preparationStartedAt = reportStageStarted("repo-preparation", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
  });
  await emitProgress(options, {
    stage: "repo-preparation",
    status: "started",
  });

  let preparation: RepoPreparationResult;
  try {
    preparation = await dependencies.prepareRepo({
      ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
      normalizedSupportingDocuments: input.normalizedSupportingDocuments,
      repoUrl: input.repoUrl,
      structuredDemoIntent: input.demoBrief,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    reportStageFinished("repo-preparation", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: preparationStartedAt,
    });
    await emitProgress(options, {
      stage: "repo-preparation",
      status: "failed",
    });
    throw error;
  }

  if (preparation.status === "failed") {
    reportStageFinished("repo-preparation", "failed", {
      context,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: preparationStartedAt,
    });
    await emitProgress(options, {
      stage: "repo-preparation",
      status: "failed",
    });
    return {
      fallbackPrompt: preparation.fallbackPrompt,
      status: "preparation-failed",
    };
  }
  reportStageFinished("repo-preparation", "succeeded", {
    context,
    createdFileCount: preparation.manifest.createdFiles.length,
    diffArtifactId: preparation.manifest.diffArtifactId,
    mockedServiceCount: preparation.manifest.mockedServices.length,
    now,
    observer,
    onProgress: options.onProgress,
    riskCount: preparation.manifest.risks.length,
    startedAt: preparationStartedAt,
  });
  await emitProgress(options, {
    stage: "repo-preparation",
    status: "succeeded",
  });

  const scriptStartedAt = reportStageStarted("script-generation", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
  });
  await emitProgress(options, {
    stage: "script-generation",
    status: "started",
  });

  let demoScriptCandidate: DemoScriptCandidate;
  const scriptGenerationInput = {
    demoBrief: input.demoBrief,
    normalizedSupportingDocuments: input.normalizedSupportingDocuments,
    ...(preparation.opencodeSessionID === undefined
      ? {}
      : { opencodeSessionID: preparation.opencodeSessionID }),
    preparationManifest: preparation.manifest,
    ...(preparation.workspace === undefined
      ? {}
      : { preparationWorkspace: preparation.workspace }),
    repoUrl: input.repoUrl,
  } satisfies ScriptGenerationInput;
  let preparationManifest = preparation.manifest;
  try {
    demoScriptCandidate = await dependencies.generateScriptPackage(
      scriptGenerationInput,
    );
  } catch (error) {
    reportStageFinished("script-generation", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: scriptStartedAt,
    });
    await emitProgress(options, {
      stage: "script-generation",
      status: "failed",
    });
    throw error;
  }
  reportStageFinished("script-generation", "succeeded", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
    riskCount: demoScriptCandidate.demoPlan.risks.length,
    sceneCount: countScenes(demoScriptCandidate),
    startedAt: scriptStartedAt,
  });
  await emitProgress(options, {
    stage: "script-generation",
    status: "succeeded",
  });

  let capturePathValidation: CapturePathValidationResult | undefined;
  const repairAttemptLimit = readCapturePathRepairAttemptLimit();
  for (let attempt = 0; attempt <= repairAttemptLimit; attempt += 1) {
    capturePathValidation = await runCapturePathValidation({
      context,
      dependencies,
      now,
      onProgress: options.onProgress,
      observer,
      preparationManifest,
      preparationWorkspace: preparation.workspace,
      demoScriptCandidate,
      demoScriptPackage: demoScriptCandidate,
    });

    if (capturePathValidation.status === "succeeded") {
      break;
    }

    if (
      attempt === repairAttemptLimit ||
      dependencies.repairCapturePathFailure === undefined
    ) {
      return {
        capturePathValidation,
        status: "capture-path-validation-failed",
      };
    }

    reportStageRetrying("capture-path-validation", {
      context,
      nextAttempt: attempt + 2,
      observer,
      reason: readCapturePathRetryReason(capturePathValidation),
    });
    const repair = await dependencies.repairCapturePathFailure({
      attempt: attempt + 1,
      failure: capturePathValidation,
      ...(preparation.opencodeSessionID === undefined
        ? {}
        : { opencodeSessionID: preparation.opencodeSessionID }),
      preparationManifest,
      ...(preparation.workspace === undefined
        ? {}
        : { preparationWorkspace: preparation.workspace }),
      repoUrl: input.repoUrl,
      demoScriptPackage: demoScriptCandidate,
    });
    preparationManifest = repair.preparationManifest;
    demoScriptCandidate = repair.demoScriptPackage;
  }

  const acceptedDemoScript: AcceptedDemoScript = demoScriptCandidate;

  return {
    capturePathValidation: requireCapturePathValidation(capturePathValidation),
    preparationManifest,
    ...(preparation.opencodeSessionID === undefined
      ? {}
      : { opencodeSessionID: preparation.opencodeSessionID }),
    ...(preparation.workspace === undefined
      ? {}
      : { preparationWorkspace: preparation.workspace }),
    status: "succeeded",
    acceptedDemoScript,
    demoScriptPackage: acceptedDemoScript,
  };
}

function requireCapturePathValidation(
  result: CapturePathValidationResult | undefined,
) {
  if (result === undefined) {
    throw new Error("Capture Path Validation did not run.");
  }

  return result;
}

async function runCapturePathValidation(input: {
  context: PipelineObservationContext;
  dependencies: PipelineOrchestratorDependencies;
  now: () => number;
  observer: PipelineObserver;
  onProgress:
    | ((event: PipelineProgressEvent) => Promise<unknown> | unknown)
    | undefined;
  preparationManifest: CapturePathValidationInput["preparationManifest"];
  preparationWorkspace: CapturePathValidationInput["preparationWorkspace"];
  demoScriptCandidate: DemoScriptCandidate;
  demoScriptPackage: DemoScriptPackage;
}) {
  const startedAt = reportStageStarted("capture-path-validation", {
    context: input.context,
    now: input.now,
    observer: input.observer,
    onProgress: input.onProgress,
  });
  await input.onProgress?.({
    stage: "capture-path-validation",
    status: "started",
  });

  let result: CapturePathValidationResult;
  try {
    result = await input.dependencies.validateCapturePath({
      preparationManifest: input.preparationManifest,
      ...(input.preparationWorkspace === undefined
        ? {}
        : { preparationWorkspace: input.preparationWorkspace }),
      demoScriptCandidate: input.demoScriptCandidate,
      demoScriptPackage: input.demoScriptPackage,
    });
    assertCapturePathValidationBrowserUrlContract(result);
  } catch (error) {
    reportStageFinished("capture-path-validation", "failed", {
      context: input.context,
      error,
      now: input.now,
      observer: input.observer,
      onProgress: input.onProgress,
      startedAt,
    });
    await input.onProgress?.({
      stage: "capture-path-validation",
      status: "failed",
    });
    throw error;
  }

  reportStageFinished("capture-path-validation", result.status, {
    blockedNetworkAttemptCount: result.blockedNetworkAttempts.length,
    context: input.context,
    now: input.now,
    observer: input.observer,
    onProgress: input.onProgress,
    sceneCount: countScenes(input.demoScriptPackage),
    startedAt,
    warningCount: result.warnings.length,
  });
  await input.onProgress?.({
    stage: "capture-path-validation",
    status: result.status,
  });

  return result;
}

function assertCapturePathValidationBrowserUrlContract(
  result: CapturePathValidationResult,
) {
  if (
    result.status === "succeeded" &&
    (result.browserUrl === undefined || result.browserUrl.trim().length === 0)
  ) {
    throw new Error("Capture Path Validation succeeded without a browser URL.");
  }
}

function readCapturePathRepairAttemptLimit() {
  const rawValue = process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS;
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return 3;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return 3;
  }

  return parsedValue;
}

function reportStageStarted(
  stage: PipelineStage,
  input: {
    context: PipelineObservationContext;
    now: () => number;
    observer: PipelineObserver;
    onProgress:
      | ((event: PipelineProgressEvent) => Promise<unknown> | unknown)
      | undefined;
  },
) {
  input.observer.record({
    ...input.context,
    event: "stage.started",
    stage,
    status: "started",
  });

  return input.now();
}

function reportStageFinished(
  stage: PipelineStage,
  status: "failed" | "succeeded",
  input: Omit<PipelineObservabilityEvent, "durationMs" | "event" | "stage"> & {
    context: PipelineObservationContext;
    error?: unknown;
    now: () => number;
    observer: PipelineObserver;
    onProgress:
      | ((event: PipelineProgressEvent) => Promise<unknown> | unknown)
      | undefined;
    startedAt: number;
  },
) {
  const { context, error, now, observer, onProgress, startedAt, ...fields } =
    input;
  const errorFields =
    error === undefined ? {} : sanitizeObservabilityError(error);

  observer.record({
    ...context,
    ...fields,
    ...errorFields,
    durationMs: now() - startedAt,
    event: status === "succeeded" ? "stage.succeeded" : "stage.failed",
    stage,
    status,
  });
}

function reportStageRetrying(
  stage: PipelineStage,
  input: {
    context: PipelineObservationContext;
    nextAttempt: number;
    observer: PipelineObserver;
    reason: string;
  },
) {
  input.observer.record({
    ...input.context,
    event: "stage.retrying",
    nextAttempt: input.nextAttempt,
    reason: input.reason,
    stage,
    status: "retrying",
  });
}

function readCapturePathRetryReason(result: CapturePathValidationResult) {
  return result.failureReason === undefined ||
    result.failureReason.trim().length === 0
    ? "capture-path-validation-failed"
    : result.failureReason;
}

function countScenes(demoScriptPackage: DemoScriptPackage) {
  return demoScriptPackage.scenes.length;
}

async function emitProgress(
  options: PipelineOrchestratorOptions,
  event: PipelineProgressEvent,
) {
  await options.onProgress?.(event);
}
