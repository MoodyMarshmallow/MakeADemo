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

  it("forwards provider-neutral image content to Pi without converting it to text", async () => {
    const [tool] = createPiStageToolDefinitions([
      {
        args: {},
        description: "Inspect image proof",
        execute: async () => [
          { text: "Verified screenshot proof.", type: "text" as const },
          {
            data: "iVBORw0KGgo=",
            mimeType: "image/png" as const,
            type: "image" as const,
          },
        ],
        name: "inspect_image",
      },
    ]);
    if (tool === undefined) throw new Error("Expected a stage tool.");

    await expect(
      tool.execute("call-1", {}, undefined, undefined, {} as never),
    ).resolves.toEqual({
      content: [
        { text: "Verified screenshot proof.", type: "text" },
        {
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          type: "image",
        },
      ],
      details: undefined,
    });
  });

  it("adapts a closed recursive Pipeline input schema for structured tool submissions", () => {
    const [tool] = createPiStageToolDefinitions([
      {
        args: {},
        description: "Submit a decision",
        execute: vi.fn(async () => "submitted"),
        inputSchema: {
          oneOf: [
            {
              additionalProperties: false,
              properties: {
                citations: {
                  items: {
                    additionalProperties: false,
                    properties: {
                      endLine: { maximum: 400, minimum: 1, type: "integer" },
                      path: { maxLength: 1_000, minLength: 1, type: "string" },
                    },
                    required: ["path", "endLine"],
                    type: "object",
                  },
                  maxItems: 64,
                  type: "array",
                },
                verdict: { const: "pass", type: "literal" },
              },
              required: ["citations", "verdict"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                failureKind: {
                  type: "enum",
                  values: ["replacement-detected", "identity-not-proven"],
                },
                verdict: { const: "fail", type: "literal" },
              },
              required: ["failureKind", "verdict"],
              type: "object",
            },
          ],
          type: "oneOf",
        },
        name: "submit_decision",
      },
    ]);
    if (tool === undefined) throw new Error("Expected a stage tool.");

    expect(
      Value.Check(tool.parameters, {
        citations: [{ endLine: 12, path: "src/app.tsx" }],
        verdict: "pass",
      }),
    ).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        citations: [],
        extra: true,
        verdict: "pass",
      }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        failureKind: "replacement-detected",
        verdict: "fail",
      }),
    ).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        failureKind: "unexpected",
        verdict: "fail",
      }),
    ).toBe(false);
  });
});
