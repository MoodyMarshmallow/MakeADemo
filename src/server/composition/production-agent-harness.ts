import type { AgentSessionRunner } from "../agent-harness/agent-session-runner.interface";
import {
  type AgentTaskOutputSinkEvent,
  bindAgentTaskRunner,
} from "../agent-harness/bind-agent-task-runner";
import { createAgentSessionRunner } from "../agent-harness/create-agent-session-runner";
import { createOpenCodeTaskWorkspaceConfigurator } from "../agent-harness/opencode/opencode-task-workspace-configurator";
import { createPreCapturePipelineDependencies } from "../pipeline/00-orchestration/pre-capture-pipeline";
import { AgenticRepoPreparation } from "../pipeline/03-repo-preparation/agent-task/agentic-repo-preparation";
import { repoPreparationAgentToolScope } from "../pipeline/03-repo-preparation/agent-task/tools/repo-preparation-tool-protocol";
import { AgenticScriptGenerator } from "../pipeline/04-script-generation/agent-task/agentic-script-generator";
import { AgenticCapturePathRepairer } from "../pipeline/05-capture-path-validation/agent-task/agentic-capture-path-repairer";
import { validateProject } from "../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import { AgenticDraftCompositeReviewer } from "../pipeline/07-compositing/agent-task/agentic-draft-composite-reviewer";
import { PlaywrightBrowserValidator } from "../shared/integrations/browser/playwright-browser-validator";
import { createOpenCodeProviderSandboxSecrets } from "../shared/integrations/daytona/daytona-opencode-provider-secrets";
import { DaytonaSdkPreparationWorkspaceProvider } from "../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../shared/integrations/sandbox/daytona-sandbox-runner";
import {
  type PipelineEventLogger,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../shared/logging/pipeline-event-logger";
import { classifyOpenCodeProviderFailure } from "./opencode/opencode-provider-failure-classifier";
import { createRepoPreparationOpenCodeToolFiles } from "./opencode/repo-preparation-opencode-tools";
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
  daytonaApiKey: string;
  daytonaSnapshot?: string;
  daytonaSubmittedCodeSnapshot?: string;
  logger?: PipelineEventLogger;
  maxScriptGenerationAttempts?: number;
  agentModel: ProductionAgentModelConfig;
  onAgentDiagnostic?: (chunk: string) => void;
  onAgentStandard?: (chunk: string) => void;
  onRepoPreparationDiagnostic?: (chunk: string) => void;
  onRepoPreparationStandard?: (chunk: string) => void;
  providerSecretName: string;
  repoPreparationTimeoutMs?: number;
  sandboxLogSinks?: PipelineLogSink[];
};

