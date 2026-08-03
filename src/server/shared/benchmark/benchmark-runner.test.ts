import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createBenchmarkAdmissionGate } from "./benchmark-admission-gate";
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

  it("wakes queued admission waits with the original worker failure", async () => {
    let admissionCalls = 0;
    let queuedSignal: AbortSignal | undefined;
    let releaseFirstFailure!: () => void;
    const secondAdmissionStarted = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });
    const started: string[] = [];
    const original = new Error("first worker failed");
    const running = runBenchmarkJobs({
      admissionGate: {
        waitForAdmission: async (signal) => {
          admissionCalls += 1;
          if (admissionCalls === 1) return;
          queuedSignal = signal;
          releaseFirstFailure();
          await new Promise<void>((_resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("queued admission did not wake")),
              100,
            );
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      concurrency: 2,
      repos: [
        { effectiveRepetitions: 1, id: "one" },
        { effectiveRepetitions: 1, id: "two" },
        { effectiveRepetitions: 1, id: "three" },
      ],
      run: async ({ repo }) => {
        started.push(repo.id);
        await secondAdmissionStarted;
        throw original;
      },
    });

    await expect(running).rejects.toBe(original);
    expect(queuedSignal?.aborted).toBe(true);
    expect(started).toEqual(["one"]);
  });

  it("reports one typed admission exhaustion and rejects with that same failure", async () => {
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
    const observed: Error[] = [];
    const run = vi.fn(async () => resultFor("one"));

    let rejected: unknown;
    try {
      await runBenchmarkJobs({
        admissionGate: gate,
        now: () => now,
        onAdmissionPauseExhausted: ({ error }) => observed.push(error),
        repos: [{ effectiveRepetitions: 1, id: "one" }],
        run,
      });
    } catch (error) {
      rejected = error;
    }

    expect(observed).toHaveLength(1);
    expect(rejected).toBe(observed[0]);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs every reserved Daytona circuit job without leaving a surplus tail waiter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const gate = createBenchmarkAdmissionGate({
        initialOpenMs: 15,
        maxOpenMs: 120,
      });
      const exhausted = vi.fn();
      const started: string[] = [];
      const repos = ["one", "two", "three", "four", "five", "six"].map(
        (id) => ({ effectiveRepetitions: 1, id }),
      );

      const running = runBenchmarkJobs({
        admissionGate: gate,
        concurrency: 3,
        onAdmissionPauseExhausted: exhausted,
        repos,
        run: async ({ repo }) => {
          started.push(repo.id);
          return exactDaytonaInfrastructureFailureFor(repo.id);
        },
      });
      await vi.runAllTimersAsync();

      await expect(running).resolves.toEqual(
        repos.map((repo) => exactDaytonaInfrastructureFailureFor(repo.id)),
      );
      expect(started).toHaveLength(6);
      expect(exhausted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it("creates no admission waiter beyond the number of remaining jobs", async () => {
    const waitForAdmission = vi.fn(async () => undefined);
    const repos = [
      { effectiveRepetitions: 1, id: "one" },
      { effectiveRepetitions: 1, id: "two" },
    ];

    await expect(
      runBenchmarkJobs({
        admissionGate: { waitForAdmission },
        concurrency: 10,
        repos,
        run: async ({ repo }) => resultFor(repo.id),
      }),
    ).resolves.toEqual([resultFor("one"), resultFor("two")]);
    expect(waitForAdmission).toHaveBeenCalledTimes(2);
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

  it("waits for shared cooldown admission before assigning a Pipeline Job deadline", async () => {
    let now = 1_000;
    const gate = createBenchmarkAdmissionGate({
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
    const deadlines: number[] = [];

    await runBenchmarkJobs({
      admissionGate: gate,
      benchmarkTimeoutMs: 500,
      now: () => now,
      repos: [{ effectiveRepetitions: 1, id: "one" }],
      run: async ({ deadlineAt }) => {
        deadlines.push(deadlineAt ?? -1);
        return resultFor("one");
      },
    });

    expect(deadlines).toEqual([3_500]);
  });

  it("feeds an exact Daytona failure back before the worker admits its next job", async () => {
    let now = 0;
    const admissionKinds: string[] = [];
    const gate = createBenchmarkAdmissionGate({
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });

    await runBenchmarkJobs({
      admissionGate: gate,
      concurrency: 1,
      now: () => now,
      repos: [
        { effectiveRepetitions: 1, id: "outline" },
        { effectiveRepetitions: 1, id: "twenty" },
      ],
      run: async ({ admission, repo }) => {
        admissionKinds.push(admission?.kind ?? "none");
        return {
          ...resultFor(repo.id),
          disposition: "inconclusive",
          failureStage: "repo-security-screen",
          infrastructureFailureKind: "sandbox-infrastructure-failed",
          sandboxProvider: "daytona",
          status: "failed",
        };
      },
    });

    expect(admissionKinds).toEqual(["ordinary", "probe"]);
    expect(now).toBe(15_000);
  });

  it("does not claim queued Pipeline Jobs after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("benchmark interrupted"));
    const run = vi.fn(async () => resultFor("one"));

    await expect(
      runBenchmarkJobs({
        repos: [{ effectiveRepetitions: 1, id: "one" }],
        run,
        signal: controller.signal,
      }),
    ).rejects.toThrow("benchmark interrupted");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not claim or run a Pipeline Job admitted at the suite deadline", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "benchmark-admission-deadline-"),
    );
    const marker = join(directory, "ran");
    const run = vi.fn(async () => {
      await writeFile(marker, "ran");
      return resultFor("one");
    });

    await expect(
      runBenchmarkJobs({
        deadlineAt: 1_000,
        now: () => 1_000,
        repos: [{ effectiveRepetitions: 1, id: "one" }],
        run,
      }),
    ).rejects.toThrow("Benchmark suite deadline was reached before admission.");
    expect(run).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toThrow();
  });

  it("does not start a reserved job after another worker fails while it waits for admission", async () => {
    let releaseSecondAdmission!: () => void;
    let admissionCalls = 0;
    const started: string[] = [];
    const running = runBenchmarkJobs({
      admissionGate: {
        waitForAdmission: async () => {
          admissionCalls += 1;
          if (admissionCalls === 1) return;
          await new Promise<void>((resolve) => {
            releaseSecondAdmission = resolve;
          });
        },
      },
      concurrency: 2,
      repos: [
        { effectiveRepetitions: 1, id: "one" },
        { effectiveRepetitions: 1, id: "two" },
      ],
      run: async ({ repo }) => {
        started.push(repo.id);
        throw new Error("one failed");
      },
    });

    await vi.waitFor(() => expect(started).toEqual(["one"]));
    releaseSecondAdmission();

    await expect(running).rejects.toThrow("one failed");
    expect(started).toEqual(["one"]);
    expect(admissionCalls).toBe(2);
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

function exactDaytonaInfrastructureFailureFor(repoId: string): BenchmarkResult {
  return {
    ...resultFor(repoId),
    disposition: "inconclusive",
    failureStage: "repo-security-screen",
    infrastructureFailureKind: "sandbox-infrastructure-failed",
    sandboxProvider: "daytona",
    status: "failed",
  };
}
