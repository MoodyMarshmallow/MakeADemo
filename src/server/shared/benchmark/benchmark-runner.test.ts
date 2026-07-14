import { describe, expect, it, vi } from "vitest";

import type { BenchmarkResult } from "./benchmark-results";
import { runBenchmarkJobs } from "./benchmark-runner";

describe("runBenchmarkJobs", () => {
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
