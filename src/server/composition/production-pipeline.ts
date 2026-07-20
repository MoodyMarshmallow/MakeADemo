import type { FullPipelineRunnerOptions } from "../pipeline/00-orchestration/job/full-pipeline-runner";
import type { PipelineOrchestratorDependencies } from "../pipeline/00-orchestration/job/pipeline-orchestrator";
import { screenRepoSecurity } from "../pipeline/02-repo-security-screen/repo-security-screen";
import type { RepoPreparationAgent } from "../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { prepareRepo } from "../pipeline/03-repo-preparation/repo-preparer";
import { DefaultDemoPlanner } from "../pipeline/04-script-generation/demo-planning/default-demo-planner";
import { PreparationManifestProjectExplorer } from "../pipeline/04-script-generation/project-exploration/preparation-manifest-project-explorer";
import { DefaultScriptComposer } from "../pipeline/04-script-generation/script-composition/default-script-composer";
import type { ScriptGenerationAgent } from "../pipeline/04-script-generation/script-generation-agent.interface";
import { generateDemoScriptPackage } from "../pipeline/04-script-generation/script-generation-orchestrator";
import type { CapturePathRepairer } from "../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import {
  type CapturePathSceneValidator,
  validateCapturePath,
} from "../pipeline/05-capture-path-validation/capture-path-validator";
import { DefaultCapturePathSceneValidator } from "../pipeline/05-capture-path-validation/playwright-capture-path-scene-validator";
import type { BrowserValidator } from "../pipeline/05-capture-path-validation/project-runtime-preflight/browser-validator.interface";
import { validateProject } from "../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import type { SandboxRunner } from "../pipeline/05-capture-path-validation/project-runtime-preflight/sandbox-runner.interface";
import { PlaywrightBrowserValidator } from "../shared/integrations/browser/playwright-browser-validator";
import { DaytonaRepoSecurityInputLoader } from "../shared/integrations/daytona/daytona-repo-security-input-loader";
import { DaytonaSdkPreparationWorkspaceProvider } from "../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import {
  DaytonaSandboxRunner,
  restartPreparedDemoForFreshCapture,
} from "../shared/integrations/sandbox/daytona-sandbox-runner";
import type {
  PipelineEventLogger,
  PipelineLogSink,
} from "../shared/logging/pipeline-event-logger";
import {
  type ProductionAgentHarnessOptions,
  createProductionAgentHarness,
} from "./production-agent-harness";

export type ProductionPipelineDependencyOptions = {
  browserValidator?: BrowserValidator;
  capturePathRepairer?: CapturePathRepairer;
  repoPreparationAgent: RepoPreparationAgent;
  sandboxRunner: SandboxRunner;
  sceneValidator?: CapturePathSceneValidator;
  scriptGenerationAgent?: ScriptGenerationAgent;
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
    options.browserValidator ?? new PlaywrightBrowserValidator();
  const sceneValidator =
    options.sceneValidator ?? new DefaultCapturePathSceneValidator();

  return {
    generateScriptPackage(input) {
      return generateDemoScriptPackage(input, {
        demoPlanner: new DefaultDemoPlanner(),
        projectExplorer: new PreparationManifestProjectExplorer(),
        ...(options.scriptGenerationAgent === undefined
          ? {}
          : { scriptGenerationAgent: options.scriptGenerationAgent }),
        scriptComposer: new DefaultScriptComposer(),
      });
    },
    prepareRepo(input) {
      return prepareRepo(input, { agent: options.repoPreparationAgent });
    },
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
        validateProject(projectInput) {
          return validateProject(projectInput, {
            browserValidator,
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

export type ProductionPipelineOptions = Omit<
  ProductionAgentHarnessOptions,
  | "repoPreparationCloneFailureDiagnosticsContext"
  | "repoPreparationWorkspaceProvider"
> & {
  daytonaApiKey: string;
  daytonaSnapshot?: string;
  daytonaSubmittedCodeSnapshot?: string;
  repoSecurityLogger?: PipelineEventLogger;
  sandboxLogSinks?: PipelineLogSink[];
};

/**
 * Assembles the production MakeADemo Pipeline and its Agent Harness adapters
 * without opening a workspace or network connection.
 */
export function createProductionPipeline(options: ProductionPipelineOptions) {
  const {
    daytonaApiKey,
    daytonaSnapshot,
    daytonaSubmittedCodeSnapshot,
    repoSecurityLogger,
    sandboxLogSinks: configuredSandboxLogSinks,
    ...agentHarnessOptions
  } = options;

  if (daytonaApiKey.length === 0) {
    throw new Error(
      "DAYTONA_API_KEY is required for production pipeline runs.",
    );
  }

  const sandboxLogSinks = configuredSandboxLogSinks ?? [];
  const repoSecurityInputLoader = new DaytonaRepoSecurityInputLoader({
    apiKey: daytonaApiKey,
    ...(repoSecurityLogger === undefined ? {} : { logger: repoSecurityLogger }),
    ...(daytonaSnapshot === undefined ? {} : { snapshot: daytonaSnapshot }),
    sandboxLogSinks,
  });
  const repoPreparationWorkspaceProvider =
    new DaytonaSdkPreparationWorkspaceProvider({
      apiKey: daytonaApiKey,
      ...(daytonaSnapshot === undefined ? {} : { snapshot: daytonaSnapshot }),
      ...(daytonaSubmittedCodeSnapshot === undefined
        ? {}
        : { submittedCodeSnapshot: daytonaSubmittedCodeSnapshot }),
      sandboxLogSinks,
    });
  const agentHarness = createProductionAgentHarness({
    ...agentHarnessOptions,
    ...(daytonaSnapshot === undefined &&
    daytonaSubmittedCodeSnapshot === undefined
      ? {}
      : {
          repoPreparationCloneFailureDiagnosticsContext: {
            ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
            ...(daytonaSubmittedCodeSnapshot === undefined
              ? {}
              : {
                  daytonaSubmittedCodeSnapshot: daytonaSubmittedCodeSnapshot,
                }),
          },
        }),
    repoPreparationWorkspaceProvider,
  });

  return {
    disposeAgentSessions: agentHarness.disposeAgentSessions,
    pipelineDependencies: createProductionPipelineDependencies({
      capturePathRepairer: agentHarness.capturePathRepairer,
      repoPreparationAgent: agentHarness.repoPreparationAgent,
      sandboxRunner: new DaytonaSandboxRunner(),
      scriptGenerationAgent: agentHarness.scriptGenerationAgent,
    }),
    prepareFreshCaptureState: createDaytonaFreshCaptureStatePreparer(),
    repoSecurityInputLoader,
    reviewDraftComposite: agentHarness.reviewDraftComposite,
  };
}
