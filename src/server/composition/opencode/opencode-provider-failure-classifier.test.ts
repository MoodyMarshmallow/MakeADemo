import { describe, expect, it } from "vitest";

import { classifyOpenCodeProviderFailure } from "./opencode-provider-failure-classifier";

describe("classifyOpenCodeProviderFailure", () => {
  it.each([
    ["dtn_secr********test", "provider-auth-secret-reference"],
    ["invalid api key", "provider-auth-invalid"],
    ["rate limit exceeded", "provider"],
  ])("classifies %s at the provider boundary", (message, category) => {
    expect(classifyOpenCodeProviderFailure(message)).toBe(category);
  });
});
