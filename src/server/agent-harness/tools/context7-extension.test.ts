import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { resolveContext7ExtensionPath } from "./context7-extension";
import { createContext7ToolDefinitions } from "./context7-tools";

describe("Context7 Pi extension", () => {
  it("resolves the installed official extension without discovering project config", () => {
    const extensionPath = resolveContext7ExtensionPath();
    expect(extensionPath).toMatch(
      /@upstash[\\/]context7-pi[\\/]extensions[\\/]context7\.ts$/,
    );
    expect(existsSync(extensionPath)).toBe(true);
  });

  it("keeps the official tools while bounding, timing out, and aborting calls", async () => {
    const officialExecute = vi.fn(async () => ({
      content: [{ text: "x".repeat(20_000), type: "text" }],
      details: undefined,
    }));
    const tools = createContext7ToolDefinitions({
      officialTools: [
        {
          description: "resolve",
          execute: officialExecute as never,
          label: "resolve",
          name: "resolve-library-id",
          parameters: {} as never,
        },
      ],
      maxOutputCharacters: 100,
      timeoutMs: 100,
    });
    const tool = tools[0];
    if (tool === undefined)
      throw new Error("Expected resolve-library-id tool.");
    const signal = new AbortController();
    const result = await tool.execute(
      "call",
      {},
      signal.signal,
      undefined,
      {} as never,
    );
    expect(officialExecute).toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(
      (result.content[0] as { text: string }).text.length,
    ).toBeLessThanOrEqual(100);

    signal.abort();
    await expect(
      tool.execute("aborted", {}, signal.signal, undefined, {} as never),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out an official tool call", async () => {
    const tools = createContext7ToolDefinitions({
      officialTools: [
        {
          description: "query",
          execute: vi.fn(
            async () => await new Promise(() => undefined),
          ) as never,
          label: "query",
          name: "query-docs",
          parameters: {} as never,
        },
      ],
      timeoutMs: 10,
    });
    const tool = tools[0];
    if (tool === undefined) throw new Error("Expected query-docs tool.");
    await expect(
      tool.execute("timeout", {}, undefined, undefined, {} as never),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts an in-flight official tool call immediately", async () => {
    const tools = createContext7ToolDefinitions({
      officialTools: [
        {
          description: "query",
          execute: vi.fn(
            async () => await new Promise(() => undefined),
          ) as never,
          label: "query",
          name: "query-docs",
          parameters: {} as never,
        },
      ],
      timeoutMs: 5_000,
    });
    const tool = tools[0];
    if (tool === undefined) throw new Error("Expected query-docs tool.");
    const controller = new AbortController();
    const result = tool.execute(
      "abort-in-flight",
      {},
      controller.signal,
      undefined,
      {} as never,
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
