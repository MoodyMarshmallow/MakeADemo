import { describe, expect, it, vi } from "vitest";

import { prepareBenchmarkProcessStart } from "./benchmark-pre-spawn";

describe("prepareBenchmarkProcessStart", () => {
  it("does not admit a child spawn after cancellation during deferred setup", async () => {
    const controller = new AbortController();
    let releaseSetup!: () => void;
    const spawn = vi.fn();
    const preparation = prepareBenchmarkProcessStart({
      start: spawn,
      setup: async () => {
        await new Promise<void>((resolve) => {
          releaseSetup = resolve;
        });
      },
      signal: controller.signal,
    });

    controller.abort(new Error("benchmark interrupted"));
    releaseSetup();

    await expect(preparation).rejects.toThrow("benchmark interrupted");
    expect(spawn).not.toHaveBeenCalled();
  });
});
