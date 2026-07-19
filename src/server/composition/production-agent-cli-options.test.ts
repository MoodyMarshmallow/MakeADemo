import { describe, expect, it } from "vitest";

import { parseProductionAgentCliArgs } from "./production-agent-cli-options";

describe("parseProductionAgentCliArgs", () => {
  it("defaults production runs to the configured default agent model", () => {
    expect(
      parseProductionAgentCliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
      ]),
    ).toMatchObject({
      agentModel: { modelID: "gpt-5.6-terra", providerID: "openai" },
    });
  });

  it("parses provider and model overrides at the Composition boundary", () => {
    expect(
      parseProductionAgentCliArgs([
        "--repo",
        "https://github.com/example/app",
        "--commit",
        "0123456789abcdef0123456789abcdef01234567",
        "--feature",
        "validation dashboard",
        "--feature",
        "script package",
        "--doc",
        "./brief.md",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--workspace-id",
        "workspace_test",
      ]),
    ).toEqual({
      agentModel: { modelID: "gpt-5.5", providerID: "openai" },
      pipeline: {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        docs: ["./brief.md"],
        features: ["validation dashboard", "script package"],
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_test",
      },
    });
  });
});