/** Assembles production agent adapters without opening a workspace or network connection. */
export function createProductionAgentHarness(
  options: ProductionAgentHarnessOptions,
) {
  if (options.daytonaApiKey.length === 0) {
    throw new Error("DAYTONA_API_KEY is required for production agent runs.");
  }

  const sandboxLogSinks = options.sandboxLogSinks ?? [];
  const repoSecurityProvider = new DaytonaSdkPreparationWorkspaceProvider({
    apiKey: options.daytonaApiKey,
    ...(options.daytonaSnapshot === undefined
      ? {}
      : { snapshot: options.daytonaSnapshot }),
    sandboxLogSinks,
  });
  const agentWorkspaceProvider = new DaytonaSdkPreparationWorkspaceProvider({
    apiKey: options.daytonaApiKey,
    secrets: createOpenCodeProviderSandboxSecrets({
      providerID: options.agentModel.providerID,
      providerSecretName: options.providerSecretName,
    }),
    ...(options.daytonaSnapshot === undefined
      ? {}
      : { snapshot: options.daytonaSnapshot }),
    ...(options.daytonaSubmittedCodeSnapshot === undefined
      ? {}
      : { submittedCodeSnapshot: options.daytonaSubmittedCodeSnapshot }),
    sandboxLogSinks,
  });
  const taskWorkspaceConfigurator = createOpenCodeTaskWorkspaceConfigurator();
  const repoPreparationConfigDirectory =
    taskWorkspaceConfigurator.configDirectoryForScope(
      repoPreparationAgentToolScope,
    );
  const runner =
    options.agentSessionRunner ??
    createAgentSessionRunner({
      configDirectoriesByToolScope: {
        [repoPreparationAgentToolScope]: repoPreparationConfigDirectory,
      },
    });
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
    classifyProviderFailure: classifyOpenCodeProviderFailure,
    dangerouslySkipPermissions: false,
    ...(repoPreparationOutput === undefined
      ? {}
      : { onOutput: repoPreparationOutput }),
    prepareWorkspace: async ({ timeoutMs, toolScope, workspace }) => {
      const result = await workspace.execute(
        taskWorkspaceConfigurator.createWriteCommand([
          {
            scope: toolScope,
            stageToolFiles: createRepoPreparationOpenCodeToolFiles(),
          },
        ]),
        {
          env: {},
          timeoutMs,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to configure the ${toolScope} agent workspace: ${[result.stderr, result.stdout].filter(Boolean).join("\n")}`,
        );
      }
    },
    profile: profiles.repoPreparation,
  });
  const scriptGenerationRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure: classifyOpenCodeProviderFailure,
    dangerouslySkipPermissions: true,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    profile: profiles.scriptGeneration,
  });
  const capturePathRepairRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure: classifyOpenCodeProviderFailure,
    dangerouslySkipPermissions: true,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    profile: profiles.capturePathRepair,
  });
  const draftCompositeReviewRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure: classifyOpenCodeProviderFailure,
    dangerouslySkipPermissions: true,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    profile: profiles.draftCompositeReview,
  });
  const logger = options.logger;
  const repoPreparationTimeoutMs = readRepoPreparationTimeoutMs(
    options.repoPreparationTimeoutMs,
  );
  const onAgentStatus = options.onAgentStandard ?? (() => {});
  const repoPreparationAgent = new AgenticRepoPreparation({
    cloneFailureDiagnosticsContext: {
      ...(options.daytonaSnapshot === undefined
        ? {}
        : { daytonaSnapshot: options.daytonaSnapshot }),
      ...(options.daytonaSubmittedCodeSnapshot === undefined
        ? {}
        : {
            daytonaSubmittedCodeSnapshot: options.daytonaSubmittedCodeSnapshot,
          }),
    },
    ...(logger === undefined ? {} : { logger }),
    provider: agentWorkspaceProvider,
    runner: repoPreparationRunner,
    ...(repoPreparationTimeoutMs === undefined
      ? {}
      : { timeoutMs: repoPreparationTimeoutMs }),
    validatePreparation: ({ manifest, workspace }) =>
      validateProject(
        { preparationManifest: manifest, preparationWorkspace: workspace },
        {
          browserValidator: new PlaywrightBrowserValidator(),
          sandboxRunner: new DaytonaSandboxRunner({
            releaseWorkspaceOnCleanup: false,
          }),
        },
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
  const preCaptureDependencies = createPreCapturePipelineDependencies({
    capturePathRepairer,
    repoPreparationAgent,
    sandboxRunner: new DaytonaSandboxRunner(),
    scriptGenerationAgent,
  });

  return {
    agentTaskRunners: {
      capturePathRepair: capturePathRepairRunner,
      draftCompositeReview: draftCompositeReviewRunner,
      repoPreparation: repoPreparationRunner,
      scriptGeneration: scriptGenerationRunner,
    },
    capturePathRepairer,
    preCaptureDependencies,
    repoPreparationAgent,
    repoSecurityProvider,
    reviewDraftComposite: draftCompositeReviewer.review.bind(
      draftCompositeReviewer,
    ),
    scriptGenerationAgent,
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
