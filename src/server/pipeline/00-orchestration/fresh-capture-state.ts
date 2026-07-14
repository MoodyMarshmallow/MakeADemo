import { restartPreparedDemoForFreshCapture } from "../../shared/integrations/sandbox/daytona-sandbox-runner";
import type { FullPipelineRunnerOptions } from "./full-pipeline-runner";

type FreshCaptureStatePreparer = NonNullable<
  FullPipelineRunnerOptions["prepareFreshCaptureState"]
>;

type RestartPreparedDemoForFreshCapture =
  typeof restartPreparedDemoForFreshCapture;

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
