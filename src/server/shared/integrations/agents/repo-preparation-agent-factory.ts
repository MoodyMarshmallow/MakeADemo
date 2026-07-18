import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { validateProject } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import type {
  PipelineEventLogger,
  PipelineLogSink,
} from "../../logging/pipeline-event-logger";
import { PlaywrightBrowserValidator } from "../browser/playwright-browser-validator";
import { DaytonaSdkPreparationWorkspaceProvider } from "../daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../sandbox/daytona-sandbox-runner";
import { DaytonaOpenCodeRepoPreparation } from "./daytona-opencode-repo-preparation";
import { createOpenCodeProviderSandboxSecrets } from "./opencode-provider-secrets";

export type RepoPreparationAgentFactoryOptions = {
  daytonaApiKey?: string;
  daytonaSnapshot?: string;
  daytonaSubmittedCodeSnapshot?: string;
  logger?: PipelineEventLogger;
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerID: string;
  providerSecretName: string;
  repoPreparationTimeoutMs?: number;
  sandboxLogSinks?: PipelineLogSink[];
};

export function createRepoPreparationAgent(
  options: RepoPreparationAgentFactoryOptions,
): RepoPreparationAgent {
  if (options.daytonaApiKey === undefined || options.daytonaApiKey === "") {
    throw new Error(
      "DAYTONA_API_KEY is required for Daytona Repo Preparation.",
    );
  }

  const timeoutMs =
    options.repoPreparationTimeoutMs ?? readRepoPreparationTimeoutMsFromEnv();

  return new DaytonaOpenCodeRepoPreparation({
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
    modelID: options.modelID,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    provider: new DaytonaSdkPreparationWorkspaceProvider({
      apiKey: options.daytonaApiKey,
      secrets: createOpenCodeProviderSandboxSecrets({
        providerID: options.providerID,
        providerSecretName: options.providerSecretName,
      }),
      ...(options.daytonaSnapshot === undefined
        ? {}
        : { snapshot: options.daytonaSnapshot }),
      ...(options.daytonaSubmittedCodeSnapshot === undefined
        ? {}
        : { submittedCodeSnapshot: options.daytonaSubmittedCodeSnapshot }),
      sandboxLogSinks: options.sandboxLogSinks ?? [],
    }),
    providerID: options.providerID,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
}

export function readRepoPreparationTimeoutMsFromEnv(): number | undefined {
  const rawValue = process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const trimmedValue = rawValue.trim();
  if (!/^[1-9]\d*$/.test(trimmedValue)) {
    throw new Error(
      "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS must be a positive integer millisecond value.",
    );
  }

  const timeoutMs = Number(trimmedValue);
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error(
      "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS must be a positive integer millisecond value.",
    );
  }

  return timeoutMs;
}
