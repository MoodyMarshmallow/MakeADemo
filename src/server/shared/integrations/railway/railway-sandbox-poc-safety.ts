export type RailwayPocConfiguration = {
  environmentId: string;
  projectToken: string;
};

/**
 * Reads the explicit inputs for the opt-in Railway POC. When live execution is
 * requested, both dedicated values must be present; ambient Railway
 * credentials are intentionally ignored.
 */
export function readRailwayPocConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RailwayPocConfiguration | undefined {
  if (environment.RUN_RAILWAY_SANDBOX_POC !== "1") return undefined;

  const projectToken =
    environment.MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN?.trim();
  const environmentId =
    environment.MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID?.trim();
  if (!projectToken || !environmentId) {
    throw new Error(
      "RUN_RAILWAY_SANDBOX_POC=1 requires MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN and MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID.",
    );
  }

  return { projectToken, environmentId };
}
