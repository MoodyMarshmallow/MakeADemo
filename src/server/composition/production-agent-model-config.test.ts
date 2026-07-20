import { describe, expect, it } from "vitest";

import {
  resolveProductionAgentModelConfig,
  resolveProductionAgentModelConfigFromEnv,
} from "./production-agent-model-config";

describe("production agent model config", () => {
  it("accepts the supported OpenAI provider", () => {
    expect(
      resolveProductionAgentModelConfig({
        modelID: "gpt-5.6",
        providerID: "openai",
      }),
    ).toEqual({ modelID: "gpt-5.6", providerID: "openai" });
  });

  it("rejects unsupported provider IDs explicitly", () => {
    expect(() =>
      resolveProductionAgentModelConfig({
        modelID: "some-model",
        providerID: "anthropic",
      }),
    ).toThrow("Unsupported production agent provider");
  });

  it("rejects unsupported provider IDs from environment overrides", () => {
    expect(() =>
      resolveProductionAgentModelConfigFromEnv({
        REPO_PREPARATION_PROVIDER_ID: "anthropic",
      }),
    ).toThrow("Unsupported production agent provider");
  });
});
