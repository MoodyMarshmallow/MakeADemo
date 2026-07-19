import { describe, expect, it } from "vitest";

import {
  createOpenCodeProtocolTracker,
  parseOpenCodeJsonPayload,
  readOpenCodeProtocolResult,
} from "./opencode-protocol";

describe("OpenCode protocol", () => {
  it("parses structured output emitted across text events", () => {
    expect(
      parseOpenCodeJsonPayload(
        [
          JSON.stringify({ type: "text", part: { text: '{"status":' } }),
          JSON.stringify({ type: "text", part: { text: '"succeeded"}' } }),
        ].join("\n"),
      ),
    ).toEqual({ status: "succeeded" });
  });

  it("tracks any configured tool name with its raw input and completed status", () => {
    const tracker = createOpenCodeProtocolTracker({
      trackedToolNames: ["stage_submit"],
    });
    const event = `${JSON.stringify({
      part: {
        state: {
          input: { artifact: { id: "artifact_123" } },
          status: "completed",
        },
        tool: "stage_submit",
        type: "tool-call",
      },
      type: "message.part",
    })}\n`;

    tracker.write(event.slice(0, 19));
    tracker.write(event.slice(19));

    expect(tracker.readToolCall()).toEqual({
      input: { artifact: { id: "artifact_123" } },
      name: "stage_submit",
      status: "completed",
    });
    expect(tracker.readCompletedCall()).toEqual(tracker.readToolCall());
  });

  it("does not expose untracked tool calls or their malformed inputs", () => {
    const tracker = createOpenCodeProtocolTracker({
      trackedToolNames: ["stage_submit"],
    });

    tracker.write(`${JSON.stringify({ tool: "other_stage_tool" })}\n`);

    expect(tracker.readToolCall()).toBeUndefined();
    expect(tracker.readError()).toBeUndefined();
  });

  it("returns the session and a raw tool call without product-specific payload fields", () => {
    const result = readOpenCodeProtocolResult(
      [
        JSON.stringify({ session: { id: "session_123" } }),
        JSON.stringify({
          args: { target: "release" },
          name: "deploy_preview",
          status: "running",
        }),
      ].join("\n"),
      ["deploy_preview"],
    );

    expect(result).toEqual({
      sessionID: "session_123",
      toolName: "deploy_preview",
      toolCall: {
        input: { target: "release" },
        name: "deploy_preview",
        status: "running",
      },
    });
    expect(result.toolCall).not.toHaveProperty("toolName");
    expect(result.toolCall?.input).not.toHaveProperty("command");
    expect(result.toolCall?.input).not.toHaveProperty("manifestPath");
  });

  it("reports malformed input for a tracked tool without manufacturing a call", () => {
    const result = readOpenCodeProtocolResult(
      JSON.stringify({ tool: "stage_submit" }),
      ["stage_submit"],
    );

    expect(result.toolCall).toBeUndefined();
    expect(result.error).toContain(
      "stage_submit input is missing or malformed",
    );
  });

  it("keeps only the latest tracked observation when a malformed call follows a valid one", () => {
    const tracker = createOpenCodeProtocolTracker({
      trackedToolNames: ["install", "validate"],
    });

    tracker.write(
      [
        JSON.stringify({ input: { target: "dependencies" }, tool: "install" }),
        JSON.stringify({ tool: "validate" }),
      ].join("\n"),
    );

    expect(tracker.readToolCall()).toBeUndefined();
    expect(tracker.readError()).toBe("validate input is missing or malformed");
  });

  it("uses the latest textual tool occurrence rather than configured-name order", () => {
    const tracker = createOpenCodeProtocolTracker({
      trackedToolNames: ["validate", "install"],
    });

    tracker.write("install then val");
    tracker.write("idate");

    expect(tracker.readToolName()).toBe("validate");
  });

  it("keeps a provider error separate from a stage handoff error", () => {
    const result = readOpenCodeProtocolResult(
      JSON.stringify({
        error: { message: "provider temporarily unavailable" },
        type: "error",
      }),
      ["stage_submit"],
    );

    expect(result).toEqual({
      providerError: "provider temporarily unavailable",
    });
  });
});
