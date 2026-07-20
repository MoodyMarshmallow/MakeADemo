import type {
  AgentSessionRunner,
  AgentTaskEvent,
} from "../agent-harness/agent-session-runner.interface";
import {
  type AgentTaskOutputSinkEvent,
  bindAgentTaskRunner,
} from "../agent-harness/bind-agent-task-runner";
import { createAgentSessionRunner } from "../agent-harness/create-agent-session-runner";
import { classifyProviderFailure } from "../agent-harness/provider-failure-classifier";
import { AgenticRepoPreparation } from "../pipeline/03-repo-preparation/agent-task/agentic-repo-preparation";
import type { PreparationWorkspaceProvider } from "../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { RepoPreparationPreflightResult } from "../pipeline/03-repo-preparation/repo-preparation-preflight.interface";
import { AgenticScriptGenerator } from "../pipeline/04-script-generation/agent-task/agentic-script-generator";
import { AgenticCapturePathRepairer } from "../pipeline/05-capture-path-validation/agent-task/agentic-capture-path-repairer";
import { runDemoRuntimePreflight } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/demo-runtime-preflight";
import type { DemoRuntimePreflightResult } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/validation-result";
import { AgenticDraftCompositeReviewer } from "../pipeline/07-compositing/agent-task/agentic-draft-composite-reviewer";
import { PlaywrightBrowserValidator } from "../shared/integrations/browser/playwright-browser-validator";
import { DaytonaSandboxRunner } from "../shared/integrations/sandbox/daytona-sandbox-runner";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../shared/logging/pipeline-event-logger";
import type { ProductionAgentModelConfig } from "./production-agent-model-config";
import { createProductionAgentProfiles } from "./production-agent-profiles";

const defaultInactivityTimeoutMs = 600_000;
const defaultHardTimeoutMs = 1_800_000;
const defaultPostRepairArtifactReadTimeoutMs = 60_000;
const defaultDraftReviewEvidenceUploadAttemptTimeoutMs = 30_000;
const defaultDraftReviewEvidenceUploadTimeoutMs = 60_250;
const defaultDraftReviewEvidenceUploadRetryDelaysMs = [250] as const;

export type ProductionAgentHarnessOptions = {
  agentSessionRunner?: AgentSessionRunner;
  logger?: PipelineEventLogger;
  maxScriptGenerationAttempts?: number;
  agentModel: ProductionAgentModelConfig;
  onAgentDiagnostic?: (chunk: string) => void;
  onAgentEvent?: (event: AgentTaskEvent) => void;
  onAgentStandard?: (chunk: string) => void;
  onRepoPreparationDiagnostic?: (chunk: string) => void;
  onRepoPreparationEvent?: (event: AgentTaskEvent) => void;
  onRepoPreparationStandard?: (chunk: string) => void;
  openaiApiKey?: string;
  repoPreparationCloneFailureDiagnosticsContext?: {
    daytonaSnapshot?: string;
    daytonaSubmittedCodeSnapshot?: string;
  };
  repoPreparationTimeoutMs?: number;
  repoPreparationWorkspaceProvider: PreparationWorkspaceProvider;
};

