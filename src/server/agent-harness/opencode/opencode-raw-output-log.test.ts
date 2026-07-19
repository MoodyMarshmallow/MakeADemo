import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOpenCodeRawOutputLog } from "./opencode-raw-output-log";

describe("createOpenCodeRawOutputLog", () => {
  it("creates an initialized artifact even when OpenCode emits no chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-opencode-log-"));
    const logPath = join(directory, "opencode-raw-output.jsonl");
    const logger = createOpenCodeRawOutputLog({ logPath });

    try {
      await logger.close();

      const entries = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries).toEqual([
        expect.objectContaining({
          component: "opencode-raw-output",
          message: "OpenCode output.",
          raw: expect.stringContaining("raw log initialized"),
          source: "makeademo",
        }),
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("writes timestamped raw OpenCode lines and preserves parsed tool events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-opencode-log-"));
    const logPath = join(directory, "opencode-raw-output.jsonl");
    const logger = createOpenCodeRawOutputLog({ logPath });

    try {
      logger.write(
        "stdout",
        `${JSON.stringify({
          part: {
            state: {
              output: "package.json contents",
              status: "completed",
              title: "package.json",
            },
            tool: "read",
          },
          type: "tool_use",
        })}\npartial`,
      );
      logger.write("stderr", " warning\n");
      logger.write("stdout", " line\n");
      await logger.close();

      const entries = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(entries).toEqual([
        expect.objectContaining({
          raw: expect.stringContaining("raw log initialized"),
          source: "makeademo",
        }),
        expect.objectContaining({
          channel: "stdout",
          component: "opencode-raw-output",
          eventType: "tool_use",
          message: "OpenCode stdout.",
          raw: expect.stringContaining('"tool":"read"'),
          tool: "read",
          toolState: "completed",
          toolTitle: "package.json",
        }),
        expect.objectContaining({
          channel: "stderr",
          raw: " warning",
        }),
        expect.objectContaining({
          channel: "stdout",
          raw: "partial line",
        }),
      ]);
      expect(entries[1]?.parsed.part.state.output).toBe(
        "package.json contents",
      );
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: "info", service: "makeademo" }),
        ]),
      );
      expect(entries.every((entry) => typeof entry.time === "string")).toBe(
        true,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not let an unavailable log path fail an OpenCode session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-opencode-log-"));
    const blockingFile = join(directory, "not-a-directory");
    await writeFile(blockingFile, "blocks log directory creation");
    const logger = createOpenCodeRawOutputLog({
      logPath: join(blockingFile, "opencode-raw-output.jsonl"),
    });

    try {
      logger.write("stdout", "transport output\\n");

      await expect(logger.close()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
