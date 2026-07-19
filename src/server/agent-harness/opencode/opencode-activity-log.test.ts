import { describe, expect, it } from "vitest";

import { writeOpenCodeActivityLog } from "./opencode-activity-log";

describe("writeOpenCodeActivityLog", () => {
  it("mirrors tool activity without recursive tool input or output", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const workspace = createWorkspace(entries);
    const raw = JSON.stringify({
      part: {
        state: {
          input: { filePath: "/workspace/.makeademo/sandbox-log.jsonl" },
          output: "nested prior sandbox log contents",
          status: "completed",
          title: ".makeademo/sandbox-log.jsonl",
        },
        tool: "read",
        type: "tool",
      },
      sessionID: "session_123",
      timestamp: 1_234,
      type: "tool_use",
    });

    await writeOpenCodeActivityLog(workspace, {
      attempt: 1,
      channel: "stdout",
      raw,
      stage: "capture-path-repair",
    });

    expect(entries).toEqual([
      {
        attempt: 1,
        channel: "stdout",
        event: "opencode.tool_use",
        eventType: "tool_use",
        sessionID: "session_123",
        source: "opencode",
        stage: "capture-path-repair",
        tool: "read",
        toolState: "completed",
        toolTitle: ".makeademo/sandbox-log.jsonl",
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("nested prior sandbox log");
  });

  it("does not mirror unstructured stdout transport fragments", async () => {
    const entries: Array<Record<string, unknown>> = [];

    await writeOpenCodeActivityLog(createWorkspace(entries), {
      attempt: 1,
      channel: "stdout",
      raw: "partial nested sandbox log transport data",
      stage: "capture-path-repair",
    });

    expect(entries).toEqual([]);
  });

  it("keeps structured agent text as a bounded message", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const raw = JSON.stringify({
      part: { text: "Agent progress update", type: "text" },
      sessionID: "session_123",
      type: "text",
    });

    await writeOpenCodeActivityLog(createWorkspace(entries), {
      attempt: 1,
      channel: "stdout",
      raw,
      stage: "repo-preparation",
    });

    expect(entries).toEqual([
      expect.objectContaining({
        event: "opencode.text",
        message: "Agent progress update",
      }),
    ]);
  });
});

function createWorkspace(entries: Array<Record<string, unknown>>): {
  writeSandboxLog: (entry: Record<string, unknown>) => Promise<void>;
} {
  return {
    async writeSandboxLog(entry) {
      entries.push(entry);
    },
  };
}
