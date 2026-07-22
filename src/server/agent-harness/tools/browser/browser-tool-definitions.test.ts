import { describe, expect, it } from "vitest";

import type { BrowserToolController } from "./browser-tool-controller.interface";
import { createBrowserStageTools } from "./browser-tool-definitions";

describe("browser Stage Agent Tools", () => {
  it("exposes only the constrained browser capabilities and validates their public arguments", async () => {
    const calls: unknown[] = [];
    const controller: BrowserToolController = {
      async act(input) {
        calls.push(input);
        return { output: "acted" };
      },
      async inspect() {
        return { kind: "snapshot", output: "snapshot" };
      },
      async navigate(input) {
        calls.push(input);
        return { output: "navigated", url: "http://127.0.0.1:3000/demo" };
      },
      async reset() {},
      async screenshot() {
        return {
          path: "/workspace/.makeademo/browser-tools/latest.png",
          sizeBytes: 9,
        };
      },
      updateContext() {},
    };

    const tools = createBrowserStageTools(controller);

    expect(tools.map(({ name }) => name)).toEqual([
      "makeademo_browser_navigate",
      "makeademo_browser_inspect",
      "makeademo_browser_act",
      "makeademo_browser_screenshot",
      "makeademo_browser_reset",
    ]);
    const act = tools.find(({ name }) => name === "makeademo_browser_act");
    const navigate = tools.find(
      ({ name }) => name === "makeademo_browser_navigate",
    );
    if (act === undefined || navigate === undefined) {
      throw new Error("Browser tools are missing.");
    }

    await expect(
      act.execute({ kind: "fill", ref: "e4", text: "demo" }),
    ).resolves.toContain("acted");
    expect(calls).toEqual([{ kind: "fill", ref: "e4", text: "demo" }]);
    await expect(
      navigate.execute({ path: "https://untrusted.example.test" }),
    ).rejects.toThrow("relative");
    expect(act.args).toEqual({
      key: expect.objectContaining({ optional: true, type: "string" }),
      kind: expect.objectContaining({ type: "enum" }),
      ref: expect.objectContaining({ optional: true, type: "string" }),
      text: expect.objectContaining({ optional: true, type: "string" }),
      value: expect.objectContaining({ optional: true, type: "string" }),
    });
  });

  it("rejects oversized and incompatible model browser arguments before controller execution", async () => {
    const controller = {
      async act() {
        throw new Error("Controller must not run.");
      },
      async inspect() {
        throw new Error("Controller must not run.");
      },
      async navigate() {
        throw new Error("Controller must not run.");
      },
      async reset() {},
      async screenshot() {
        throw new Error("Controller must not run.");
      },
      updateContext() {},
    } satisfies BrowserToolController;
    const tools = createBrowserStageTools(controller);
    const act = tools.find(({ name }) => name === "makeademo_browser_act");
    const navigate = tools.find(
      ({ name }) => name === "makeademo_browser_navigate",
    );
    const screenshot = tools.find(
      ({ name }) => name === "makeademo_browser_screenshot",
    );
    if (
      act === undefined ||
      navigate === undefined ||
      screenshot === undefined
    ) {
      throw new Error("Browser tools are missing.");
    }

    await expect(
      act.execute({ kind: "click", ref: "e4", text: "unexpected" }),
    ).rejects.toThrow("does not accept text");
    await expect(
      act.execute({ kind: "type", text: "x".repeat(4_097) }),
    ).rejects.toThrow("at most 4096");
    await expect(
      navigate.execute({ path: `/${"x".repeat(2_048)}` }),
    ).rejects.toThrow("at most 2048");
    await expect(
      screenshot.execute({ fullPage: "true", target: "e4" }),
    ).rejects.toThrow("cannot combine target and fullPage");
  });
});
