import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createMakeADemoOpenCodeConfigFiles,
  createPreparedOpenCodeFiles,
  writePreparedOpenCodeFiles,
} from "./prepared-opencode-config";

describe("createMakeADemoOpenCodeConfigFiles", () => {
  it("creates the global OpenCode config without exposing Pipeline Stage tools", () => {
    const files = createMakeADemoOpenCodeConfigFiles();
    const configFile = files.find((file) => file.path === "opencode.json");
    const config = JSON.parse(configFile?.content ?? "{}");

    expect(config.model).toBe("openai/gpt-5.6-terra");
    expect(config.provider.openai.models["gpt-5.6-terra"].options).toEqual({
      reasoningEffort: "high",
    });
    expect(config.provider.openai.models["gpt-5.6-sol"].options).toEqual({
      reasoningEffort: "medium",
    });
    expect(config.agent).toBeUndefined();
    expect(config.permission).toEqual({
      "*": "allow",
      bash: "deny",
    });
    expect(config.tools).toBeUndefined();
    expect(files.some((file) => file.path.startsWith("agents/"))).toBe(false);
    expect(files.map((file) => file.path).sort()).toEqual([
      "opencode.json",
      "skills/find-docs/SKILL.md",
    ]);
    expect(JSON.stringify(files)).not.toContain(
      "makeademo_validate_preparation",
    );
  });
});

describe("createPreparedOpenCodeFiles", () => {
  it("writes prepared OpenCode files relative to an OpenCode home directory", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "makeademo-test-home-"));

    try {
      await writePreparedOpenCodeFiles(homeDirectory);

      await access(
        join(homeDirectory, ".config/opencode/skills/find-docs/SKILL.md"),
      );
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  it("includes the expected prepared file paths", () => {
    const files = createPreparedOpenCodeFiles();

    expect(files.map((file) => file.path)).toEqual([
      ".config/opencode/skills/find-docs/SKILL.md",
    ]);
  });
});