/** Assembles production agent adapters without opening a workspace or network connection. */
export function createProductionAgentHarness(
  options: ProductionAgentHarnessOptions,
) {
  const openaiApiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
  const runner =
    options.agentSessionRunner ??
    createAgentSessionRunner(
      openaiApiKey === undefined ? {} : { apiKey: openaiApiKey },
    );
  const profiles = createProductionAgentProfiles({
    modelID: options.agentModel.modelID,
    providerID: options.agentModel.providerID,
  });
  const repoPreparationOutput = createOutputSink(
    options.onRepoPreparationDiagnostic,
    options.onRepoPreparationStandard,
  );
  const sharedAgentOutput = createOutputSink(
    options.onAgentDiagnostic,
    options.onAgentStandard,
  );
  const repoPreparationRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure,
    ...(repoPreparationOutput === undefined
      ? {}
      : { onOutput: repoPreparationOutput }),
    ...(options.onRepoPreparationEvent === undefined
      ? {}
      : { onEvent: options.onRepoPreparationEvent }),
    profile: profiles.repoPreparation,
  });
  const scriptGenerationRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    ...(options.onAgentEvent === undefined
      ? {}
      : { onEvent: options.onAgentEvent }),
    profile: profiles.scriptGeneration,
  });
  const capturePathRepairRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    ...(options.onAgentEvent === undefined
      ? {}
      : { onEvent: options.onAgentEvent }),
    profile: profiles.capturePathRepair,
  });
  const draftCompositeReviewRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    ...(options.onAgentEvent === undefined
      ? {}
      : { onEvent: options.onAgentEvent }),
    profile: profiles.draftCompositeReview,
  });
  const logger = options.logger;
  const repoPreparationTimeoutMs = readRepoPreparationTimeoutMs(
    options.repoPreparationTimeoutMs,
  );
  const onAgentStatus = options.onAgentStandard ?? (() => {});
  const repoPreparationAgent = new AgenticRepoPreparation({
    ...(options.repoPreparationCloneFailureDiagnosticsContext === undefined
      ? {}
      : {
          cloneFailureDiagnosticsContext:
            options.repoPreparationCloneFailureDiagnosticsContext,
        }),
    ...(logger === undefined ? {} : { logger }),
    provider: options.repoPreparationWorkspaceProvider,
    runner: repoPreparationRunner,
    ...(repoPreparationTimeoutMs === undefined
      ? {}
      : { timeoutMs: repoPreparationTimeoutMs }),
    runRuntimePreflight: async ({ manifest, workspace }) =>
      toRepoPreparationPreflightResult(
        await runDemoRuntimePreflight(
          { preparationManifest: manifest, preparationWorkspace: workspace },
          {
            browserValidator: new PlaywrightBrowserValidator(),
            sandboxRunner: new DaytonaSandboxRunner({
              releaseWorkspaceOnCleanup: false,
            }),
          },
        ),
      ),
  });
  const scriptGenerationAgent = new AgenticScriptGenerator({
    ...(logger === undefined ? {} : { logger }),
    ...(options.maxScriptGenerationAttempts === undefined
      ? {}
      : { maxAttempts: options.maxScriptGenerationAttempts }),
    runner: scriptGenerationRunner,
  });
  const capturePathRepairer = new AgenticCapturePathRepairer({
    hardTimeoutMs: defaultHardTimeoutMs,
    logger: logger ?? createNoopLogger(),
    onStatus: onAgentStatus,
    postRepairArtifactReadTimeoutMs: defaultPostRepairArtifactReadTimeoutMs,
    runner: capturePathRepairRunner,
    timeoutMs: defaultInactivityTimeoutMs,
  });
  const draftCompositeReviewer = new AgenticDraftCompositeReviewer({
    draftReviewEvidenceUploadAttemptTimeoutMs:
      defaultDraftReviewEvidenceUploadAttemptTimeoutMs,
    draftReviewEvidenceUploadRetryDelaysMs:
      defaultDraftReviewEvidenceUploadRetryDelaysMs,
    draftReviewEvidenceUploadTimeoutMs:
      defaultDraftReviewEvidenceUploadTimeoutMs,
    hardTimeoutMs: defaultHardTimeoutMs,
    logger: logger ?? createNoopLogger(),
    onStatus: onAgentStatus,
    runner: draftCompositeReviewRunner,
    timeoutMs: defaultInactivityTimeoutMs,
  });
  return {
    agentTaskRunners: {
      capturePathRepair: capturePathRepairRunner,
      draftCompositeReview: draftCompositeReviewRunner,
      repoPreparation: repoPreparationRunner,
      scriptGeneration: scriptGenerationRunner,
    },
    capturePathRepairer,
    disposeAgentSessions: async () => {
      await runner.dispose?.();
    },
    repoPreparationAgent,
    reviewDraftComposite: draftCompositeReviewer.review.bind(
      draftCompositeReviewer,
    ),
    scriptGenerationAgent,
  };
}

/**
 * Adapts Capture Path Validation's richer preflight result at production
 * assembly, so Repo Preparation depends only on its own repair-oriented port.
 */
function toRepoPreparationPreflightResult(
  result: DemoRuntimePreflightResult,
): RepoPreparationPreflightResult {
  return {
    blockedNetworkAttempts: result.blockedNetworkAttempts.map((attempt) => ({
      ...attempt,
    })),
    ...(result.browserUrl === undefined
      ? {}
      : { browserUrl: result.browserUrl }),
    ...(result.evidence === undefined
      ? {}
      : {
          evidence: {
            ...(result.evidence.browser === undefined
              ? {}
              : { browser: { ...result.evidence.browser } }),
            ...(result.evidence.serverLog === undefined
              ? {}
              : { serverLog: { ...result.evidence.serverLog } }),
          },
        }),
    ...(result.failureKind === undefined
      ? {}
      : { failureKind: result.failureKind }),
    ...(result.failureReason === undefined
      ? {}
      : { failureReason: result.failureReason }),
    ...(result.localUrl === undefined ? {} : { localUrl: result.localUrl }),
    logs: [...result.logs],
    ...(result.previewUrl === undefined
      ? {}
      : { previewUrl: result.previewUrl }),
    ...(result.screenshot === undefined
      ? {}
      : { screenshot: { ...result.screenshot } }),
    ...(result.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: result.screenshotArtifactId }),
    status: result.status,
    warnings: [...result.warnings],
  };
}

function createOutputSink(
  onDiagnostic: ((chunk: string) => void) | undefined,
  onStandard: ((chunk: string) => void) | undefined,
): ((event: AgentTaskOutputSinkEvent) => void) | undefined {
  if (onDiagnostic === undefined && onStandard === undefined) return undefined;
  return (event) => {
    if (event.channel === "diagnostic") onDiagnostic?.(event.message);
    else onStandard?.(event.message);
  };
}

function readRepoPreparationTimeoutMs(
  configuredTimeoutMs: number | undefined,
): number | undefined {
  if (configuredTimeoutMs !== undefined) return configuredTimeoutMs;
  const rawValue = process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS;
  if (rawValue === undefined || rawValue.trim() === "") return undefined;
  if (!/^[1-9]\d*$/.test(rawValue.trim())) {
    throw new Error(
      "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS must be a positive integer millisecond value.",
    );
  }
  const timeoutMs = Number(rawValue.trim());
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error(
      "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS must be a positive integer millisecond value.",
    );
  }
  return timeoutMs;
}

function createNoopLogger(): PipelineEventLogger {
  return createPipelineEventLogger({ sinks: [] });
}
