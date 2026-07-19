import { describe, expect, it } from "vitest";

import { createMeaningfulActivityTracker } from "./opencode-meaningful-activity-timeout";
import { defaultOpenCodeModel } from "./opencode-model-defaults";
import { createOpenCodeProtocolTracker } from "./opencode-protocol";
import { createMakeADemoOpenCodeConfigFiles } from "./prepared-opencode-config";

describe("OpenCode harness modules", () => {
  it("are available from the Agent Harness OpenCode implementation", () => {
    expect(createMakeADemoOpenCodeConfigFiles).toBeTypeOf("function");
    expect(defaultOpenCodeModel.providerID).toBe("openai");
    expect(createMeaningfulActivityTracker).toBeTypeOf("function");
    expect(createOpenCodeProtocolTracker).toBeTypeOf("function");
  });
});
