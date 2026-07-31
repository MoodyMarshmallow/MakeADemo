import { describe, expect, it, vi } from "vitest";

import type { BenchmarkResult } from "./benchmark-results";
import { runBenchmarkJobs } from "./benchmark-runner";

describe("runBenchmarkJobs", () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid direct concurrency limit of %s before starting Pipeline Jobs",
    (concurrency) => {
      const run = vi.fn();

      expect(() =>
        runBenchmarkJobs({
          concurrency,
          repos: [{ effectiveRepetitions: 1, id: "one" }],
          run,
        }),
      ).toThrow("Benchmark concurrency must be a positive safe integer.");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("drains running Pipeline Jobs without starting queued jobs after a failure", async () => {
    const startedRepoIds: string[] = [];
    const completions = new Map<string, (error?: Error) => void>();
    const repos = ["one", "two", "three"].map((id) => ({
      effectiveRepetitions: 1,
      id,
    }));
    const running = runBenchmarkJobs({
      concurrency: 2,
      repos,
      run: ({ repo }) =>
        new Promise<BenchmarkResult>((resolve, reject) => {
          startedRepoIds.push(repo.id);
          completions.set(repo.id, (error) => {
            if (error === undefined) {
              resolve(resultFor(repo.id));
              return;
            }
            reject(error);
          });
        }),
    });
    const settled = vi.fn();
    void running.catch(settled);

    await vi.waitFor(() => {
      expect(startedRepoIds).toEqual(["one", "two"]);
    });
    completions.get("one")?.(new Error("one failed"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).not.toHaveBeenCalled();
    expect(startedRepoIds).toEqual(["one", "two"]);

    completions.get("two")?.();

    await expect(running).rejects.toThrow("one failed");
    expect(startedRepoIds).toEqual(["one", "two"]);
  });

  it("runs no more than the requested number of Pipeline Jobs simultaneously", async () => {
    const startedRepoIds: string[] = [];
    const releases = new Map<string, () => void>();
    const repos = ["one", "two", "three"].map((id) => ({
      effectiveRepetitions: 1,
      id,
    }));

    const running = runBenchmarkJobs({
      concurrency: 2,
      repos,
      run: async ({ repo }) => {
        startedRepoIds.push(repo.id);
        await new Promise<void>((resolve) => releases.set(repo.id, resolve));
        return resultFor(repo.id);
      },
    });

    await vi.waitFor(() => {
      expect(startedRepoIds).toEqual(["one", "two"]);
    });
    releases.get("one")?.();
    await vi.waitFor(() => {
      expect(startedRepoIds).toEqual(["one", "two", "three"]);
    });
    releases.get("two")?.();
    releases.get("three")?.();

    await expect(running).resolves.toEqual([
      resultFor("one"),
      resultFor("two"),
      resultFor("three"),
    ]);
  });

  it("gives each queued admitted Pipeline Job a fresh benchmark deadline", async () => {
    let now = 1_000;
    const deadlines: number[] = [];
    await runBenchmarkJobs({
      benchmarkTimeoutMs: 500,
      concurrency: 1,
      now: () => now,
      repos: [
        { effectiveRepetitions: 1, id: "one" },
        { effectiveRepetitions: 1, id: "two" },
      ],
      run: async ({ deadlineAt, repo }) => {
        deadlines.push(deadlineAt ?? -1);
        if (repo.id === "one") now = 1_400;
        return resultFor(repo.id);
      },
    });

    expect(deadlines).toEqual([1_500, 1_900]);
  });

  it("starts every repo benchmark before waiting for any one to finish", async () => {
    const startedRepoIds: string[] = [];
    const releases = new Map<string, () => void>();
    const repos = ["one", "two", "three"].map((id) => ({
      effectiveRepetitions: 1,
      id,
    }));

    const running = runBenchmarkJobs({
      repos,
      run: async ({ repo }) => {
        startedRepoIds.push(repo.id);
        await new Promise<void>((resolve) => releases.set(repo.id, resolve));
        return resultFor(repo.id);
      },
    });

    await vi.waitFor(() => {
      expect(startedRepoIds).toEqual(["one", "two", "three"]);
    });
    for (const release of releases.values()) {
      release();
    }

    await expect(running).resolves.toEqual([
      resultFor("one"),
      resultFor("two"),
      resultFor("three"),
    ]);
  });
});

function resultFor(repoId: string): BenchmarkResult {
  return {
    benchmarkRunId: "run-1",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    durationMs: 1000,
    endedAt: "2026-07-13T00:00:01.000Z",
    expectedLevel: "L5",
    exitCode: 0,
    repoId,
    repoUrl: `https://github.com/example/${repoId}`,
    startedAt: "2026-07-13T00:00:00.000Z",
    status: "succeeded",
    statusLevel: "L5",
    tokenUsage: null,
  };
}
