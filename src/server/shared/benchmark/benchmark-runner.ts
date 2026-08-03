import {
  type BenchmarkAdmission,
  type BenchmarkAdmissionGate,
  BenchmarkAdmissionPauseExhaustedError,
  type BenchmarkCircuitDecision,
} from "./benchmark-admission-gate";
import type { BenchmarkResult } from "./benchmark-results";

/**
 * Runs configured benchmark repetitions with bounded concurrency while
 * preserving manifest order in the returned results.
 */
export function runBenchmarkJobs<
  Repo extends { effectiveRepetitions: number; id: string },
>(input: {
  concurrency?: number;
  /** Per-Pipeline-Job budget assigned when the job enters a worker slot. */
  benchmarkTimeoutMs?: number;
  /** Shared benchmark-only gate that delays queued job admission. */
  admissionGate?: Pick<BenchmarkAdmissionGate, "waitForAdmission"> &
    Partial<Pick<BenchmarkAdmissionGate, "admit" | "recordTerminalResult">>;
  now?: () => number;
  repos: Repo[];
  deadlineAt?: number;
  /** Stops queued jobs from being claimed while running jobs drain. */
  signal?: AbortSignal;
  /** Observes the already-applied terminal circuit decision for durable telemetry. */
  onTerminalResult?: (input: {
    admission?: BenchmarkAdmission;
    decision?: BenchmarkCircuitDecision;
    repetitionIndex: number;
    repo: Repo;
    result: BenchmarkResult;
  }) => void;
  /** Persists the one terminal shared-admission allowance decision. */
  onAdmissionPauseExhausted?: (input: {
    error: BenchmarkAdmissionPauseExhaustedError;
    repetitionIndex: number;
    repo: Repo;
  }) => void;
  run: (job: {
    repetitionIndex: number;
    repo: Repo;
    deadlineAt?: number;
    /** Opaque shared-admission identity for benchmark-only feedback. */
    admission?: BenchmarkAdmission;
  }) => Promise<BenchmarkResult>;
}): Promise<BenchmarkResult[]> {
  const jobs = input.repos.flatMap((repo) =>
    Array.from({ length: repo.effectiveRepetitions }, (_, repetitionIndex) => ({
      repetitionIndex,
      repo,
    })),
  );

  if (
    input.concurrency !== undefined &&
    (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1)
  ) {
    throw new Error("Benchmark concurrency must be a positive safe integer.");
  }
  const concurrency = input.concurrency ?? jobs.length;
  const now = input.now ?? Date.now;
  const results = new Array<BenchmarkResult>(jobs.length);
  let firstFailure: { error: unknown } | undefined;
  let nextJobIndex = 0;
  const queuedAdmissionCancellation = new AbortController();
  const queuedAdmissionSignal =
    input.signal === undefined
      ? queuedAdmissionCancellation.signal
      : AbortSignal.any([input.signal, queuedAdmissionCancellation.signal]);

  const fail = (error: unknown) => {
    if (firstFailure !== undefined) return;
    firstFailure = { error };
    queuedAdmissionCancellation.abort(error);
  };

  const runNextJob = async () => {
    while (firstFailure === undefined && nextJobIndex < jobs.length) {
      const jobIndex = nextJobIndex;
      nextJobIndex += 1;
      const job = jobs[jobIndex];
      if (job === undefined) break;
      if (input.signal?.aborted === true) {
        fail(input.signal.reason ?? new Error("Benchmark interrupted."));
        break;
      }
      try {
        let admission: BenchmarkAdmission | undefined;
        if (input.admissionGate !== undefined) {
          if (input.admissionGate.admit === undefined) {
            await input.admissionGate.waitForAdmission(
              queuedAdmissionSignal,
              input.deadlineAt,
            );
          } else {
            admission = await input.admissionGate.admit(
              queuedAdmissionSignal,
              input.deadlineAt,
            );
          }
        }
        if (firstFailure !== undefined) break;
        if (input.signal?.aborted) {
          throw input.signal.reason ?? new Error("Benchmark interrupted.");
        }
        const admittedAt = now();
        if (input.deadlineAt !== undefined && admittedAt >= input.deadlineAt) {
          throw new Error(
            "Benchmark suite deadline was reached before admission.",
          );
        }
        const deadlineAt =
          input.benchmarkTimeoutMs === undefined
            ? input.deadlineAt
            : Math.min(
                admittedAt + input.benchmarkTimeoutMs,
                input.deadlineAt ?? Number.POSITIVE_INFINITY,
              );
        const result = await input.run({
          ...job,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          ...(admission === undefined ? {} : { admission }),
        });
        results[jobIndex] = result;
        const decision = input.admissionGate?.recordTerminalResult?.(
          result,
          admission,
        );
        input.onTerminalResult?.({
          repetitionIndex: job.repetitionIndex,
          repo: job.repo,
          result,
          ...(admission === undefined ? {} : { admission }),
          ...(decision === undefined ? {} : { decision }),
        });
      } catch (error) {
        if (error instanceof BenchmarkAdmissionPauseExhaustedError) {
          input.onAdmissionPauseExhausted?.({
            error,
            repetitionIndex: job.repetitionIndex,
            repo: job.repo,
          });
        }
        fail(error);
      }
    }
  };

  return Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, runNextJob),
  ).then(() => {
    if (firstFailure !== undefined) {
      throw firstFailure.error;
    }
    return results;
  });
}
