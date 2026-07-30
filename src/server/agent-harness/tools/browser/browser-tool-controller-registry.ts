import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import type { RuntimeNetworkPolicy } from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";
import {
  type BrowserToolController,
  createBrowserToolController,
} from "./browser-tool-controller";

type BrowserToolControllerContext = {
  deadlineAt: number | undefined;
  localUrl: string;
  signal?: AbortSignal;
  workspace: PreparationWorkspace;
};

/**
 * Supplies the stable browser controller for one Preparation Workspace and
 * refreshes its backend-owned context before each authorized agent turn.
 */
export interface BrowserToolControllerProvider {
  forWorkspace(input: BrowserToolControllerContext): BrowserToolController;
}

/**
 * Creates a production browser-controller provider without retaining released
 * workspaces. A WeakMap preserves controller identity across Pipeline Stages
 * while allowing workspace release to determine its lifetime.
 */
export function createBrowserToolControllerProvider(
  options: {
    runtimeNetworkPolicy?: RuntimeNetworkPolicy;
  } = {},
): BrowserToolControllerProvider {
  const controllers = new WeakMap<
    PreparationWorkspace,
    BrowserToolController
  >();

  return {
    forWorkspace(input) {
      let controller = controllers.get(input.workspace);
      if (controller === undefined) {
        controller = createBrowserToolController({
          ...input,
          ...(options.runtimeNetworkPolicy === undefined
            ? {}
            : { runtimeNetworkPolicy: options.runtimeNetworkPolicy }),
        });
        controllers.set(input.workspace, controller);
      } else {
        controller.updateContext(input);
      }
      return controller;
    },
  };
}
