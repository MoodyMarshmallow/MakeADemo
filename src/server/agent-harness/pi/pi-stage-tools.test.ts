import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import { createPiStageToolDefinitions } from "./pi-stage-tools";

describe("Pi stage tool adapter", () => {
  it("preserves optional Pipeline tool arguments in the Pi schema", () => {
    const [tool] = createPiStageToolDefinitions([
      {
        args: {
          requiredValue: { description: "Required", type: "string" },
          optionalValues: {
            description: "Optional",
            optional: true,
            type: "string[]",
          },
        },
        description: "Stage tool",
        execute: vi.fn(async () => "done"),
        name: "stage_tool",
      },
    ]);
    if (tool === undefined) throw new Error("Expected a stage tool.");

    expect(Value.Check(tool.parameters, { requiredValue: "present" })).toBe(
      true,
    );
    expect(Value.Check(tool.parameters, {})).toBe(false);
  });
});
