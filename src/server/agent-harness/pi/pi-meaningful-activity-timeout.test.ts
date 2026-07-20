import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSessionTimeoutError } from "../agent-session-timeout";
import {
  createPiActivityTracker,
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
});
