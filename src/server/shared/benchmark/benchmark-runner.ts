import type { BenchmarkResult } from "./benchmark-results";

/**
 * Runs every configured benchmark repetition concurrently while preserving
 * manifest order in the returned results.
 */
export function runBenchmarkJobs<
  Repo extends { effectiveRepetitions: number; id: string },
>(input: {
  repos: Repo[];
  run: (job: {
    repetitionIndex: number;
    repo: Repo;
  }) => Promise<BenchmarkResult>;
}): Promise<BenchmarkResult[]> {
  const jobs = input.repos.flatMap((repo) =>
    Array.from({ length: repo.effectiveRepetitions }, (_, repetitionIndex) => ({
      repetitionIndex,
      repo,
    })),
  );

  return Promise.all(jobs.map((job) => input.run(job)));
}
