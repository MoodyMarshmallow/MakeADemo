import { describe, expect, it } from "vitest";

import { createAgentSessionRunner } from "./create-agent-session-runner";
import { PiAgentSession } from "./pi/pi-agent-session";

describe("createAgentSessionRunner", () => {
  it("creates the Pi SDK runner with Harness-owned global tools", () => {
    const runner = createAgentSessionRunner({ apiKey: "test-openai-key" });

    expect(runner).toBeInstanceOf(PiAgentSession);
  });
});
