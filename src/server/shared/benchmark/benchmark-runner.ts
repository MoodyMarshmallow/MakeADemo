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
  now?: () => number;
  repos: Repo[];
  deadlineAt?: number;
  run: (job: {
    repetitionIndex: number;
    repo: Repo;
    deadlineAt?: number;
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

  const runNextJob = async () => {
    while (firstFailure === undefined && nextJobIndex < jobs.length) {
      const jobIndex = nextJobIndex;
      nextJobIndex += 1;
      const job = jobs[jobIndex];
      if (job === undefined) continue;
      try {
        const deadlineAt =
          input.benchmarkTimeoutMs === undefined
            ? input.deadlineAt
            : Math.min(
                now() + input.benchmarkTimeoutMs,
                input.deadlineAt ?? Number.POSITIVE_INFINITY,
              );
        results[jobIndex] = await input.run(
          deadlineAt === undefined ? job : { ...job, deadlineAt },
        );
      } catch (error) {
        firstFailure ??= { error };
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
