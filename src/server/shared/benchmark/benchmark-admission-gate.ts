import type { BenchmarkProviderRetryControlEvent } from "./benchmark-control-events.schema";
import type { BenchmarkResult } from "./benchmark-results";

/** An opaque admission identity; only its originating controller may resolve it. */
export type BenchmarkAdmission = {
  admissionId: number;
  circuitAttempt: number;
  generation: number;
  kind: "ordinary" | "probe";
};

export type BenchmarkCircuitDecision = {
  admissionPauseMs: number;
  appliedDelayMs?: number;
  circuitAttempt: number;
  decision:
    | "closed"
    | "coalesced"
    | "half-open-probe-admitted"
    | "ignored"
    | "allowance-exhausted"
    | "opened"
    | "provisioning-succeeded"
    | "reopened";
  generation: number;
  openUntil?: number;
};

/**
 * Admits queued benchmark Pipeline Jobs through one shared provider cooldown
 * and Daytona provisioning circuit. Running Pipeline Jobs are never touched.
 */
export type BenchmarkAdmissionGate = {
  isExhausted(): boolean;
  record(event: BenchmarkProviderRetryControlEvent): {
    admissionPauseMs: number;
    cooldownUntil: number;
    exhausted: boolean;
    extended: boolean;
    requestedDelayMs: number;
  };
  /** Resolves one terminal benchmark result against the originating admission. */
  recordTerminalResult(
    result: Pick<
      BenchmarkResult,
      | "disposition"
      | "failureStage"
      | "infrastructureFailureKind"
      | "sandboxProvider"
      | "status"
    >,
    admission?: BenchmarkAdmission,
  ): BenchmarkCircuitDecision;
  /** Closes only the matching half-open probe after authoritative progress. */
  recordProvisioningSucceeded(
    admission: BenchmarkAdmission,
  ): BenchmarkCircuitDecision;
  /** Records the one half-open probe admission without changing circuit state. */
  recordProbeAdmission(admission: BenchmarkAdmission): BenchmarkCircuitDecision;
  /** Waits for admission; retained for provider-cooldown callers. */
  waitForAdmission(signal?: AbortSignal, deadlineAt?: number): Promise<void>;
  /** Waits, then returns the opaque identity for the admitted Pipeline Job. */
  admit(signal?: AbortSignal, deadlineAt?: number): Promise<BenchmarkAdmission>;
};

/**
 * Coordinates benchmark-only admission pauses. The pause allowance is charged
 * once for elapsed wall time while at least one queued job is actually blocked.
 */
