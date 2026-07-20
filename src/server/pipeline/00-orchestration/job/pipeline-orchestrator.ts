import type { AgentSession } from "../../../agent-harness/agent-session";
import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../../02-repo-security-screen/repo-security-screen";
import type {
  RepoPreparationInput,
  RepoPreparationResult,
} from "../../03-repo-preparation/repo-preparation-agent.interface";
import type {
  AcceptedDemoScript,
  DemoScriptCandidate,
  DemoScriptPackage,
} from "../../04-script-generation/demo-script-package";
import type { ScriptGenerationInput } from "../../04-script-generation/script-generation-orchestrator";
import type { CapturePathRepairer } from "../../05-capture-path-validation/capture-path-repairer.interface";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "../../05-capture-path-validation/capture-path-validator.interface";
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

/**
 * Inputs for the bounded authoritative Capture Path Validation and repair
 * lifecycle. A supplied failure requests a repair before the next validation;
 * every repaired candidate is still validated from the beginning.
 */
export type CapturePathValidationRepairLifecycleInput = {
  agentSession?: AgentSession;
  context: PipelineObservationContext;
  dependencies: PipelineOrchestratorDependencies;
  demoScriptCandidate: DemoScriptCandidate;
  failure?: CapturePathValidationResult;
  now: () => number;
  observer: PipelineObserver;
  onProgress?:
    | ((event: PipelineProgressEvent) => Promise<unknown> | unknown)
    | undefined;
  preparationManifest: CapturePathValidationInput["preparationManifest"];
  preparationWorkspace: CapturePathValidationInput["preparationWorkspace"];
  repoUrl: string;
};

/**
 * Result of the bounded Capture Path Validation and repair lifecycle. Only a
 * succeeded result may promote its Demo Script candidate for Footage Capture.
 */
export type CapturePathValidationRepairLifecycleResult =
  | {
      capturePathValidation: CapturePathValidationResult;
      demoScriptCandidate: DemoScriptCandidate;
      preparationManifest: CapturePathValidationInput["preparationManifest"];
      status: "succeeded";
    }
  | {
      capturePathValidation: CapturePathValidationResult;
      status: "failed";
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
  const preparationWorkspace = preparation.workspace;
  if (preparationWorkspace === undefined) {
    throw new Error(
      "Repo Preparation succeeded without a retained authoritative workspace.",
    );
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
    ...(preparation.agentSession === undefined
      ? {}
      : { agentSession: preparation.agentSession }),
    preparationManifest: preparation.manifest,
    ...(preparation.workspace === undefined
      ? {}
      : { preparationWorkspace: preparation.workspace }),
    repoUrl: input.repoUrl,
  } satisfies ScriptGenerationInput;
  const preparationManifest = preparation.manifest;
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

  const capturePathLifecycle = await runCapturePathValidationAndRepair({
    ...(preparation.agentSession === undefined
      ? {}
      : { agentSession: preparation.agentSession }),
    context,
    dependencies,
    demoScriptCandidate,
    now,
    observer,
    onProgress: options.onProgress,
    preparationManifest,
    preparationWorkspace,
    repoUrl: input.repoUrl,
  });
  if (capturePathLifecycle.status === "failed") {
    return {
      capturePathValidation: capturePathLifecycle.capturePathValidation,
      status: "capture-path-validation-failed",
    };
  }

  const acceptedDemoScript: AcceptedDemoScript =
    capturePathLifecycle.demoScriptCandidate;

  return {
    capturePathValidation: capturePathLifecycle.capturePathValidation,
    preparationManifest: capturePathLifecycle.preparationManifest,
    ...(preparation.agentSession === undefined
      ? {}
      : { agentSession: preparation.agentSession }),
    preparationWorkspace,
    status: "succeeded",
    acceptedDemoScript,
    demoScriptPackage: acceptedDemoScript,
  };
}

/**
 * Runs the authoritative Capture Path Validation gate and bounded repair
 * lifecycle. It keeps the caller's retained agent session and workspace while
 * returning only the candidate that successfully passed validation.
 */
export async function runCapturePathValidationAndRepair(
  input: CapturePathValidationRepairLifecycleInput,
): Promise<CapturePathValidationRepairLifecycleResult> {
  let demoScriptCandidate = input.demoScriptCandidate;
  let preparationManifest = input.preparationManifest;
  let failure = input.failure;
  let repairAttempt = 0;
  const repairAttemptLimit = readCapturePathRepairAttemptLimit();

  while (true) {
    const capturePathValidation =
      failure ??
      (await runCapturePathValidation({
        context: input.context,
        dependencies: input.dependencies,
        now: input.now,
        onProgress: input.onProgress,
        observer: input.observer,
        preparationManifest,
        preparationWorkspace: input.preparationWorkspace,
        demoScriptCandidate,
        demoScriptPackage: demoScriptCandidate,
      }));

    if (capturePathValidation.status === "succeeded") {
      return {
        capturePathValidation,
        demoScriptCandidate,
        preparationManifest,
        status: "succeeded",
      };
    }

    if (
      repairAttempt === repairAttemptLimit ||
      input.dependencies.repairCapturePathFailure === undefined
    ) {
      return { capturePathValidation, status: "failed" };
    }

    reportStageRetrying("capture-path-validation", {
      context: input.context,
      nextAttempt: repairAttempt + 2,
      observer: input.observer,
      reason: readCapturePathRetryReason(capturePathValidation),
    });
    repairAttempt += 1;
    const repair = await input.dependencies.repairCapturePathFailure({
      attempt: repairAttempt,
      failure: capturePathValidation,
      ...(input.agentSession === undefined
        ? {}
        : { agentSession: input.agentSession }),
      preparationManifest,
      preparationWorkspace: input.preparationWorkspace,
      repoUrl: input.repoUrl,
      demoScriptPackage: demoScriptCandidate,
    });
    preparationManifest = repair.preparationManifest;
    demoScriptCandidate = repair.demoScriptPackage;
    failure = undefined;
  }
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
      preparationWorkspace: input.preparationWorkspace,
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
