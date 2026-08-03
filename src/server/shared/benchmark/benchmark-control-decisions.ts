import type {
  BenchmarkAdmission,
  BenchmarkAdmissionGate,
  BenchmarkAdmissionPauseExhaustedError,
  BenchmarkCircuitDecision,
} from "./benchmark-admission-gate";
import type { BenchmarkProviderRetryControlEvent } from "./benchmark-control-events.schema";

export type BenchmarkControlDecision = BenchmarkProviderRetryControlEvent & {
  admissionPauseMs: number;
  appliedCooldownMs: number;
  cooldownUntil: number;
  decision: "cooldown-extended" | "cooldown-unchanged";
  exhausted: boolean;
  receivedAt: string;
  repetitionIndex: number;
  repoId: string;
  requestedDelayMs: number;
};

export type BenchmarkCircuitControlDecision = {
  admissionId?: number;
  admissionPauseMs: number;
  appliedDelayMs?: number;
  circuitAttempt: number;
  decision: BenchmarkCircuitDecision["decision"];
  failureStage?: "repo-security-screen";
  generation: number;
  infrastructureFailureKind?: "sandbox-infrastructure-failed";
  occurredAt: string;
  openUntil?: number;
  repetitionIndex: number;
  repoId: string;
  type: "benchmark.daytona-circuit";
  v: 1;
};

/**
 * Records benchmark-only parent decisions without allowing artifact storage to
 * affect admission or Pipeline Job execution.
 */
export function createBenchmarkControlDecisionRecorder(input: {
  admissionGate: BenchmarkAdmissionGate;
  now?: () => string;
  warn: (error: unknown) => void;
  write: (
    decision: BenchmarkControlDecision | BenchmarkCircuitControlDecision,
  ) => Promise<void>;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  let firstWriteError: unknown;
  let pendingWrite = Promise.resolve();
  let warned = false;
  let admissionPauseExhaustionRecorded = false;

  const enqueue = (
    decision: BenchmarkControlDecision | BenchmarkCircuitControlDecision,
  ) => {
    pendingWrite = pendingWrite
      .then(() => input.write(decision))
      .catch((error) => {
        firstWriteError ??= error;
      });
  };

  return {
    record(
      event: BenchmarkProviderRetryControlEvent,
      origin: { repetitionIndex: number; repoId: string },
    ) {
      const gateDecision = input.admissionGate.record(event);
      const decision: BenchmarkControlDecision = {
        ...event,
        admissionPauseMs: gateDecision.admissionPauseMs,
        appliedCooldownMs: gateDecision.requestedDelayMs,
        cooldownUntil: gateDecision.cooldownUntil,
        decision: gateDecision.extended
          ? "cooldown-extended"
          : "cooldown-unchanged",
        exhausted: gateDecision.exhausted,
        receivedAt: now(),
        repetitionIndex: origin.repetitionIndex,
        repoId: origin.repoId,
      };
      enqueue(decision);
      return { ...gateDecision };
    },
    recordCircuitDecision(
      circuitDecision: BenchmarkCircuitDecision,
      origin: { repetitionIndex: number; repoId: string },
      admission?: BenchmarkAdmission,
    ) {
      if (circuitDecision.decision === "ignored") return;
      enqueue({
        ...(admission === undefined
          ? {}
          : { admissionId: admission.admissionId }),
        admissionPauseMs: circuitDecision.admissionPauseMs,
        ...(circuitDecision.appliedDelayMs === undefined
          ? {}
          : { appliedDelayMs: circuitDecision.appliedDelayMs }),
        circuitAttempt: circuitDecision.circuitAttempt,
        decision: circuitDecision.decision,
        ...(circuitDecision.decision === "opened" ||
        circuitDecision.decision === "reopened" ||
        circuitDecision.decision === "coalesced"
          ? {
              failureStage: "repo-security-screen" as const,
              infrastructureFailureKind:
                "sandbox-infrastructure-failed" as const,
            }
          : {}),
        generation: circuitDecision.generation,
        occurredAt: now(),
        ...(circuitDecision.openUntil === undefined
          ? {}
          : { openUntil: circuitDecision.openUntil }),
        repetitionIndex: origin.repetitionIndex,
        repoId: origin.repoId,
        type: "benchmark.daytona-circuit",
        v: 1,
      });
    },
    recordAdmissionPauseExhausted(
      error: BenchmarkAdmissionPauseExhaustedError,
      origin: { repetitionIndex: number; repoId: string },
    ) {
      if (admissionPauseExhaustionRecorded) return;
      admissionPauseExhaustionRecorded = true;
      enqueue({
        admissionPauseMs: error.admissionPauseMs,
        circuitAttempt: error.circuitAttempt,
        decision: "allowance-exhausted",
        generation: error.generation,
        occurredAt: now(),
        repetitionIndex: origin.repetitionIndex,
        repoId: origin.repoId,
        type: "benchmark.daytona-circuit",
        v: 1,
      });
    },
    recordProvisioningSucceeded(
      admission: BenchmarkAdmission | undefined,
      origin: { repetitionIndex: number; repoId: string },
    ) {
      if (admission === undefined) return;
      const circuitDecision =
        input.admissionGate.recordProvisioningSucceeded(admission);
      this.recordCircuitDecision(circuitDecision, origin, admission);
    },
    async finalize(): Promise<{ firstWriteError?: unknown }> {
      await pendingWrite;
      if (firstWriteError !== undefined && !warned) {
        warned = true;
        input.warn(firstWriteError);
      }
      return firstWriteError === undefined ? {} : { firstWriteError };
    },
  };
}
