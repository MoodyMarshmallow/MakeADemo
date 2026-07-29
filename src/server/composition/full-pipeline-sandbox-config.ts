import type {
  ProductionSandboxConfig,
  SandboxProviderId,
} from "./production-pipeline";

type PipelineEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the full-Pipeline CLI's provider configuration from explicit
 * credentials. Railway never falls back to ambient Railway CLI credentials.
 */
export function readFullPipelineSandboxConfig(input: {
  daytonaSnapshot?: string;
  daytonaSubmittedCodeSnapshot?: string;
  environment: PipelineEnvironment;
  provider: SandboxProviderId;
}): ProductionSandboxConfig {
  if (input.provider === "railway") {
    return {
      environmentId: readRequiredEnvironment(
        input.environment,
        "MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID",
      ),
      projectToken: readRequiredEnvironment(
        input.environment,
        "MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN",
      ),
      provider: "railway",
    };
  }

  return {
    apiKey: readRequiredEnvironment(input.environment, "DAYTONA_API_KEY"),
    ...(input.daytonaSnapshot === undefined
      ? {}
      : { snapshot: input.daytonaSnapshot }),
    ...(input.daytonaSubmittedCodeSnapshot === undefined
      ? {}
      : { submittedCodeSnapshot: input.daytonaSubmittedCodeSnapshot }),
    provider: "daytona",
  };
}

function readRequiredEnvironment(
  environment: PipelineEnvironment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for full pipeline runs.`);
  }
  return value;
}
