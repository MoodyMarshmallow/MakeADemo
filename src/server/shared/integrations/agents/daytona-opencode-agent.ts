import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import type { ScriptGenerationAgent } from "../../../pipeline/04-script-generation/script-generation-agent.interface";
import type {
  CapturePathRepairInput,
  CapturePathRepairResult,
  CapturePathRepairer,
} from "../../../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import { validateProject } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import type {
  DraftCompositeReviewDecision,
  DraftCompositeReviewerInput,
} from "../../../pipeline/07-compositing/draft-composite-reviewer.interface";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";
import { PlaywrightBrowserValidator } from "../browser/playwright-browser-validator";
import { DaytonaSdkPreparationWorkspaceProvider } from "../daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../sandbox/daytona-sandbox-runner";
import { DaytonaOpenCodeRepoPreparation } from "./daytona-opencode-repo-preparation";
import { DaytonaOpenCodeScriptGeneration } from "./daytona-opencode-script-generation";
import { createOpenCodeProviderSandboxSecrets } from "./opencode-provider-secrets";

export type DaytonaOpenCodeAgentOptions = {
  daytonaApiKey?: string;
  daytonaSnapshot?: string;
  logger?: PipelineEventLogger;
  maxScriptGenerationAttempts?: number;
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerID: string;
  providerSecretName: string;
};

export class DaytonaOpenCodeAgent
  implements CapturePathRepairer, RepoPreparationAgent, ScriptGenerationAgent
{
  private readonly repoPreparation: DaytonaOpenCodeRepoPreparation;
  private readonly scriptGeneration: DaytonaOpenCodeScriptGeneration;

  constructor(options: DaytonaOpenCodeAgentOptions) {
    if (options.daytonaApiKey === undefined || options.daytonaApiKey === "") {
      throw new Error(
        "DAYTONA_API_KEY is required for Daytona OpenCode agent runs.",
      );
    }

    this.repoPreparation = new DaytonaOpenCodeRepoPreparation({
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      modelID: options.modelID,
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
      }),
      providerID: options.providerID,
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
    this.scriptGeneration = new DaytonaOpenCodeScriptGeneration({
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.maxScriptGenerationAttempts === undefined
        ? {}
        : { maxAttempts: options.maxScriptGenerationAttempts }),
      modelID: options.modelID,
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      providerID: options.providerID,
    });
  }

  generateScriptPackage: ScriptGenerationAgent["generateScriptPackage"] = (
    input,
  ) => this.scriptGeneration.generateScriptPackage(input);

  prepare: RepoPreparationAgent["prepare"] = (input) =>
    this.repoPreparation.prepare(input);

  repairCapturePathFailure(
    input: CapturePathRepairInput,
  ): Promise<CapturePathRepairResult> {
    return this.scriptGeneration.repairCapturePathFailure(input);
  }

  async reviewDraftComposite(
    input: DraftCompositeReviewerInput,
  ): Promise<DraftCompositeReviewDecision> {
    return this.scriptGeneration.reviewDraftComposite(input);
  }
}
