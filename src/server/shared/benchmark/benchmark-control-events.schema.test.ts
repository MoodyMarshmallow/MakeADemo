import { describe, expect, it } from "vitest";

import {
  parseBenchmarkControlEventLine,
  serializeBenchmarkProviderRetryControlEvent,
} from "./benchmark-control-events.schema";

describe("benchmark control event codec", () => {
  it("round-trips only the versioned sanitized provider retry envelope", () => {
    const line = serializeBenchmarkProviderRetryControlEvent({
      attempt: 2,
      maxAttempts: 5,
      occurredAt: "2026-07-31T17:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
    });

    expect(parseBenchmarkControlEventLine(line)).toEqual({
      attempt: 2,
      maxAttempts: 5,
      occurredAt: "2026-07-31T17:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
      type: "agent-task.provider-retry",
      v: 1,
    });
    expect(line).not.toContain("providerError");
  });

  it("rejects a raw provider message or an invalid retry reason", () => {
    expect(
      parseBenchmarkControlEventLine(
        JSON.stringify({
          attempt: 1,
          maxAttempts: 5,
          message: "rate limit for org_123",
          occurredAt: "2026-07-31T17:00:00.000Z",
          reason: "rate-limit",
          requestedDelayMs: 2_000,
          type: "agent-task.provider-retry",
          v: 1,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseBenchmarkControlEventLine(
        JSON.stringify({
          attempt: 1,
          maxAttempts: 5,
          occurredAt: "2026-07-31T17:00:00.000Z",
          reason: "provider said retry later",
          requestedDelayMs: 2_000,
          type: "agent-task.provider-retry",
          v: 1,
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts only the strict Daytona provisioning success frame", () => {
    expect(
      parseBenchmarkControlEventLine(
        JSON.stringify({
          occurredAt: "2026-08-01T00:00:00.000Z",
          type: "benchmark.daytona-provisioning-succeeded",
          v: 1,
        }),
      ),
    ).toEqual({
      occurredAt: "2026-08-01T00:00:00.000Z",
      type: "benchmark.daytona-provisioning-succeeded",
      v: 1,
    });
    expect(
      parseBenchmarkControlEventLine(
        JSON.stringify({
          occurredAt: "2026-08-01T00:00:00.000Z",
          origin: "/workspace/private",
          type: "benchmark.daytona-provisioning-succeeded",
          v: 1,
        }),
      ),
    ).toBeUndefined();
  });
});
