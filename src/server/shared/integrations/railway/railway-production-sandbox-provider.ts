import type { FullPipelineRunnerOptions } from "../../../pipeline/00-orchestration/job/full-pipeline-runner";
import type { RepoSecurityInputLoader } from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-input-loader.interface";
import type { PreparationWorkspaceProvider } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { SandboxRunner } from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/sandbox-runner.interface";
import {
  PreparedWorkspaceSandboxRunner,
  restartPreparedDemoForFreshCapture,
} from "../sandbox/prepared-workspace-sandbox-runner";
import { RailwayPreparationWorkspaceProvider } from "./railway-preparation-workspace-provider";
import { railwayProductionTemplateRecipe } from "./railway-production-template-recipe";
import { RailwayRepoSecurityInputLoader } from "./railway-repo-security-input-loader";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";
import { RailwaySdkSandboxGateway } from "./railway-sdk-sandbox-gateway";

export type RailwayProductionSandboxProviderConfig = {
  environmentId: string;
  projectToken: string;
};

export type RailwayProductionSandboxProvider = {
  createSandboxRunner(input: {
    releaseWorkspaceOnCleanup: boolean;
  }): SandboxRunner;
  prepareFreshCaptureState: NonNullable<
    FullPipelineRunnerOptions["prepareFreshCaptureState"]
  >;
  repoPreparationWorkspaceProvider: PreparationWorkspaceProvider;
  repoSecurityInputLoader: RepoSecurityInputLoader;
};

/**
 * Builds Railway's complete provider bundle without reading process
 * environment. Composition supplies its dedicated project token and exact
 * environment, keeping Railway credentials out of controllers and stages.
 */
export function createRailwayProductionSandboxProvider(
  config: RailwayProductionSandboxProviderConfig,
  dependencies: { gateway?: RailwaySandboxGateway } = {},
): RailwayProductionSandboxProvider {
  const gateway =
    dependencies.gateway ??
    new RailwaySdkSandboxGateway({
      environmentId: config.environmentId,
      projectToken: config.projectToken,
      templateRecipe: railwayProductionTemplateRecipe,
    });
  const repoPreparationWorkspaceProvider =
    new RailwayPreparationWorkspaceProvider({ gateway });
  return {
    createSandboxRunner: ({ releaseWorkspaceOnCleanup }) =>
      new PreparedWorkspaceSandboxRunner({ releaseWorkspaceOnCleanup }),
    prepareFreshCaptureState: async ({ preparedDemo }) => {
      if (preparedDemo.preparationWorkspace === undefined) {
        throw new Error(
          "Fresh Footage Capture state requires the prepared workspace.",
        );
      }
      return await restartPreparedDemoForFreshCapture({
        preparationManifest: preparedDemo.preparationManifest,
        preparationWorkspace: preparedDemo.preparationWorkspace,
      });
    },
    repoPreparationWorkspaceProvider,
    repoSecurityInputLoader: new RailwayRepoSecurityInputLoader(gateway),
  };
}
