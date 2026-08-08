import { createHash } from "node:crypto";

import type { AgentSession } from "../../../agent-harness/agent-session";
import type {
  RepoSecurityAgentReviewInput,
  RepoSecurityAgentReviewer,
} from "../../02-repo-security-screen/agent-review/repo-security-agent-reviewer.interface";
import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../../02-repo-security-screen/repo-security-screen";
import { createPreparedApplicationIdentityEvidenceLedger } from "../../03-prepared-application-identity-review/prepared-application-identity-evidence";
import type {
  PreparedApplicationIdentityReviewResult,
  PreparedApplicationIdentityReviewer,
} from "../../03-prepared-application-identity-review/prepared-application-identity-reviewer.interface";
import { verifyPreparedWorkspaceIdentitySeal } from "../../03-prepared-application-identity-review/prepared-workspace-identity-seal";
import {
  applicationIdentityBaselineHasValidDigests,
  applicationIdentityBaselinesMatch,
} from "../../03-repo-preparation/application-identity-evidence";
import type {
  ApplicationIdentityBaseline,
  PreparedWorkspaceDiff,
} from "../../03-repo-preparation/application-identity-evidence.interface";
import type {
  PreparedApplicationIdentityEvidenceSource,
  RepoPreparationInput,
  RepoPreparationResult,
} from "../../03-repo-preparation/repo-preparation-agent.interface";
import type { DemoScript } from "../../04-script-generation/demo-script/demo-script.schema";
import type { ScriptGenerationInput } from "../../04-script-generation/script-generation-orchestrator";
import type { CapturePathRepairer } from "../../05-capture-path-validation/capture-path-repairer.interface";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "../../05-capture-path-validation/capture-path-validator.interface";
import { isPipelineInfrastructureFailureKind } from "../../pipeline-infrastructure-failure";
import {
  isPipelineCancellationError,
  runSettledPipelineOperation,
  throwIfPipelineDeadlineReached,
} from "./pipeline-cancellation";
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
  generateDemoScript(input: ScriptGenerationInput): Promise<DemoScript>;
  prepareRepo(input: RepoPreparationInput): Promise<RepoPreparationResult>;
  repairCapturePathFailure?: CapturePathRepairer["repairCapturePathFailure"];
  reviewPreparedApplicationIdentity: PreparedApplicationIdentityReviewer["review"];
  reviewRepoSecurity: RepoSecurityAgentReviewer["review"];
  screenRepoSecurity(input: RepoSecurityInput): RepoSecurityResult;
  validateCapturePath(
    input: CapturePathValidationInput,
  ): Promise<CapturePathValidationResult>;
};

type PipelineProgressEvent = {
  reason?: string;
  stage: PipelineStage;
  status: "failed" | "started" | "succeeded";
};

export type PipelineOrchestratorOptions = {
  /** Absolute deadline for this Pipeline Job, supplied by the non-interactive CLI. */
  deadlineAt?: number;
  context?: Omit<PipelineObservationContext, "workspaceId">;
  now?: () => number;
  observer?: PipelineObserver;
  onProgress?: (event: PipelineProgressEvent) => Promise<unknown> | unknown;
  /** Cooperatively stops active Pipeline work without recasting it as a stage failure. */
  signal?: AbortSignal;
};

/**
 * Inputs for the bounded authoritative Capture Path Validation and repair
 * lifecycle. A supplied failure requests a repair before the next validation;
 * every repaired candidate is still validated from the beginning.
 */
export type CapturePathValidationRepairLifecycleInput = {
  agentSession?: AgentSession;
  deadlineAt?: number;
  context: PipelineObservationContext;
  dependencies: PipelineOrchestratorDependencies;
  demoScript: DemoScript;
  failure?: CapturePathValidationResult;
  now: () => number;
  observer: PipelineObserver;
  onProgress?:
    | ((event: PipelineProgressEvent) => Promise<unknown> | unknown)
    | undefined;
  preparationManifest: CapturePathValidationInput["preparationManifest"];
  preparationWorkspace: CapturePathValidationInput["preparationWorkspace"];
  reviewedPreparedWorkspaceDiff: PreparedWorkspaceDiff;
  repoUrl: string;
  signal?: AbortSignal;
};

