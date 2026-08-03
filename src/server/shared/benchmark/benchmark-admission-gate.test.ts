import { describe, expect, it } from "vitest";

import { createBenchmarkAdmissionGate } from "./benchmark-admission-gate";

describe("benchmark admission gate", () => {
  it("opens Daytona admission after an exact Repo Security infrastructure result", () => {
    const gate = createBenchmarkAdmissionGate({ now: () => 1_000 });

    expect(
      gate.recordTerminalResult({
        disposition: "inconclusive",
        failureStage: "repo-security-screen",
        infrastructureFailureKind: "sandbox-infrastructure-failed",
        sandboxProvider: "daytona",
        status: "failed",
      }),
    ).toMatchObject({ appliedDelayMs: 15_000, decision: "opened" });
  });

  it("permits one probe and exponentially reopens only for its matching terminal failure", async () => {
    let now = 0;
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });
    const failed = {
      disposition: "inconclusive" as const,
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed" as const,
      sandboxProvider: "daytona" as const,
      status: "failed" as const,
    };

    expect(gate.recordTerminalResult(failed).appliedDelayMs).toBe(15_000);
    const firstProbe = await gate.admit();
    expect(firstProbe.kind).toBe("probe");
    expect(gate.recordTerminalResult(failed, firstProbe)).toMatchObject({
      appliedDelayMs: 30_000,
      decision: "reopened",
    });
    const secondProbe = await gate.admit();
    expect(secondProbe.kind).toBe("probe");
    expect(gate.recordTerminalResult(failed, firstProbe).decision).toBe(
      "ignored",
    );
    expect(gate.recordProvisioningSucceeded(secondProbe).decision).toBe(
      "provisioning-succeeded",
    );
    expect(gate.recordTerminalResult(failed, secondProbe).decision).toBe(
      "ignored",
    );
  });

  it("keeps concurrent waiters behind the single half-open probe", async () => {
    let now = 0;
    const blockedSleeps: Array<() => void> = [];
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        if (now < 15_000) {
          now += delayMs;
          return;
        }
        await new Promise<void>((resolve) => blockedSleeps.push(resolve));
      },
    });
    gate.recordTerminalResult({
      disposition: "inconclusive",
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed",
      sandboxProvider: "daytona",
      status: "failed",
    });

    const probe = await gate.admit();
    let secondAdmitted = false;
    const second = gate.admit().then((admission) => {
      secondAdmitted = true;
      return admission;
    });
    await Promise.resolve();
    expect(secondAdmitted).toBe(false);

    gate.recordProvisioningSucceeded(probe);
    await expect(second).resolves.toMatchObject({ kind: "ordinary" });
  });

  it("rejects a half-open follower at the suite deadline while its probe hangs", async () => {
    let now = 0;
    const cleanup = new AbortController();
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });
    gate.recordTerminalResult({
      disposition: "inconclusive",
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed",
      sandboxProvider: "daytona",
      status: "failed",
    });
    await gate.admit();

    const follower = gate.admit(cleanup.signal, 15_100);
    await Promise.resolve();
    cleanup.abort(new Error("test cleanup"));

    await expect(follower).rejects.toThrow(
      "Benchmark suite deadline was reached before admission.",
    );
  });

  it("rejects a half-open follower when its shared pause allowance expires", async () => {
    let now = 0;
    const gate = createBenchmarkAdmissionGate({
      initialOpenMs: 10,
      maxAdmissionPauseMs: 20,
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });
    gate.recordTerminalResult({
      disposition: "inconclusive",
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed",
      sandboxProvider: "daytona",
      status: "failed",
    });
    await gate.admit();

    await expect(gate.admit()).rejects.toThrow(
      "Benchmark admission-pause allowance of 20ms was exhausted.",
    );
    expect(now).toBe(20);
  });

  it("ignores an exact stale ordinary result after a successful probe recovery", async () => {
    let now = 0;
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });
    const staleOrdinary = await gate.admit();
    const failed = {
      disposition: "inconclusive" as const,
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed" as const,
      sandboxProvider: "daytona" as const,
      status: "failed" as const,
    };
    gate.recordTerminalResult(failed);
    const probe = await gate.admit();
    gate.recordProvisioningSucceeded(probe);

    expect(gate.recordTerminalResult(failed, staleOrdinary).decision).toBe(
      "ignored",
    );
    await expect(gate.admit()).resolves.toMatchObject({ kind: "ordinary" });
    expect(now).toBe(15_000);
  });

  it("closes a half-open circuit when its probe terminal result is nonmatching", async () => {
    let now = 0;
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });
    gate.recordTerminalResult({
      disposition: "inconclusive",
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed",
      sandboxProvider: "daytona",
      status: "failed",
    });
    const probe = await gate.admit();

    expect(
      gate.recordTerminalResult(
        {
          disposition: "completed",
          failureStage: "repo-preparation",
          infrastructureFailureKind: "unexpected-pipeline-error",
          sandboxProvider: "daytona",
          status: "failed",
        },
        probe,
      ).decision,
    ).toBe("closed");
    await expect(gate.admit()).resolves.toMatchObject({ kind: "ordinary" });
  });

  it("caps consecutive failed probe delays at 15, 30, 60, and 120 seconds", async () => {
    let now = 0;
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });
    const failed = {
      disposition: "inconclusive" as const,
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed" as const,
      sandboxProvider: "daytona" as const,
      status: "failed" as const,
    };
    const delays = [gate.recordTerminalResult(failed).appliedDelayMs];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const probe = await gate.admit();
      delays.push(gate.recordTerminalResult(failed, probe).appliedDelayMs);
    }

    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
  });

  it("charges overlapping provider and circuit waits once across concurrent waiters", async () => {
    let now = 0;
    const blockedSleeps: Array<() => void> = [];
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        if (now < 20_000) {
          now += delayMs;
          return;
        }
        await new Promise<void>((resolve) => blockedSleeps.push(resolve));
      },
    });
    gate.recordTerminalResult({
      disposition: "inconclusive",
      failureStage: "repo-security-screen",
      infrastructureFailureKind: "sandbox-infrastructure-failed",
      sandboxProvider: "daytona",
      status: "failed",
    });
    gate.record({
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-08-01T00:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 20_000,
      type: "agent-task.provider-retry",
      v: 1,
    });

    const probe = await gate.admit();
    const follower = gate.admit();
    await Promise.resolve();
    const success = gate.recordProvisioningSucceeded(probe);
    await follower;

    expect(success.admissionPauseMs).toBe(20_000);
    expect(now).toBe(20_000);
  });
  it("extends one shared cooldown by the largest provider retry delay", () => {
    let now = 1_000;
    const gate = createBenchmarkAdmissionGate({ now: () => now });

    const first = gate.record({
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-07-31T00:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
      type: "agent-task.provider-retry",
      v: 1,
    });
    now = 1_100;
    const second = gate.record({
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-07-31T00:00:00.100Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
      type: "agent-task.provider-retry",
      v: 1,
    });

    expect(first).toMatchObject({ cooldownUntil: 3_000, extended: true });
    expect(second).toMatchObject({ cooldownUntil: 3_100, extended: true });
  });

  it("rechecks a later cooldown extension before admitting a queued Pipeline Job", async () => {
    let now = 1_000;
    const sleepers: Array<() => void> = [];
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async () => {
        await new Promise<void>((resolve) => sleepers.push(resolve));
      },
    });
    gate.record({
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-07-31T00:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
      type: "agent-task.provider-retry",
      v: 1,
    });

    const admission = gate.waitForAdmission();
    await Promise.resolve();
    now = 1_500;
    gate.record({
      attempt: 2,
      maxAttempts: 5,
      occurredAt: "2026-07-31T00:00:00.500Z",
      reason: "rate-limit",
      requestedDelayMs: 3_000,
      type: "agent-task.provider-retry",
      v: 1,
    });
    sleepers.shift()?.();
    await Promise.resolve();
    now = 4_500;
    sleepers.shift()?.();

    await expect(admission).resolves.toBeUndefined();
  });

  it("fails queued admission when the bounded cooldown allowance is exhausted", async () => {
    let now = 1_000;
    const gate = createBenchmarkAdmissionGate({
      maxAdmissionPauseMs: 1_000,
      now: () => now,
      sleep: async () => {
        now = 3_000;
      },
    });
    gate.record({
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-07-31T00:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
      type: "agent-task.provider-retry",
      v: 1,
    });

    await expect(gate.waitForAdmission()).rejects.toThrow(
      "Benchmark admission-pause allowance of 1000ms was exhausted.",
    );
  });

  it("does not spend admission allowance during retry storms without waiters", () => {
    let now = 1_000;
    const gate = createBenchmarkAdmissionGate({
      maxAdmissionPauseMs: 1_000,
      now: () => now,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      gate.record({
        attempt,
        maxAttempts: 5,
        occurredAt: "2026-07-31T00:00:00.000Z",
        reason: "rate-limit",
        requestedDelayMs: 32_000,
        type: "agent-task.provider-retry",
        v: 1,
      });
      now += 1_000;
    }

    expect(gate.isExhausted()).toBe(false);
  });
});
