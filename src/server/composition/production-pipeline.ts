import type { AgentTaskRunner } from "../agent-harness/agent-session-runner.interface";
import { createBrowserToolControllerProvider } from "../agent-harness/tools/browser/browser-tool-controller-registry";
import type { FullPipelineRunnerOptions } from "../pipeline/00-orchestration/job/full-pipeline-runner";
import { createMakeADemoPipeline } from "../pipeline/00-orchestration/job/pipeline-controller";
import type { PipelineOrchestratorDependencies } from "../pipeline/00-orchestration/job/pipeline-orchestrator";
import { AgenticRepoSecurityReviewer } from "../pipeline/02-repo-security-screen/agent-review/agentic-repo-security-reviewer";
import type { RepoSecurityAgentReviewer } from "../pipeline/02-repo-security-screen/agent-review/repo-security-agent-reviewer.interface";
import { screenRepoSecurity } from "../pipeline/02-repo-security-screen/repo-security-screen";
import { AgenticPreparedApplicationIdentityReviewer } from "../pipeline/03-prepared-application-identity-review/agentic-prepared-application-identity-reviewer";
import { AgenticRepoPreparation } from "../pipeline/03-repo-preparation/agent-task/agentic-repo-preparation";
import type { RepoPreparationAgent } from "../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import type { RepoPreparationPreflightResult } from "../pipeline/03-repo-preparation/repo-preparation-preflight.interface";
import { prepareRepo } from "../pipeline/03-repo-preparation/repo-preparer";
import type { SubmittedCodeNodeReleaseCatalog } from "../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { AgenticScriptGenerator } from "../pipeline/04-script-generation/agent-task/agentic-script-generator";
import type { ScriptGenerationAgent } from "../pipeline/04-script-generation/script-generation-agent.interface";
import { generateDemoScript } from "../pipeline/04-script-generation/script-generation-orchestrator";
import { AgenticCapturePathRepairer } from "../pipeline/05-capture-path-validation/agent-task/agentic-capture-path-repairer";
import type { CapturePathRepairer } from "../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import {
  type CapturePathSceneValidator,
  validateCapturePath,
} from "../pipeline/05-capture-path-validation/capture-path-validator";
import type { BrowserValidator } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/browser-validator.interface";
import { runDemoRuntimePreflight } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/demo-runtime-preflight";
import type { RuntimeNetworkPolicy } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";
import type { SandboxRunner } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/sandbox-runner.interface";
import type { DemoRuntimePreflightResult } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/validation-result";
import { DefaultCapturePathSceneValidator } from "../pipeline/05-capture-path-validation/playwright-capture-path-scene-validator";
import { AgenticDraftCompositeReviewer } from "../pipeline/07-compositing/agent-task/agentic-draft-composite-reviewer";
import { PlaywrightBrowserValidator } from "../shared/integrations/browser/playwright-browser-validator";
import { DaytonaRepoSecurityInputLoader } from "../shared/integrations/daytona/daytona-repo-security-input-loader";
import { DaytonaSdkPreparationWorkspaceProvider } from "../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { OfficialNodejsReleaseCatalog } from "../shared/integrations/nodejs/official-nodejs-release-catalog";
import {
  PreparedWorkspaceSandboxRunner,
  restartPreparedDemoForFreshCapture,
} from "../shared/integrations/sandbox/prepared-workspace-sandbox-runner";
import {
  type PipelineEventLogger,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../shared/logging/pipeline-event-logger";
import {
  type ProductionAgentHarnessOptions,
  createProductionAgentHarness,
} from "./production-agent-harness";

export type ProductionPipelineDependencyOptions = {
  browserValidator?: BrowserValidator;
  capturePathRepairer?: CapturePathRepairer;
  nodeReleaseCatalog: SubmittedCodeNodeReleaseCatalog;
  preparedApplicationIdentityReviewRunner: AgentTaskRunner;
  repoPreparationAgent: RepoPreparationAgent;
  repoSecurityReviewer: RepoSecurityAgentReviewer;
  sandboxRunner: SandboxRunner;
  sceneValidator?: CapturePathSceneValidator;
  scriptGenerationAgent?: ScriptGenerationAgent;
  runtimeNetworkPolicy?: RuntimeNetworkPolicy;
};

/**
 * Assembles deterministic Pipeline Stage dependencies around its Stage Agent
 * adapters. The returned dependencies preserve Pipeline ownership of stage
 * order, validation, repair, and accepted outputs.
 */
export function createProductionPipelineDependencies(
  options: ProductionPipelineDependencyOptions,
): PipelineOrchestratorDependencies {
  const browserValidator =
    options.browserValidator ??
    new PlaywrightBrowserValidator({
      ...(options.runtimeNetworkPolicy === undefined
        ? {}
        : { runtimeNetworkPolicy: options.runtimeNetworkPolicy }),
    });
  const sceneValidator =
    options.sceneValidator ??
    new DefaultCapturePathSceneValidator({
      ...(options.runtimeNetworkPolicy === undefined
        ? {}
        : { runtimeNetworkPolicy: options.runtimeNetworkPolicy }),
    });
  const preparedApplicationIdentityReviewer =
    new AgenticPreparedApplicationIdentityReviewer({
      hardTimeoutMs: preparedApplicationIdentityReviewTimeouts.hardTimeoutMs,
      runner: options.preparedApplicationIdentityReviewRunner,
      timeoutMs: preparedApplicationIdentityReviewTimeouts.inactivityTimeoutMs,
    });

  return {
    generateDemoScript(input) {
      return generateDemoScript(input, {
        ...(options.scriptGenerationAgent === undefined
          ? {}
          : { scriptGenerationAgent: options.scriptGenerationAgent }),
      });
    },
    prepareRepo(input) {
      return prepareRepo(input, { agent: options.repoPreparationAgent });
    },
    reviewPreparedApplicationIdentity:
      preparedApplicationIdentityReviewer.review.bind(
        preparedApplicationIdentityReviewer,
      ),
    reviewRepoSecurity: options.repoSecurityReviewer.review.bind(
      options.repoSecurityReviewer,
    ),
    ...(options.capturePathRepairer === undefined
      ? {}
      : {
          repairCapturePathFailure:
            options.capturePathRepairer.repairCapturePathFailure.bind(
              options.capturePathRepairer,
            ),
        }),
    screenRepoSecurity,
    validateCapturePath(input) {
      return validateCapturePath(input, {
        sceneValidator,
        runRuntimePreflight(projectInput) {
          return runDemoRuntimePreflight(projectInput, {
            browserValidator,
            nodeReleaseCatalog: options.nodeReleaseCatalog,
            ...(options.runtimeNetworkPolicy === undefined
              ? {}
              : { runtimeNetworkPolicy: options.runtimeNetworkPolicy }),
            sandboxRunner: options.sandboxRunner,
          });
        },
      });
    },
  };
}

type FreshCaptureStatePreparer = NonNullable<
  FullPipelineRunnerOptions["prepareFreshCaptureState"]
>;

type RestartPreparedDemoForFreshCapture =
  typeof restartPreparedDemoForFreshCapture;

/**
 * Resolves the browser/runtime egress policy for a production sandbox.
 *
 * Daytona sandboxes are created with `networkBlockAll: false`, so their
 * browser and runtime validation must allow the same public destinations.
 * Keeping this decision behind composition makes the provider policy explicit
 * and prevents a loopback-only browser guard from silently masking sandbox
 * network access.
 */
export function resolveProductionRuntimeNetworkPolicy(): RuntimeNetworkPolicy {
  return "unrestricted-public";
}

/** Daytona's production sandbox configuration. */
export type ProductionSandboxConfig = {
  apiKey: string;
  snapshot?: string;
  submittedCodeSnapshot?: string;
};

/** Provides Footage Capture with a fresh deterministic Daytona runtime. */
export function createDaytonaFreshCaptureStatePreparer(
  restart: RestartPreparedDemoForFreshCapture = restartPreparedDemoForFreshCapture,
): FreshCaptureStatePreparer {
  return async ({ preparedDemo }) => {
    if (preparedDemo.preparationWorkspace === undefined) {
      throw new Error(
        "Fresh Footage Capture state requires the prepared workspace.",
      );
    }

    return await restart({
      preparationManifest: preparedDemo.preparationManifest,
      preparationWorkspace: preparedDemo.preparationWorkspace,
    });
  };
}

export type ProductionPipelineOptions = ProductionAgentHarnessOptions & {
  logger?: PipelineEventLogger;
  maxScriptGenerationAttempts?: number;
  repoPreparationTimeoutMs?: number;
  repoSecurityLogger?: PipelineEventLogger;
  sandbox: ProductionSandboxConfig;
  sandboxLogSinks?: PipelineLogSink[];
};

const defaultInactivityTimeoutMs = 600_000;
const defaultHardTimeoutMs = 1_800_000;
const defaultPostRepairArtifactReadTimeoutMs = 60_000;
const defaultDraftReviewEvidenceUploadAttemptTimeoutMs = 30_000;
const defaultDraftReviewEvidenceUploadTimeoutMs = 60_250;
const defaultDraftReviewEvidenceUploadRetryDelaysMs = [250] as const;
const preparedApplicationIdentityReviewTimeouts = {
  hardTimeoutMs: defaultHardTimeoutMs,
  inactivityTimeoutMs: defaultInactivityTimeoutMs,
} as const;

/**
 * Assembles the production MakeADemo Pipeline and its Agent Harness adapters
 * without opening a workspace or network connection.
 */
export function createProductionPipeline(options: ProductionPipelineOptions) {
  const {
    logger,
    maxScriptGenerationAttempts,
    repoPreparationTimeoutMs: configuredRepoPreparationTimeoutMs,
    repoSecurityLogger,
    sandbox: sandboxConfig,
    sandboxLogSinks: configuredSandboxLogSinks,
    ...agentHarnessOptions
  } = options;

  const sandboxLogSinks = configuredSandboxLogSinks ?? [];
  const nodeReleaseCatalog = new OfficialNodejsReleaseCatalog();
  const sandboxProvider = createDaytonaProductionSandboxProvider(
    sandboxConfig,
    {
      ...(repoSecurityLogger === undefined ? {} : { repoSecurityLogger }),
      sandboxLogSinks,
    },
  );
  const agentHarness = createProductionAgentHarness({
    ...agentHarnessOptions,
    ...(logger === undefined ? {} : { logger }),
  });
  const repoPreparationTimeoutMs = readRepoPreparationTimeoutMs(
    configuredRepoPreparationTimeoutMs,
  );
  const onAgentStatus = options.onAgentStandard ?? (() => {});
  const runtimeNetworkPolicy = resolveProductionRuntimeNetworkPolicy();
  const browserToolControllerProvider = createBrowserToolControllerProvider({
    runtimeNetworkPolicy,
  });
  const repoPreparationAgent = new AgenticRepoPreparation({
    browserToolControllerProvider,
    ...(sandboxConfig.snapshot === undefined &&
    sandboxConfig.submittedCodeSnapshot === undefined
      ? {}
      : {
          cloneFailureDiagnosticsContext: {
            ...(sandboxConfig.snapshot === undefined
              ? {}
              : { daytonaSnapshot: sandboxConfig.snapshot }),
            ...(sandboxConfig.submittedCodeSnapshot === undefined
              ? {}
              : {
                  daytonaSubmittedCodeSnapshot:
                    sandboxConfig.submittedCodeSnapshot,
                }),
          },
        }),
    ...(logger === undefined ? {} : { logger }),
    nodeReleaseCatalog,
    provider: sandboxProvider.repoPreparationWorkspaceProvider,
    runtimeNetworkPolicy,
    runner: agentHarness.agentTaskRunners.repoPreparation,
    ...(repoPreparationTimeoutMs === undefined
      ? {}
      : { timeoutMs: repoPreparationTimeoutMs }),
    runRuntimePreflight: async ({ manifest, workspace }) =>
      toRepoPreparationPreflightResult(
        await runDemoRuntimePreflight(
          { preparationManifest: manifest, preparationWorkspace: workspace },
          {
            browserValidator: new PlaywrightBrowserValidator({
              runtimeNetworkPolicy,
            }),
            nodeReleaseCatalog,
            runtimeNetworkPolicy,
            sandboxRunner: sandboxProvider.createSandboxRunner({
              releaseWorkspaceOnCleanup: false,
            }),
          },
        ),
      ),
  });
  const repoSecurityReviewer = new AgenticRepoSecurityReviewer({
    hardTimeoutMs: defaultHardTimeoutMs,
    runner: agentHarness.agentTaskRunners.repoSecurityReview,
    timeoutMs: defaultInactivityTimeoutMs,
  });
  const scriptGenerationAgent = new AgenticScriptGenerator({
    browserToolControllerProvider,
    ...(logger === undefined ? {} : { logger }),
    ...(maxScriptGenerationAttempts === undefined
      ? {}
      : { maxAttempts: maxScriptGenerationAttempts }),
    runner: agentHarness.agentTaskRunners.scriptGeneration,
  });
  const capturePathRepairer = new AgenticCapturePathRepairer({
    browserToolControllerProvider,
    hardTimeoutMs: defaultHardTimeoutMs,
    logger: logger ?? createNoopLogger(),
    onStatus: onAgentStatus,
    postRepairArtifactReadTimeoutMs: defaultPostRepairArtifactReadTimeoutMs,
    runner: agentHarness.agentTaskRunners.capturePathRepair,
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
    runner: agentHarness.agentTaskRunners.draftCompositeReview,
    timeoutMs: defaultInactivityTimeoutMs,
  });

  return createMakeADemoPipeline({
    dispose: agentHarness.disposeAgentSessions,
    pipelineDependencies: createProductionPipelineDependencies({
      capturePathRepairer,
      nodeReleaseCatalog,
      preparedApplicationIdentityReviewRunner:
        agentHarness.agentTaskRunners.preparedApplicationIdentityReview,
      repoPreparationAgent,
      repoSecurityReviewer,
      sandboxRunner: sandboxProvider.createSandboxRunner({
        releaseWorkspaceOnCleanup: false,
      }),
      scriptGenerationAgent,
      runtimeNetworkPolicy,
    }),
    prepareFreshCaptureState: sandboxProvider.prepareFreshCaptureState,
    repoSecurityInputLoader: sandboxProvider.repoSecurityInputLoader,
    reviewDraftComposite: draftCompositeReviewer.review.bind(
      draftCompositeReviewer,
    ),
    runtimeNetworkPolicy,
  });
}

function createDaytonaProductionSandboxProvider(
  config: ProductionSandboxConfig,
  context: {
    repoSecurityLogger?: PipelineEventLogger;
    sandboxLogSinks: PipelineLogSink[];
  },
) {
  if (config.apiKey.length === 0) {
    throw new Error(
      "A non-empty Daytona sandbox API key is required for production pipeline runs.",
    );
  }

  const repoPreparationWorkspaceProvider =
    new DaytonaSdkPreparationWorkspaceProvider({
      apiKey: config.apiKey,
      ...(config.snapshot === undefined ? {} : { snapshot: config.snapshot }),
      ...(config.submittedCodeSnapshot === undefined
        ? {}
        : { submittedCodeSnapshot: config.submittedCodeSnapshot }),
      sandboxLogSinks: context.sandboxLogSinks,
    });

  return {
    createSandboxRunner: ({
      releaseWorkspaceOnCleanup,
    }: {
      releaseWorkspaceOnCleanup: boolean;
    }) => new PreparedWorkspaceSandboxRunner({ releaseWorkspaceOnCleanup }),
    prepareFreshCaptureState: createDaytonaFreshCaptureStatePreparer(),
    repoPreparationWorkspaceProvider,
    repoSecurityInputLoader: new DaytonaRepoSecurityInputLoader({
      ...(context.repoSecurityLogger === undefined
        ? {}
        : { logger: context.repoSecurityLogger }),
      provider: repoPreparationWorkspaceProvider,
    }),
  };
}

/**
 * Adapts Capture Path Validation's richer preflight result at production
 * assembly, so Repo Preparation depends only on its own repair-oriented port.
 */
export function toRepoPreparationPreflightResult(
  result: DemoRuntimePreflightResult,
): RepoPreparationPreflightResult {
  return {
    ...(result.accessibilitySnapshot === undefined
      ? {}
      : { accessibilitySnapshot: { ...result.accessibilitySnapshot } }),
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
    ...(result.resourceDiagnostics === undefined
      ? {}
      : { resourceDiagnostics: { ...result.resourceDiagnostics } }),
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
