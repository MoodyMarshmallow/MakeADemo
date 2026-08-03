import { describe, expect, it } from "vitest";

import { createBenchmarkControlOutput } from "./benchmark-control-output";

describe("benchmark control output", () => {
  it("emits a sanitized provider retry event and excludes provider error text", () => {
    const lines: string[] = [];
    const output = createBenchmarkControlOutput({
      now: () => "2026-07-31T17:00:00.000Z",
      write: (line) => lines.push(line),
    });

    output.onAgentEvent({
      event: "agent-task.provider-retry",
      kind: "audit",
      metadata: {
        attempt: 1,
        maxAttempts: 5,
        providerError: "rate limit for org_123",
        reason: "rate-limit",
        requestedDelayMs: 2_000,
      },
    });

    expect(lines).toEqual([
      '{"attempt":1,"maxAttempts":5,"occurredAt":"2026-07-31T17:00:00.000Z","reason":"rate-limit","requestedDelayMs":2000,"type":"agent-task.provider-retry","v":1}\n',
    ]);
    expect(lines.join("")).not.toContain("org_123");
  });

  it("emits one strict provisioning success frame for Repo Security Screen progress", () => {
    const lines: string[] = [];
    const output = createBenchmarkControlOutput({
      now: () => "2026-08-01T00:00:00.000Z",
      write: (line) => lines.push(line),
    });

    output.onPipelineProgress({
      stage: "repo-security-screen",
      status: "started",
    });
    output.onPipelineProgress({
      stage: "repo-security-screen",
      status: "succeeded",
    });
    output.onPipelineProgress({
      stage: "repo-security-screen",
      status: "succeeded",
    });
    output.onPipelineProgress({
      stage: "repo-preparation",
      status: "succeeded",
    });

    expect(lines).toEqual([
      '{"occurredAt":"2026-08-01T00:00:00.000Z","type":"benchmark.daytona-provisioning-succeeded","v":1}\n',
    ]);
  });
});
