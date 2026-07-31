import type { ProductionSandboxConfig } from "./production-pipeline";

type PipelineEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the full-Pipeline CLI's Daytona configuration from explicit
 * credentials.
 */
export function readFullPipelineSandboxConfig(input: {
  daytonaSnapshot?: string;
  daytonaSubmittedCodeSnapshot?: string;
  environment: PipelineEnvironment;
}): ProductionSandboxConfig {
  return {
    apiKey: readRequiredEnvironment(input.environment, "DAYTONA_API_KEY"),
    ...(input.daytonaSnapshot === undefined
      ? {}
      : { snapshot: input.daytonaSnapshot }),
    ...(input.daytonaSubmittedCodeSnapshot === undefined
      ? {}
      : { submittedCodeSnapshot: input.daytonaSubmittedCodeSnapshot }),
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
