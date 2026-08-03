import { describe, expect, it, vi } from "vitest";

import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";
import { createRepoSecurityStageTools } from "./repo-security-stage-tools";

describe("Repo Security stage tools", () => {
  it("exposes one restricted exec_command backed by the review workspace", async () => {
    const executeReadOnlyCommand = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "README.md\n",
    }));
    const workspace = {
      executeReadOnlyCommand,
    } as unknown as PreparationWorkspace;

    const tools = createRepoSecurityStageTools(workspace);
    const result = await tools[0]?.execute({ argv: ["rg", "--files"] });

    expect(tools.map((tool) => tool.name)).toEqual(["exec_command"]);
    expect(JSON.parse(result ?? "")).toMatchObject({
      exitCode: 0,
      stdout: "README.md\n",
    });
    expect(executeReadOnlyCommand).toHaveBeenCalledTimes(1);
  });
});
