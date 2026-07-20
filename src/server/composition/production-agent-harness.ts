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
import type { ProductionAgentModelConfig } from "./production-agent-model-config";
import { createProductionAgentProfiles } from "./production-agent-profiles";

export type ProductionAgentHarnessOptions = {
  agentSessionRunner?: AgentSessionRunner;
  agentModel: ProductionAgentModelConfig;
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
