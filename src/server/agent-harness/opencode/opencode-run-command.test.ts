import { describe, expect, it } from "vitest";

import {
  createOpenCodeRunCommand,
  createOpenCodeRunEnv,
} from "./opencode-run-command";

describe("createOpenCodeRunCommand", () => {
  it("composes universal harness policy with the active Pipeline task", () => {
    const taskPrompt =
      "Inspect the prepared application and produce its Demo Script.";

    const command = createOpenCodeRunCommand({
      dangerouslySkipPermissions: true,
      model: "openai/gpt-5.6-terra",
      sessionID: "retained-session",
      taskPrompt,
    });

    expect(command).toContain("opencode run");
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("--format json");
    expect(command).toContain("--dir /workspace");
    expect(command).toContain("--session 'retained-session'");
    expect(command).toContain("--model 'openai/gpt-5.6-terra'");
    expect(command).toContain("# MakeADemo Universal Agent Policy");
    expect(command).toContain("# Pipeline Task");
    expect(command).toContain(taskPrompt);
  });

  it("uses the task's isolated OpenCode configuration directory", () => {
    expect(
      createOpenCodeRunEnv("/tmp/makeademo/opencode-script-generation"),
    ).toEqual({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_DIR: "/tmp/makeademo/opencode-script-generation",
      OPENCODE_ENABLE_EXA: "1",
    });
  });
});
