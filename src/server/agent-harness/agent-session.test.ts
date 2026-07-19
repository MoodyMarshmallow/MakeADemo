import { describe, expect, it } from "vitest";

import { createAgentSession } from "../test-support/create-agent-session";

describe("AgentSession", () => {
  it("creates a provider-neutral opaque object identity", () => {
    const session = createAgentSession();

    expect(session).toBe(session);
    expect(session).not.toHaveProperty("providerSessionID");
  });
});
