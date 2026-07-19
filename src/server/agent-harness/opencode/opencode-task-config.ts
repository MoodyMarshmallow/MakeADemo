import { createOpenCodeTaskWorkspaceConfigurator } from "./opencode-task-workspace-configurator";
import type { PreparedOpenCodeFile } from "./prepared-opencode-config";

/**
 * Produces isolated OpenCode task configuration: base runtime config, global
 * tools, then tools scoped to the active Pipeline stage.
 */
export function createOpenCodeTaskConfigFiles(
  stageToolFiles: readonly PreparedOpenCodeFile[] = [],
): PreparedOpenCodeFile[] {
  return createOpenCodeTaskWorkspaceConfigurator().createTaskConfigFiles(
    stageToolFiles,
  );
}
