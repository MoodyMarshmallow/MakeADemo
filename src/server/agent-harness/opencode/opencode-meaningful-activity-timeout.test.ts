import { describe, expect, it, vi } from "vitest";

import {
  createMeaningfulActivityTracker,
  runWithMeaningfulActivityTimeout,
} from "./opencode-meaningful-activity-timeout";

describe("runWithMeaningfulActivityTimeout", () => {
  it("ignores heartbeat output but extends inactivity after meaningful text", async () => {
    const activity = createMeaningfulActivityTracker();
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const timed = runWithMeaningfulActivityTimeout(() => pending, {
      activity,
      hardDeadlineAt: Date.now() + 100,
      hardTimeoutMs: 100,
      inactivityTimeoutMs: 20,
      label: "agent",
    });
    await delay(10);
    activity.write("stdout", '{"type":"heartbeat"}\n');
    await delay(6);
    activity.write("stdout", '{"type":"text","text":"progress"}\n');
    await delay(10);
    resolve("done");
    await expect(timed).resolves.toBe("done");
  });

  it("enforces the hard deadline even when meaningful activity keeps arriving", async () => {
    vi.useFakeTimers();
    try {
      const activity = createMeaningfulActivityTracker();
      const timed = runWithMeaningfulActivityTimeout(
        () => new Promise<never>(() => undefined),
        {
          activity,
          hardDeadlineAt: Date.now() + 50,
          hardTimeoutMs: 50,
          inactivityTimeoutMs: 15,
          label: "agent",
        },
      );
      const settled = timed.then(
        () => undefined,
        (error: unknown) => error,
      );
      for (let index = 0; index < 5; index += 1) {
        await vi.advanceTimersByTimeAsync(8);
        activity.write("stdout", '{"type":"text","text":"progress"}\n');
      }
      await vi.advanceTimersByTimeAsync(10);
      await expect(settled).resolves.toMatchObject({
        timeoutKind: "hard-cap",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