export function createBenchmarkAdmissionGate(input: {
  initialOpenMs?: number;
  maxAdmissionPauseMs?: number;
  maxOpenMs?: number;
  multiplier?: number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}): BenchmarkAdmissionGate {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? sleepUntilCooldownChanges;
  const initialOpenMs = input.initialOpenMs ?? 15_000;
  const multiplier = input.multiplier ?? 2;
  const maxOpenMs = input.maxOpenMs ?? 120_000;
  const maxAdmissionPauseMs = input.maxAdmissionPauseMs ?? 300_000;
  let cooldownUntil = 0;
  let admissionPauseMs = 0;
  let blockedSince: number | undefined;
  let exhausted = false;
  let waitingAdmissions = 0;
  let nextAdmissionId = 0;
  let generation = 0;
  let circuitAttempt = 0;
  let circuit: "closed" | "open" | "half-open" = "closed";
  let openUntil = 0;
  const stateWaiters = new Set<() => void>();
  const notifyStateChange = () => {
    for (const wake of stateWaiters) wake();
    stateWaiters.clear();
  };

  const accrueBlockedTime = (at: number): void => {
    if (blockedSince === undefined) return;
    admissionPauseMs += Math.max(0, at - blockedSince);
    blockedSince = at;
    exhausted ||= admissionPauseMs >= maxAdmissionPauseMs;
  };
  const decision = (
    kind: BenchmarkCircuitDecision["decision"],
    delay?: number,
  ): BenchmarkCircuitDecision => ({
    admissionPauseMs,
    ...(delay === undefined ? {} : { appliedDelayMs: delay }),
    circuitAttempt,
    decision: kind,
    generation,
    ...(circuit === "closed" ? {} : { openUntil }),
  });
  const close = (kind: "closed" | "provisioning-succeeded") => {
    circuit = "closed";
    circuitAttempt = 0;
    openUntil = 0;
    return decision(kind);
  };
  const exhaustedError = () =>
    new BenchmarkAdmissionPauseExhaustedError({
      admissionPauseMs,
      circuitAttempt,
      generation,
      maxAdmissionPauseMs,
    });
  const open = (kind: "opened" | "reopened") => {
    circuitAttempt += 1;
    generation += 1;
    const delay = Math.min(
      maxOpenMs,
      initialOpenMs * multiplier ** (circuitAttempt - 1),
    );
    circuit = "open";
    openUntil = now() + delay;
    return decision(kind, delay);
  };

  return {
    isExhausted: () => exhausted,
    record(event) {
      const receiptNow = now();
      accrueBlockedTime(receiptNow);
      const requestedDelayMs = Math.min(
        32_000,
        Math.max(0, event.requestedDelayMs),
      );
      const nextCooldownUntil = Math.max(
        cooldownUntil,
        receiptNow + requestedDelayMs,
      );
      const extended = nextCooldownUntil > cooldownUntil;
      cooldownUntil = nextCooldownUntil;
      notifyStateChange();
      return {
        admissionPauseMs,
        cooldownUntil,
        exhausted,
        extended,
        requestedDelayMs,
      };
    },
    recordTerminalResult(result, admission) {
      accrueBlockedTime(now());
      const exact = isDaytonaProvisioningFailure(result);
      if (admission?.kind === "probe") {
        if (admission.generation !== generation || circuit !== "half-open")
          return decision("ignored");
        const resolved = exact ? open("reopened") : close("closed");
        notifyStateChange();
        return resolved;
      }
      if (!exact) return decision("ignored");
      if (
        circuit === "closed" &&
        admission !== undefined &&
        admission.generation !== generation
      )
        return decision("ignored");
      const resolved =
        circuit === "closed" ? open("opened") : decision("coalesced");
      notifyStateChange();
      return resolved;
    },
    recordProvisioningSucceeded(admission) {
      accrueBlockedTime(now());
      if (
        admission.kind !== "probe" ||
        admission.generation !== generation ||
        circuit !== "half-open"
      )
        return decision("ignored");
      const resolved = close("provisioning-succeeded");
      notifyStateChange();
      return resolved;
    },
    recordProbeAdmission(admission) {
      if (
        admission.kind !== "probe" ||
        admission.generation !== generation ||
        circuit !== "half-open"
      )
        return decision("ignored");
      return decision("half-open-probe-admitted");
    },
    async admit(signal, deadlineAt) {
      let countedAsBlocked = false;
      try {
        for (;;) {
          const currentNow = now();
          throwIfAdmissionDeadlineReached(deadlineAt, currentNow);
          throwIfAborted(signal);
          const circuitBlocked = circuit === "open" && currentNow < openUntil;
          const providerBlocked = currentNow < cooldownUntil;
          if (
            circuit === "open" &&
            currentNow >= openUntil &&
            !providerBlocked
          ) {
            circuit = "half-open";
            return {
              admissionId: ++nextAdmissionId,
              circuitAttempt,
              generation,
              kind: "probe",
            };
          }
          if (!circuitBlocked && !providerBlocked && circuit !== "half-open") {
            accrueBlockedTime(currentNow);
            if (exhausted) throw exhaustedError();
            return {
              admissionId: ++nextAdmissionId,
              circuitAttempt,
              generation,
              kind: "ordinary",
            };
          }
          if (circuit === "half-open") {
            if (!countedAsBlocked) {
              waitingAdmissions += 1;
              countedAsBlocked = true;
              blockedSince ??= currentNow;
            }
            accrueBlockedTime(currentNow);
            if (exhausted) throw exhaustedError();
            await waitForAdmissionStateChange(
              stateWaiters,
              sleep,
              maximumAdmissionWaitMs({
                admissionPauseMs,
                deadlineAt,
                maxAdmissionPauseMs,
                now: currentNow,
              }),
              signal,
            );
            continue;
          }
          if (!countedAsBlocked) {
            waitingAdmissions += 1;
            countedAsBlocked = true;
            blockedSince ??= currentNow;
          }
          accrueBlockedTime(currentNow);
          if (exhausted) throw exhaustedError();
          const remainingAllowanceMs = Math.max(
            0,
            maxAdmissionPauseMs - admissionPauseMs,
          );
          const until =
            circuit === "open"
              ? Math.max(cooldownUntil, openUntil)
              : cooldownUntil;
          await sleep(
            Math.min(
              Math.max(1, until - now()),
              remainingAllowanceMs,
              remainingDeadlineMs(deadlineAt, now()),
            ),
            signal,
          );
        }
      } finally {
        if (countedAsBlocked) {
          waitingAdmissions -= 1;
          if (waitingAdmissions === 0) {
            accrueBlockedTime(now());
            blockedSince = undefined;
          }
        }
      }
    },
    async waitForAdmission(signal, deadlineAt) {
      await this.admit(signal, deadlineAt);
    },
  };
}

