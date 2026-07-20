import { defaultAgentModel } from "../agent-harness/agent-model-defaults";

export type ProductionAgentModelConfig = {
  modelID: string;
  providerID: string;
};

/** Resolves provider/model selection at the composition boundary. */
export function resolveProductionAgentModelConfig(
  input: {
    modelID?: string;
    providerID?: string;
  } = {},
): ProductionAgentModelConfig {
  const providerID = input.providerID ?? defaultAgentModel.providerID;
  if (providerID !== "openai") {
    throw new Error(
      `Unsupported production agent provider '${providerID}'. Only 'openai' is configured.`,
    );
  }
  return { modelID: input.modelID ?? defaultAgentModel.modelID, providerID };
}

/** Resolves worker provider/model overrides without leaking env policy into stages. */
export function resolveProductionAgentModelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductionAgentModelConfig {
  return resolveProductionAgentModelConfig({
    ...(env.REPO_PREPARATION_MODEL_ID === undefined
      ? {}
      : { modelID: env.REPO_PREPARATION_MODEL_ID }),
    ...(env.REPO_PREPARATION_PROVIDER_ID === undefined
      ? {}
      : { providerID: env.REPO_PREPARATION_PROVIDER_ID }),
  });
}
