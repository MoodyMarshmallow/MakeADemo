import { describe, expect, it } from "vitest";

import { createOpenCodeOutputStream } from "./opencode-output-stream";

describe("createOpenCodeOutputStream", () => {
  it("prints text events and ignores PTY echo noise", () => {
    const output: string[] = [];
    const stream = createOpenCodeOutputStream({
      write: (text) => output.push(text),
    });

    stream.write("opencode run --format json huge prompt\n");
    stream.write(
      `${JSON.stringify({ part: { text: "Preparing repo" }, type: "text" })}\n`,
    );

    expect(output).toEqual(["Preparing repo\n"]);
  });

  it("buffers partial JSON lines across chunks", () => {
    const output: string[] = [];
    const stream = createOpenCodeOutputStream({
      write: (text) => output.push(text),
    });
    const line = JSON.stringify({ text: "Still working", type: "text" });

    stream.write(line.slice(0, 12));
    stream.write(`${line.slice(12)}\n`);

    expect(output).toEqual(["Still working\n"]);
  });

  it("prints OpenCode errors readably", () => {
    const output: string[] = [];
    const stream = createOpenCodeOutputStream({
      write: (text) => output.push(text),
    });

    stream.write(
      `${JSON.stringify({
        error: { data: { message: "Unexpected server error" } },
        type: "error",
      })}\n`,
    );

    expect(output).toEqual(["[opencode:error] Unexpected server error\n"]);
  });

  it("prints tool events as concise progress lines", () => {
    const output: string[] = [];
    const stream = createOpenCodeOutputStream({
      write: (text) => output.push(text),
    });

    stream.write(
      `${JSON.stringify({
        part: {
          state: {
            metadata: { matches: 19 },
            status: "completed",
            title: "security grep",
          },
          tool: "grep",
        },
        type: "tool_use",
      })}\n`,
    );

    expect(output).toEqual([
      "[opencode:tool] grep - completed - security grep - 19 matches\n",
    ]);
  });

  it("prints dependency install result JSON as a concise summary", () => {
    const output: string[] = [];
    const stream = createOpenCodeOutputStream({
      write: (text) => output.push(text),
    });

    stream.write(
      `${JSON.stringify({
        command: "npm ci",
        status: "needs-dependency-install",
      })}\n`,
    );

    expect(output).toEqual([
      "[opencode] dependency install requested: npm ci\n",
    ]);
  });

  it("formats dependency install JSON wrapped in PTY control characters", () => {
    const output: string[] = [];
    const stream = createOpenCodeOutputStream({
      write: (text) => output.push(text),
    });

    stream.write(
      `\u001b[0m{\"status\":\"needs-dependency-install\",\"command\":\"npm ci\"}\r\n`,
    );

    expect(output).toEqual([
      "[opencode] dependency install requested: npm ci\n",
    ]);
  });
});