/**
 * Result of the bounded Capture Path Validation and repair lifecycle. Only a
 * succeeded result may promote its Demo Script candidate for Footage Capture.
 */
export type CapturePathValidationRepairLifecycleResult =
  | {
      capturePathValidation: CapturePathValidationResult;
      demoScript: DemoScript;
      preparationManifest: CapturePathValidationInput["preparationManifest"];
      status: "succeeded";
    }
  | {
      capturePathValidation: CapturePathValidationResult;
      status: "failed";
    }
  | {
      identityReview: Extract<
        PreparedApplicationIdentityReviewResult,
        { status: "succeeded"; verdict: "fail" }
      >;
      status: "identity-review-failed";
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

  throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);

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

  if (input.preparationWorkspace === undefined) {
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
    return {
      failureKind: "unavailable",
      failureReason:
        "Repo Security agent review requires the retained parent workspace.",
      stage: "repo-security-screen",
      status: "infrastructure-failed",
    };
  }

  const securityReviewInput: RepoSecurityAgentReviewInput = {
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    preparationWorkspace: input.preparationWorkspace,
    scannerReports: input.repoSecurity.scannerReports,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const review = await dependencies.reviewRepoSecurity(securityReviewInput);
  throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
  if (review.status === "failed") {
    await discardRejectedWorkspace(input.preparationWorkspace);
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
    return {
      failureKind: review.failureKind,
      failureReason:
        "Repo Security agent review could not complete because agent infrastructure was unavailable.",
      stage: "repo-security-screen",
      status: "infrastructure-failed",
    };
  }
  if (review.verdict === "rejected") {
    await discardRejectedWorkspace(input.preparationWorkspace);
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
    return {
      review: {
        concerns: review.concerns,
        rationale: review.rationale,
        status: "succeeded",
        verdict: "rejected",
      },
      security,
      status: "security-rejected",
    };
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
  throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);

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
      commitSha: input.commitSha,
      ...(input.applicationIdentityBaseline === undefined
        ? {}
        : {
            applicationIdentityBaseline: input.applicationIdentityBaseline,
          }),
      normalizedSupportingDocuments: input.normalizedSupportingDocuments,
      repoUrl: input.repoUrl,
      ...(input.preparationWorkspace === undefined
        ? {}
        : { preparationWorkspace: input.preparationWorkspace }),
      structuredDemoIntent: input.demoBrief,
      workspaceId: input.workspaceId,
      ...(options.deadlineAt === undefined
        ? {}
        : { deadlineAt: repoPreparationDeadlineAt(options.deadlineAt, now()) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
  } catch (error) {
    if (isPipelineCancellationError(error)) throw error;
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
    if (
      preparation.infrastructure !== undefined ||
      isPipelineInfrastructureFailureKind(preparation.failureKind)
    ) {
      return {
        failureKind: isPipelineInfrastructureFailureKind(
          preparation.failureKind,
        )
          ? preparation.failureKind
          : "sandbox-infrastructure-failed",
        failureReason: preparation.fallbackPrompt,
        ...(preparation.infrastructure === undefined
          ? {}
          : { infrastructure: preparation.infrastructure }),
        ...(preparation.resourceDiagnostics === undefined
          ? {}
          : { resourceDiagnostics: preparation.resourceDiagnostics }),
        stage: "repo-preparation",
        status: "infrastructure-failed",
      };
    }
    return {
      fallbackPrompt: preparation.fallbackPrompt,
      ...(preparation.failureKind === undefined
        ? {}
        : { failureKind: preparation.failureKind }),
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
  throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);

  const identityStartedAt = reportStageStarted(
    "prepared-application-identity-review",
    {
      context,
      now,
      observer,
      onProgress: options.onProgress,
    },
  );
  await emitProgress(options, {
    stage: "prepared-application-identity-review",
    status: "started",
  });

  const identityEvidence = readPreparedIdentityEvidence({
    applicationIdentityBaseline: input.applicationIdentityBaseline,
    commitSha: input.commitSha,
    preparation,
    repoUrl: input.repoUrl,
  });
  if (identityEvidence.status === "failed") {
    reportStageFinished("prepared-application-identity-review", "failed", {
      context,
      now,
      observer,
      onProgress: options.onProgress,
      reason: identityEvidence.failureReason,
      startedAt: identityStartedAt,
    });
    await emitProgress(options, {
      reason: identityEvidence.failureReason,
      stage: "prepared-application-identity-review",
      status: "failed",
    });
    return {
      failureKind: "invalid-output",
      failureReason: identityEvidence.failureReason,
      stage: "prepared-application-identity-review",
      status: "infrastructure-failed",
    };
  }
  const identityEvidenceSource = createIdentityEvidenceSource(preparation);

  let identityReview: PreparedApplicationIdentityReviewResult;
  try {
    identityReview = await dependencies.reviewPreparedApplicationIdentity({
      ...(options.deadlineAt === undefined
        ? {}
        : { deadlineAt: options.deadlineAt }),
      evidenceLedger: identityEvidence.evidenceLedger,
      preparationManifest: preparation.manifest,
      preparationWorkspace,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
  } catch (error) {
    if (isPipelineCancellationError(error)) throw error;
    throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
    reportStageFinished("prepared-application-identity-review", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: identityStartedAt,
    });
    await emitProgress(options, {
      reason:
        "Prepared Application Identity Review could not complete because reviewer infrastructure was unavailable.",
      stage: "prepared-application-identity-review",
      status: "failed",
    });
    const failedIdentityReview = {
      failureKind: "unavailable",
      status: "failed",
    } as const;
    return {
      identityEvidenceSource,
      identityReview: failedIdentityReview,
      failureKind: failedIdentityReview.failureKind,
      failureReason:
        "Prepared Application Identity Review could not complete because reviewer infrastructure was unavailable.",
      stage: "prepared-application-identity-review",
      status: "infrastructure-failed",
    };
  }

  if (identityReview.status === "failed") {
    const failureReason = `Prepared Application Identity Review ${identityReview.failureKind}.`;
    reportStageFinished("prepared-application-identity-review", "failed", {
      context,
      now,
      observer,
      onProgress: options.onProgress,
      reason: failureReason,
      startedAt: identityStartedAt,
    });
    await emitProgress(options, {
      reason: failureReason,
      stage: "prepared-application-identity-review",
      status: "failed",
    });
    return {
      identityEvidenceSource,
      identityReview,
      failureKind: identityReview.failureKind,
      failureReason,
      stage: "prepared-application-identity-review",
      status: "infrastructure-failed",
    };
  }

  if (identityReview.verdict === "fail") {
    reportStageFinished("prepared-application-identity-review", "failed", {
      context,
      now,
      observer,
      onProgress: options.onProgress,
      reason: identityReview.failureKind,
      startedAt: identityStartedAt,
    });
    await emitProgress(options, {
      reason: identityReview.failureKind,
      stage: "prepared-application-identity-review",
      status: "failed",
    });
    return {
      identityEvidenceSource,
      identityReview,
      status: "identity-review-failed",
    };
  }

  reportStageFinished("prepared-application-identity-review", "succeeded", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
    startedAt: identityStartedAt,
  });
  await emitProgress(options, {
    stage: "prepared-application-identity-review",
    status: "succeeded",
  });
  throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);

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

  let demoScript: DemoScript;
  const scriptGenerationInput = {
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
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
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  } satisfies ScriptGenerationInput;
  const preparationManifest = preparation.manifest;
  try {
    demoScript = await dependencies.generateDemoScript(scriptGenerationInput);
    throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
  } catch (error) {
    if (isPipelineCancellationError(error)) throw error;
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
  const scriptGenerationSeal = await verifyPreparedWorkspaceIdentitySeal({
    reviewedDiff: identityEvidence.evidenceLedger.preparedWorkspaceDiff,
    stage: "Script Generation",
    workspace: preparationWorkspace,
  });
  throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
  if (scriptGenerationSeal.status === "changed") {
    await emitProgress(options, {
      reason: scriptGenerationSeal.identityReview.failureKind,
      stage: "prepared-application-identity-review",
      status: "failed",
    });
    return {
      identityEvidenceSource,
      identityReview: scriptGenerationSeal.identityReview,
      status: "identity-review-failed",
    };
  }
  reportStageFinished("script-generation", "succeeded", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
    riskCount: preparationManifest.risks.length,
    sceneCount: countScenes(demoScript),
    startedAt: scriptStartedAt,
  });
  await emitProgress(options, {
    stage: "script-generation",
    status: "succeeded",
  });

  const capturePathOperation = runCapturePathValidationAndRepair({
    ...(preparation.agentSession === undefined
      ? {}
      : { agentSession: preparation.agentSession }),
    context,
    dependencies,
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    demoScript,
    now,
    observer,
    onProgress: options.onProgress,
    preparationManifest,
    preparationWorkspace,
    reviewedPreparedWorkspaceDiff:
      identityEvidence.evidenceLedger.preparedWorkspaceDiff,
    repoUrl: input.repoUrl,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const capturePathLifecycle = await runSettledPipelineOperation({
    deadlineAt: options.deadlineAt,
    onCancel: async () => {
      await preparationWorkspace.workspace.cancelActiveCommands?.();
    },
    operation: capturePathOperation,
    signal: options.signal,
  });
  throwIfPipelineDeadlineReached(options.signal, options.deadlineAt);
  if (capturePathLifecycle.status === "identity-review-failed") {
    await emitProgress(options, {
      reason: capturePathLifecycle.identityReview.failureKind,
      stage: "prepared-application-identity-review",
      status: "failed",
    });
    return {
      identityEvidenceSource,
      identityReview: capturePathLifecycle.identityReview,
      status: "identity-review-failed",
    };
  }
  if (capturePathLifecycle.status === "failed") {
    const failure = capturePathLifecycle.capturePathValidation;
    if (isPipelineInfrastructureFailureKind(failure.failureKind)) {
      return {
        failureKind: failure.failureKind,
        failureReason: failure.failureReason ?? "",
        ...(failure.resourceDiagnostics === undefined
          ? {}
          : { resourceDiagnostics: failure.resourceDiagnostics }),
        stage: "capture-path-validation",
        status: "infrastructure-failed",
      };
    }
    return {
      capturePathValidation: failure,
      status: "capture-path-validation-failed",
    };
  }

  return {
    capturePathValidation: capturePathLifecycle.capturePathValidation,
    identityEvidenceSource,
    identityReview,
    preparationManifest: capturePathLifecycle.preparationManifest,
    ...(preparation.agentSession === undefined
      ? {}
      : { agentSession: preparation.agentSession }),
    preparationWorkspace,
    reviewedPreparedWorkspaceDiff:
      identityEvidence.evidenceLedger.preparedWorkspaceDiff,
    status: "succeeded",
    demoScript: capturePathLifecycle.demoScript,
  };
}

type SuccessfulPreparation = Extract<
  RepoPreparationResult,
  { status: "succeeded" }
>;

function createIdentityEvidenceSource(
  preparation: SuccessfulPreparation,
): PreparedApplicationIdentityEvidenceSource {
  return {
    applicationIdentityBaseline: preparation.applicationIdentityBaseline,
    manifest: preparation.manifest,
    preparedWorkspaceDiff: preparation.preparedWorkspaceDiff,
    runtimePreflight: preparation.runtimePreflight,
  };
}

type IdentityReadyPreparation = Omit<
  SuccessfulPreparation,
  "applicationIdentityBaseline" | "preparedWorkspaceDiff" | "runtimePreflight"
> & {
  applicationIdentityBaseline?: ApplicationIdentityBaseline;
  preparedWorkspaceDiff?: PreparedWorkspaceDiff;
  runtimePreflight?: {
    accessibilitySnapshot?: {
      sha256: string;
      sizeBytes: number;
      text: string;
    };
    screenshot?: {
      mimeType: "image/png";
      path: string;
      sha256?: string;
      sizeBytes?: number;
    };
    status: "succeeded" | "failed";
  };
};

function readPreparedIdentityEvidence(input: {
  applicationIdentityBaseline: ApplicationIdentityBaseline | undefined;
  commitSha: string;
  preparation: Extract<RepoPreparationResult, { status: "succeeded" }>;
  repoUrl: string;
}):
  | {
      evidenceLedger: ReturnType<
        typeof createPreparedApplicationIdentityEvidenceLedger
      >;
      status: "succeeded";
    }
  | { failureReason: string; status: "failed" } {
  const preparation = input.preparation as IdentityReadyPreparation;
  const baseline = preparation.applicationIdentityBaseline;
  const diff = preparation.preparedWorkspaceDiff;
  const preflight = preparation.runtimePreflight;
  const snapshot = preflight?.accessibilitySnapshot;
  const screenshot = preflight?.screenshot;
  if (
    baseline === undefined ||
    diff === undefined ||
    preflight?.status !== "succeeded" ||
    snapshot === undefined ||
    screenshot?.sha256 === undefined
  ) {
    return {
      failureReason:
        "Prepared Application Identity Review requires a backend baseline, complete workspace diff, successful runtime preflight, screenshot digest, and accessibility snapshot.",
      status: "failed",
    };
  }
  if (
    baseline.pinnedRevision !== input.commitSha ||
    baseline.repoUrl !== input.repoUrl ||
    diff.artifactId !== preparation.manifest.diffArtifactId ||
    (input.applicationIdentityBaseline !== undefined &&
      !applicationIdentityBaselinesMatch(
        baseline,
        input.applicationIdentityBaseline,
      ))
  ) {
    return {
      failureReason:
        "Prepared Application Identity evidence did not match the submitted revision, repository, or Preparation Manifest diff artifact.",
      status: "failed",
    };
  }
  if (
    !applicationIdentityBaselineHasValidDigests(baseline) ||
    !isSha256(diff.patchSha256) ||
    !isSha256(snapshot.sha256) ||
    !isSha256(screenshot.sha256) ||
    sha256(diff.patch) !== diff.patchSha256 ||
    Buffer.byteLength(diff.patch) !== diff.sizeBytes ||
    sha256(snapshot.text) !== snapshot.sha256 ||
    Buffer.byteLength(snapshot.text) !== snapshot.sizeBytes
  ) {
    return {
      failureReason:
        "Prepared Application Identity evidence content did not match its backend-owned digest or size.",
      status: "failed",
    };
  }

  try {
    return {
      evidenceLedger: createPreparedApplicationIdentityEvidenceLedger({
        applicationIdentityBaseline: baseline,
        evidence: [
          {
            content: JSON.stringify({
              mimeType: screenshot.mimeType,
              path: screenshot.path,
              sha256: screenshot.sha256,
              ...(screenshot.sizeBytes === undefined
                ? {}
                : { sizeBytes: screenshot.sizeBytes }),
            }),
            id: `prepared-screenshot:sha256:${screenshot.sha256}`,
            kind: "prepared-screenshot",
          },
          {
            content: snapshot.text,
            id: `accessibility-snapshot:sha256:${snapshot.sha256}`,
            kind: "accessibility-snapshot",
          },
        ],
        mockedBoundaries: preparation.manifest.mockingPlan.boundaries.map(
          (boundary, index) => `${index}:${boundary.kind}:${boundary.source}`,
        ),
        preparedWorkspaceDiff: diff,
      }),
      status: "succeeded",
    };
  } catch (error) {
    return {
      failureReason: `Prepared Application Identity evidence was invalid: ${error instanceof Error ? error.message : String(error)}`,
      status: "failed",
    };
  }
}

function isSha256(value: string) {
  return /^[0-9a-f]{64}$/i.test(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function discardRejectedWorkspace(
  workspace: PipelineJobInput["preparationWorkspace"],
) {
  if (workspace === undefined) return;
  if (workspace.discard !== undefined) {
    await workspace.discard();
    return;
  }
  await workspace.release();
}

const repoPreparationMaximumDurationMs = 1_800_000;
const pipelineReserveAfterRepoPreparationMs = 120_000;

function repoPreparationDeadlineAt(
  pipelineDeadlineAt: number,
  preparationStartedAt: number,
): number {
  return Math.max(
    preparationStartedAt,
    Math.min(
      preparationStartedAt + repoPreparationMaximumDurationMs,
      pipelineDeadlineAt - pipelineReserveAfterRepoPreparationMs,
    ),
  );
}

/**
 * Runs the authoritative Capture Path Validation gate and bounded repair
 * lifecycle. It keeps the caller's retained agent session and workspace while
 * returning only the candidate that successfully passed validation.
 */
export async function runCapturePathValidationAndRepair(
  input: CapturePathValidationRepairLifecycleInput,
): Promise<CapturePathValidationRepairLifecycleResult> {
  let demoScript = input.demoScript;
  let preparationManifest = input.preparationManifest;
  let failure = input.failure;
  let repairAttempt = 0;
  const repairAttemptLimit = readCapturePathRepairAttemptLimit();

  while (true) {
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
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
        demoScript,
      }));
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);

    if (capturePathValidation.status === "succeeded") {
      return {
        capturePathValidation,
        demoScript,
        preparationManifest,
        status: "succeeded",
      };
    }

    if (
      isPipelineInfrastructureFailureKind(capturePathValidation.failureKind)
    ) {
      return { capturePathValidation, status: "failed" };
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
    let repair: Awaited<
      ReturnType<CapturePathRepairer["repairCapturePathFailure"]>
    >;
    try {
      repair = await input.dependencies.repairCapturePathFailure({
        attempt: repairAttempt,
        ...(input.deadlineAt === undefined
          ? {}
          : { deadlineAt: input.deadlineAt }),
        failure: capturePathValidation,
        ...(input.agentSession === undefined
          ? {}
          : { agentSession: input.agentSession }),
        preparationManifest,
        preparationWorkspace: input.preparationWorkspace,
        repoUrl: input.repoUrl,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        demoScript,
      });
    } catch (error) {
      if (isPipelineCancellationError(error)) throw error;
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
      return {
        capturePathValidation,
        status: "failed",
      };
    }
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    preparationManifest = repair.preparationManifest;
    demoScript = repair.demoScript;
    const repairSeal = await verifyPreparedWorkspaceIdentitySeal({
      reviewedDiff: input.reviewedPreparedWorkspaceDiff,
      stage: "Capture Path repair",
      workspace: input.preparationWorkspace,
    });
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (repairSeal.status === "changed") {
      return {
        identityReview: repairSeal.identityReview,
        status: "identity-review-failed",
      };
    }
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
  demoScript: DemoScript;
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
      demoScript: input.demoScript,
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
    sceneCount: countScenes(input.demoScript),
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

function countScenes(demoScript: DemoScript) {
  return demoScript.scenes.length;
}

async function emitProgress(
  options: PipelineOrchestratorOptions,
  event: PipelineProgressEvent,
) {
  await options.onProgress?.(event);
}
