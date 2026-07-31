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
import type { PipelineEventLogger } from "../shared/logging/pipeline-event-logger";
import type { ProductionAgentModelConfig } from "./production-agent-model-config";
import { createProductionAgentProfiles } from "./production-agent-profiles";

export type ProductionAgentHarnessOptions = {
  agentSessionRunner?: AgentSessionRunner;
  agentModel: ProductionAgentModelConfig;
  /** Receives durable warnings for provider retry backoff extensions. */
  logger?: Pick<PipelineEventLogger, "warn">;
  onAgentDiagnostic?: (chunk: string) => void;
  onAgentEvent?: (event: AgentTaskEvent) => void;
  onAgentStandard?: (chunk: string) => void;
  onRepoPreparationDiagnostic?: (chunk: string) => void;
  onRepoPreparationEvent?: (event: AgentTaskEvent) => void;
  onRepoPreparationStandard?: (chunk: string) => void;
  openaiApiKey?: string;
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
    ...(options.onRepoPreparationEvent === undefined &&
    options.logger === undefined
      ? {}
      : {
          onEvent: createAgentEventSink(
            options.onRepoPreparationEvent,
            options.logger,
          ),
        }),
    profile: profiles.repoPreparation,
  });
  const scriptGenerationRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    ...(options.onAgentEvent === undefined && options.logger === undefined
      ? {}
      : {
          onEvent: createAgentEventSink(options.onAgentEvent, options.logger),
        }),
    profile: profiles.scriptGeneration,
  });
  const capturePathRepairRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    ...(options.onAgentEvent === undefined && options.logger === undefined
      ? {}
      : {
          onEvent: createAgentEventSink(options.onAgentEvent, options.logger),
        }),
    profile: profiles.capturePathRepair,
  });
  const draftCompositeReviewRunner = bindAgentTaskRunner(runner, {
    classifyProviderFailure,
    ...(sharedAgentOutput === undefined ? {} : { onOutput: sharedAgentOutput }),
    ...(options.onAgentEvent === undefined && options.logger === undefined
      ? {}
      : {
          onEvent: createAgentEventSink(options.onAgentEvent, options.logger),
        }),
    profile: profiles.draftCompositeReview,
  });
  return {
    agentTaskRunners: {
      capturePathRepair: capturePathRepairRunner,
      draftCompositeReview: draftCompositeReviewRunner,
      repoPreparation: repoPreparationRunner,
      scriptGeneration: scriptGenerationRunner,
    },
    disposeAgentSessions: async () => {
      await runner.dispose?.();
    },
  };
}

function createAgentEventSink(
  onEvent: ((event: AgentTaskEvent) => void) | undefined,
  logger: Pick<PipelineEventLogger, "warn"> | undefined,
): (event: AgentTaskEvent) => void {
  return (event) => {
    onEvent?.(event);
    if (
      logger !== undefined &&
      event.kind === "audit" &&
      event.event === "agent-task.provider-retry"
    ) {
      void logger
        .warn(
          {
            event: event.event,
            metadata: sanitizeProviderRetryMetadata(event.metadata),
          },
          "Agent provider retry extended its hard deadline.",
        )
        .catch(() => undefined);
    }
  };
}

const providerRetryMetadataKeys = [
  "appliedDelayMs",
  "appliedHardTimeoutExtensionMs",
  "appliedInactivityTimeoutExtensionMs",
  "attempt",
  "capped",
  "cumulativeDelayMs",
  "delayMs",
  "maxAttempts",
  "reason",
  "requestedDelayMs",
] as const;

function sanitizeProviderRetryMetadata(
  metadata: Readonly<Record<string, boolean | number | string>> | undefined,
): Record<string, unknown> {
  if (metadata === undefined) return {};
  return Object.fromEntries(
    providerRetryMetadataKeys.flatMap((key) => {
      const value = metadata[key];
      return typeof value === "number" ||
        typeof value === "boolean" ||
        (key === "reason" && typeof value === "string")
        ? [[key, value]]
        : [];
    }),
  );
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