function waitForAdmissionStateChange(
  waiters: Set<() => void>,
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const timerController = new AbortController();
  const timerSignal =
    signal === undefined
      ? timerController.signal
      : AbortSignal.any([signal, timerController.signal]);
  let wake: (() => void) | undefined;
  const changed = new Promise<"changed">((resolve) => {
    wake = () => resolve("changed");
    waiters.add(wake);
  });
  return Promise.race([
    changed,
    sleep(delayMs, timerSignal).then(() => "elapsed" as const),
  ])
    .then(
      () => undefined,
      (error) => {
        throw error;
      },
    )
    .finally(() => {
      if (wake !== undefined) waiters.delete(wake);
      timerController.abort();
    });
}

function maximumAdmissionWaitMs(input: {
  admissionPauseMs: number;
  deadlineAt: number | undefined;
  maxAdmissionPauseMs: number;
  now: number;
}): number {
  return Math.min(
    input.maxAdmissionPauseMs - input.admissionPauseMs,
    remainingDeadlineMs(input.deadlineAt, input.now),
  );
}

function remainingDeadlineMs(
  deadlineAt: number | undefined,
  now: number,
): number {
  return deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, deadlineAt - now);
}

function throwIfAdmissionDeadlineReached(
  deadlineAt: number | undefined,
  now: number,
): void {
  if (deadlineAt !== undefined && now >= deadlineAt) {
    throw new Error("Benchmark suite deadline was reached before admission.");
  }
}

function isDaytonaProvisioningFailure(
  result: Pick<
    BenchmarkResult,
    | "disposition"
    | "failureStage"
    | "infrastructureFailureKind"
    | "sandboxProvider"
    | "status"
  >,
): boolean {
  return (
    result.sandboxProvider === "daytona" &&
    result.status === "failed" &&
    result.disposition === "inconclusive" &&
    result.failureStage === "repo-security-screen" &&
    result.infrastructureFailureKind === "sandbox-infrastructure-failed"
  );
}

/** Typed terminal admission failure used by the benchmark parent recorder. */
export class BenchmarkAdmissionPauseExhaustedError extends Error {
  readonly admissionPauseMs: number;
  readonly circuitAttempt: number;
  readonly generation: number;

  constructor(input: {
    admissionPauseMs: number;
    circuitAttempt: number;
    generation: number;
    maxAdmissionPauseMs: number;
  }) {
    super(
      `Benchmark admission-pause allowance of ${input.maxAdmissionPauseMs}ms was exhausted.`,
    );
    this.name = "BenchmarkAdmissionPauseExhaustedError";
    this.admissionPauseMs = input.admissionPauseMs;
    this.circuitAttempt = input.circuitAttempt;
    this.generation = input.generation;
  }
}

function sleepUntilCooldownChanges(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Benchmark admission was cancelled."));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted === true) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw signal.reason ?? new Error("Benchmark admission was cancelled.");
}
