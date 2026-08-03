import { describe, expect, it, vi } from "vitest";

import {
  BenchmarkAdmissionPauseExhaustedError,
  createBenchmarkAdmissionGate,
} from "./benchmark-admission-gate";
import { createBenchmarkControlDecisionRecorder } from "./benchmark-control-decisions";

describe("benchmark control decision recorder", () => {
  it("persists the origin-decorated parent decision without failing admission when the artifact write fails", async () => {
    const write = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    const warn = vi.fn();
    const recorder = createBenchmarkControlDecisionRecorder({
      admissionGate: createBenchmarkAdmissionGate({ now: () => 1_000 }),
      now: () => "2026-07-31T17:00:00.000Z",
      warn,
      write,
    });

    const decision = recorder.record(
      {
        attempt: 1,
        maxAttempts: 5,
        occurredAt: "2026-07-31T16:59:00.000Z",
        reason: "rate-limit",
        requestedDelayMs: 2_000,
        type: "agent-task.provider-retry",
        v: 1,
      },
      { repetitionIndex: 2, repoId: "midday" },
    );

    expect(decision.extended).toBe(true);
    await expect(recorder.finalize()).resolves.toMatchObject({
      firstWriteError: expect.any(Error),
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        repetitionIndex: 2,
        repoId: "midday",
        requestedDelayMs: 2_000,
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("preserves the requested provider delay beside the clamped cooldown decision", async () => {
    const write = vi.fn(async () => undefined);
    const recorder = createBenchmarkControlDecisionRecorder({
      admissionGate: createBenchmarkAdmissionGate({ now: () => 1_000 }),
      now: () => "2026-07-31T17:00:00.000Z",
      warn: vi.fn(),
      write,
    });

    recorder.record(
      {
        attempt: 1,
        maxAttempts: 5,
        occurredAt: "2026-07-31T16:59:00.000Z",
        reason: "rate-limit",
        requestedDelayMs: 64_000,
        type: "agent-task.provider-retry",
        v: 1,
      },
      { repetitionIndex: 0, repoId: "midday" },
    );
    await recorder.finalize();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        appliedCooldownMs: 32_000,
        requestedDelayMs: 64_000,
      }),
    );
  });

  it("records only parent-bound sanitized Daytona circuit decisions", async () => {
    const write = vi.fn(async () => undefined);
    const recorder = createBenchmarkControlDecisionRecorder({
      admissionGate: createBenchmarkAdmissionGate({ now: () => 1_000 }),
      now: () => "2026-08-01T00:00:00.000Z",
      warn: vi.fn(),
      write,
    });

    recorder.recordCircuitDecision(
      {
        admissionPauseMs: 12,
        appliedDelayMs: 15_000,
        circuitAttempt: 1,
        decision: "opened",
        generation: 1,
        openUntil: 16_000,
      },
      { repetitionIndex: 3, repoId: "outline" },
      { admissionId: 8, circuitAttempt: 1, generation: 1, kind: "ordinary" },
    );
    await recorder.finalize();

    expect(write).toHaveBeenCalledWith({
      admissionId: 8,
      admissionPauseMs: 12,
      appliedDelayMs: 15_000,
      circuitAttempt: 1,
      decision: "opened",
      failureStage: "repo-security-screen",
      generation: 1,
      infrastructureFailureKind: "sandbox-infrastructure-failed",
      occurredAt: "2026-08-01T00:00:00.000Z",
      openUntil: 16_000,
      repetitionIndex: 3,
      repoId: "outline",
      type: "benchmark.daytona-circuit",
      v: 1,
    });
  });

  it("does not append ignored ordinary circuit observations", async () => {
    const write = vi.fn(async () => undefined);
    const recorder = createBenchmarkControlDecisionRecorder({
      admissionGate: createBenchmarkAdmissionGate({ now: () => 1_000 }),
      warn: vi.fn(),
      write,
    });

    recorder.recordCircuitDecision(
      {
        admissionPauseMs: 0,
        circuitAttempt: 0,
        decision: "ignored",
        generation: 1,
      },
      { repetitionIndex: 0, repoId: "outline" },
    );
    await recorder.finalize();

    expect(write).not.toHaveBeenCalled();
  });

  it("records provisioning recovery with only its parent-bound origin", async () => {
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
    const write = vi.fn(async () => undefined);
    const recorder = createBenchmarkControlDecisionRecorder({
      admissionGate: gate,
      now: () => "2026-08-01T00:00:00.000Z",
      warn: vi.fn(),
      write,
    });

    recorder.recordProvisioningSucceeded(probe, {
      repetitionIndex: 2,
      repoId: "twenty",
    });
    await recorder.finalize();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionId: probe.admissionId,
        decision: "provisioning-succeeded",
        repetitionIndex: 2,
        repoId: "twenty",
        type: "benchmark.daytona-circuit",
      }),
    );
    expect(JSON.stringify(write.mock.calls)).not.toContain("workspace");
  });

  it("records one sanitized allowance exhaustion while preserving its typed failure", async () => {
    let now = 0;
    const gate = createBenchmarkAdmissionGate({
      maxAdmissionPauseMs: 5,
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });
    gate.record({
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-08-01T00:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 10,
      type: "agent-task.provider-retry",
      v: 1,
    });
    let failure: BenchmarkAdmissionPauseExhaustedError | undefined;
    try {
      await gate.admit();
    } catch (error) {
      if (error instanceof BenchmarkAdmissionPauseExhaustedError) {
        failure = error;
      }
    }
    expect(failure).toBeInstanceOf(BenchmarkAdmissionPauseExhaustedError);
    const write = vi.fn(async () => undefined);
    const recorder = createBenchmarkControlDecisionRecorder({
      admissionGate: gate,
      now: () => "2026-08-01T00:00:00.005Z",
      warn: vi.fn(),
      write,
    });

    recorder.recordAdmissionPauseExhausted(
      failure as BenchmarkAdmissionPauseExhaustedError,
      { repetitionIndex: 1, repoId: "cyberchef" },
    );
    recorder.recordAdmissionPauseExhausted(
      failure as BenchmarkAdmissionPauseExhaustedError,
      { repetitionIndex: 9, repoId: "ignored-second-origin" },
    );
    await recorder.finalize();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      admissionPauseMs: 5,
      circuitAttempt: 0,
      decision: "allowance-exhausted",
      generation: 0,
      occurredAt: "2026-08-01T00:00:00.005Z",
      repetitionIndex: 1,
      repoId: "cyberchef",
      type: "benchmark.daytona-circuit",
      v: 1,
    });
    expect(failure?.message).toContain("5ms was exhausted");
  });
});
