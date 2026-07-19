import { describe, expect, it } from "vitest";

import { createOpenCodeTaskConfigFiles } from "./opencode-task-config";

describe("createOpenCodeTaskConfigFiles", () => {
  it("keeps Stage Agent Tools out of the shared base and exposes each once for that task", () => {
    const stageToolFiles = [
      { content: "stage tool", path: "plugins/stage-tool.ts" },
    ];
    const baseBeforeStage = createOpenCodeTaskConfigFiles();
    const taskConfig = createOpenCodeTaskConfigFiles(stageToolFiles);
    const baseAfterStage = createOpenCodeTaskConfigFiles();

    for (const toolFile of stageToolFiles) {
      expect(baseBeforeStage).not.toContainEqual(toolFile);
      expect(taskConfig.filter((file) => file.path === toolFile.path)).toEqual([
        toolFile,
      ]);
      expect(baseAfterStage).not.toContainEqual(toolFile);
    }
  });
});
