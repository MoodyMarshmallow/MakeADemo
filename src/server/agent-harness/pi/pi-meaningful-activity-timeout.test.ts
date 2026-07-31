import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSessionTimeoutError } from "../agent-session-timeout";
import {
  createPiActivityTracker,
  createPiRetryBackoff,
  runWithPiActivityTimeout,
} from "./pi-meaningful-activity-timeout";

describe("Pi meaningful activity timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("reports timeout without waiting for best-effort cancellation", async () => {
    vi.useFakeTimers();
    const result = runWithPiActivityTimeout({
      activity: createPiActivityTracker(),
      hardDeadlineAt: Date.now() + 10_000,
      hardTimeoutMs: 10_000,
      inactivityTimeoutMs: 100,
      label: "Pi test",
      onTimeout: () => new Promise<void>(() => undefined),
      run: () => new Promise<void>(() => undefined),
    });

    const assertion = expect(result).rejects.toBeInstanceOf(
      AgentSessionTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("extends the harness hard timer and excludes a known retry sleep from inactivity", async () => {
    vi.useFakeTimers();
    const activity = createPiActivityTracker();
    const backoff = createPiRetryBackoff(
      activity,
      Date.now() + 100,
      Date.now() + 105,
    );
    const result = runWithPiActivityTimeout({
      activity,
      backoff,
      hardDeadlineAt: Date.now() + 100,
      hardTimeoutMs: 100,
      inactivityTimeoutMs: 10,
      label: "Pi test",
      onTimeout: () => undefined,
      run: () => new Promise<void>(() => undefined),
    });

    backoff.start({ hardExtensionMs: 5, sleepDelayMs: 20 });
    expect(backoff.cumulativeDelayMs()).toBe(5);
    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toMatchObject({
      timeoutKind: "inactivity",
    });
  });

  it("accumulates all five exponential retry extensions on the harness hard timer", async () => {
    vi.useFakeTimers();
    const activity = createPiActivityTracker();
    const backoff = createPiRetryBackoff(activity, Date.now() + 100);
    const result = runWithPiActivityTimeout({
      activity,
      backoff,
      hardDeadlineAt: Date.now() + 100,
      hardTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      label: "Pi test",
      onTimeout: () => undefined,
      run: () => new Promise<void>(() => undefined),
    });

    backoff.start({ hardExtensionMs: 2, sleepDelayMs: 2 });
    backoff.start({ hardExtensionMs: 4, sleepDelayMs: 4 });
    backoff.start({ hardExtensionMs: 8, sleepDelayMs: 8 });
    backoff.start({ hardExtensionMs: 16, sleepDelayMs: 16 });
    backoff.start({ hardExtensionMs: 32, sleepDelayMs: 32 });
    expect(backoff.cumulativeDelayMs()).toBe(62);
    await vi.advanceTimersByTimeAsync(161);
    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toMatchObject({ timeoutKind: "hard-cap" });
  });

  it("disposes polling and retry timers immediately on external cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const activity = createPiActivityTracker();
    const backoff = createPiRetryBackoff(activity, Date.now() + 10_000);
    const result = runWithPiActivityTimeout({
      activity,
      backoff,
      hardDeadlineAt: Date.now() + 10_000,
      hardTimeoutMs: 10_000,
      inactivityTimeoutMs: 10_000,
      label: "Pi test",
      onTimeout: () => undefined,
      run: () => new Promise<void>(() => undefined),
      signal: controller.signal,
    });
    backoff.start({ hardExtensionMs: 2_000, sleepDelayMs: 2_000 });

    controller.abort(new Error("pipeline cancelled"));

    await expect(result).rejects.toThrow("pipeline cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start work or timers for a pre-aborted signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const run = vi.fn(() => new Promise<void>(() => undefined));

    const result = runWithPiActivityTimeout({
      activity: createPiActivityTracker(),
      hardDeadlineAt: Date.now() + 10_000,
      hardTimeoutMs: 10_000,
      inactivityTimeoutMs: 10_000,
      label: "Pi test",
      onTimeout: () => undefined,
      run,
      signal: controller.signal,
    });

    await expect(result).rejects.toThrow("already cancelled");
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
