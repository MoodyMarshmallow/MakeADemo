import type { RepoSecurityInput } from "../../02-repo-security-screen/repo-security-screen";
import { readRepoSecurityInput } from "../../02-repo-security-screen/repository-loading/repo-security-input";
import type { RepoSecurityInputLoader } from "../../02-repo-security-screen/repository-loading/repo-security-input-loader.interface";
import {
  type FullPipelineResult,
  type FullPipelineRunnerOptions,
  runFullPipelineJob,
} from "./full-pipeline-runner";
import { isPipelineCancellationError } from "./pipeline-cancellation";
import type { PipelineJobInput } from "./pipeline-job";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

type ControllerOwnedRunnerOptions = Pick<
  FullPipelineRunnerOptions,
  | "prepareFreshCaptureState"
  | "repoSecurityInputFailure"
  | "reviewDraftComposite"
  | "runtimeNetworkPolicy"
>;

/**
 * Per-run settings a controller may supply without gaining access to Pipeline
 * Stage dependencies or retained-agent lifecycle details.
 */
type MakeADemoPipelineRunOptions = Omit<
  FullPipelineRunnerOptions,
  keyof ControllerOwnedRunnerOptions
>;

/**
 * The controller-facing request for one complete MakeADemo Pipeline Job.
 * Repo Security Screen input is intentionally absent: the Pipeline owns its
 * trusted loading policy and supplies that deterministic stage input itself.
 */
type MakeADemoPipelineRunInput = Omit<PipelineJobInput, "repoSecurity"> & {
  githubInstallationId?: string;
  repoVisibility?: "private" | "public";
  runOptions?: MakeADemoPipelineRunOptions;
};

/**
 * The complete MakeADemo Pipeline capability exposed to controllers.
 *
 * `run` always loads Repo Security Screen input before stage orchestration;
 * callers must not construct stage dependencies, own fresh-capture restarts,
 * or manage the retained Draft Composite reviewer. `dispose` must be called
 * once after the controller has finished all runs to release retained agent
 * sessions and any other composition-owned resources.
 */
export interface MakeADemoPipeline {
  dispose(): Promise<void>;
  run(input: MakeADemoPipelineRunInput): Promise<FullPipelineResult>;
}

/** Internal production-composition inputs for the controller-facing seam. */
export type MakeADemoPipelineOptions = {
  dispose?: () => Promise<void>;
  pipelineDependencies: PipelineOrchestratorDependencies;
  repoSecurityInputLoader: RepoSecurityInputLoader;
} & ControllerOwnedRunnerOptions;

/**
 * Creates the narrow controller-facing MakeADemo Pipeline interface.
 * Composition supplies all infrastructure and stage collaborators once, while
 * controllers receive only `run` and `dispose`.
 */
export function createMakeADemoPipeline(
  options: MakeADemoPipelineOptions,
): MakeADemoPipeline {
  return {
    dispose: options.dispose ?? (async () => undefined),
    async run(input) {
      const {
        githubInstallationId,
        repoVisibility = "public",
        runOptions = {},
        ...jobInput
      } = input;
      let repoSecurity = unavailableRepoSecurityInput();
      let preparationWorkspace: PipelineJobInput["preparationWorkspace"];
      let baselineSourceControlledPaths: string[] | undefined;
      let repoSecurityInputFailure = false;
      if (runOptions.signal?.aborted !== true) {
        try {
          const loaded = await readRepoSecurityInput(
            options.repoSecurityInputLoader,
            jobInput.repoUrl,
            {
              commitSha: jobInput.commitSha,
              ...(repoVisibility !== "private" ||
              githubInstallationId === undefined
                ? {}
                : { githubInstallationId }),
              repoVisibility,
              ...(runOptions.deadlineAt === undefined
                ? {}
                : { deadlineAt: runOptions.deadlineAt }),
              ...(runOptions.signal === undefined
                ? {}
                : { signal: runOptions.signal }),
            },
          );
          repoSecurity = loaded.repoSecurity;
          preparationWorkspace = loaded.preparationWorkspace;
          baselineSourceControlledPaths = loaded.baselineSourceControlledPaths;
        } catch (error) {
          if (isPipelineCancellationError(error)) {
            // The full runner owns the durable terminal cancellation artifact.
          } else {
            repoSecurityInputFailure = true;
          }
        }
      }

      return await runFullPipelineJob(
        {
          ...jobInput,
          repoSecurity,
          ...(preparationWorkspace === undefined
            ? {}
            : { preparationWorkspace }),
          ...(baselineSourceControlledPaths === undefined
            ? {}
            : { baselineSourceControlledPaths }),
        },
        options.pipelineDependencies,
        {
          ...runOptions,
          ...(repoSecurityInputFailure
            ? { repoSecurityInputFailure: true as const }
            : {}),
          ...(options.prepareFreshCaptureState === undefined
            ? {}
            : { prepareFreshCaptureState: options.prepareFreshCaptureState }),
          ...(options.reviewDraftComposite === undefined
            ? {}
            : { reviewDraftComposite: options.reviewDraftComposite }),
          ...(options.runtimeNetworkPolicy === undefined
            ? {}
            : { runtimeNetworkPolicy: options.runtimeNetworkPolicy }),
        },
      );
    },
  };
}

function unavailableRepoSecurityInput(): RepoSecurityInput {
  return { scannerReports: [] };
}
