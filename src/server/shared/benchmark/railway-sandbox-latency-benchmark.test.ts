import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  RailwaySandboxGateway,
  RailwaySandboxGatewaySandbox,
} from "../integrations/railway/railway-sandbox-gateway.interface";
import { railwaySpikeTemplateRevision } from "../integrations/railway/railway-spike-template-recipe";
import {
  type RailwaySandboxLatencyBenchmarkReport,
  nearestRankPercentile,
  runRailwaySandboxLatencyBenchmark,
  runRailwaySandboxLatencyBenchmarkCli,
} from "./railway-sandbox-latency-benchmark";

describe("nearestRankPercentile", () => {
  it("uses the one-indexed nearest-rank value for p95", () => {
    expect(
      nearestRankPercentile(
        [
          12, 4, 20, 8, 16, 2, 14, 10, 18, 6, 22, 24, 26, 28, 30, 32, 34, 36,
          38, 40,
        ],
        0.95,
      ),
    ).toBe(38);
  });
});

describe("runRailwaySandboxLatencyBenchmark", () => {
  it("fails before constructing Railway dependencies unless explicitly enabled", async () => {
    let constructed = false;

    await expect(
      runRailwaySandboxLatencyBenchmark({
        dependencies: {
          createGateway() {
            constructed = true;
            throw new Error("must not construct");
          },
        },
        environment: {},
      }),
    ).rejects.toThrow(
      "Railway sandbox latency benchmark requires RUN_RAILWAY_SANDBOX_LATENCY_BENCHMARK=1.",
    );
    expect(constructed).toBe(false);
  });

  it("requires dedicated credentials without ambient token fallback", async () => {
    await expect(
      runRailwaySandboxLatencyBenchmark({
        environment: {
          RAILWAY_API_TOKEN: "ambient-account-token",
          RAILWAY_TOKEN: "ambient-project-token",
          RUN_RAILWAY_SANDBOX_LATENCY_BENCHMARK: "1",
        },
      }),
    ).rejects.toThrow(
      "Railway sandbox latency benchmark requires MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN.",
    );
  });

  it("measures both ready sandboxes through their first successful commands", async () => {
    const clock = monotonicConcurrentClock();
    const executed: string[] = [];
    const destroyed: string[] = [];
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({ clock, destroyed, executed }),
      environment: enabledEnvironment(),
    });

    expect(report.samples).toHaveLength(20);
    expect(report.cohort).toBe("prewarmed-exact-recipe");
    expect(report.prewarm).toMatchObject({
      readyAndFirstExecMs: 10,
      status: "succeeded",
    });
    expect(report.samples[0]).toEqual({
      cleanup: {
        activeRunOwnedResourceCount: 0,
        releaseMs: 2,
        verified: true,
      },
      inventory: {
        activeSandboxCount: 1,
        baselineActiveSandboxCount: 1,
        newActiveSandboxCount: 0,
        verified: true,
      },
      phases: { createMs: 7, firstExecMs: 3 },
      readyAndFirstExecMs: 10,
      sample: 1,
      status: "succeeded",
    });
    expect(report).toMatchObject({
      fullPreflightIncluded: false,
      pinnedToolVersions: {
        node: "22.23.1",
        npm: "11.6.2",
        playwright: "1.49.1",
      },
      summary: {
        failureCount: 0,
        maxMs: 10,
        meetsP95Target: true,
        p50Ms: 10,
        p95Ms: 10,
        successfulSampleCount: 20,
        targetP95Ms: 15_000,
      },
      templateRevision: railwaySpikeTemplateRevision,
    });
    expect(executed).toEqual(
      Array.from({ length: 21 }, () => ["parent:true", "child:true"]).flat(),
    );
    expect(destroyed).toEqual(
      Array.from({ length: 21 }, (_, index) => [
        `parent-${index + 1}`,
        `child-${index + 1}`,
      ]).flat(),
    );
  });

  it("reports a failed sample and continues only after verified cleanup", async () => {
    const clock = monotonicConcurrentClock();
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock,
        destroyed: [],
        executed: [],
        failChildOnCreateCall: 2,
      }),
      environment: enabledEnvironment(),
    });

    expect(report.samples).toHaveLength(20);
    expect(report.samples[0]).toMatchObject({
      cleanup: { activeRunOwnedResourceCount: 0, verified: true },
      failedPhase: "first-exec",
      status: "failed",
    });
    expect(report.summary).toMatchObject({
      failureCount: 1,
      meetsP95Target: false,
      successfulSampleCount: 19,
    });
  });

  it("reports create failure only after authoritative cleanup verification", async () => {
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock: monotonicConcurrentClock(),
        destroyed: [],
        executed: [],
        failCreateOnCall: 2,
      }),
      environment: enabledEnvironment(),
    });

    expect(report.samples[0]).toMatchObject({
      cleanup: { verified: true },
      failedPhase: "create",
      inventory: {
        baselineActiveSandboxCount: 1,
        newActiveSandboxCount: 0,
        verified: true,
      },
      status: "failed",
    });
    expect(report.summary.failureCount).toBe(1);
  });

  it("waits for authoritative inventory to converge after both owned sandboxes are destroyed", async () => {
    const destroyed: string[] = [];
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock: monotonicConcurrentClock(),
        destroyed,
        executed: [],
        staleChildInventoryAfterReleaseCall: 1,
      }),
      environment: enabledEnvironment(),
    });

    expect(report.prewarm).toMatchObject({
      cleanup: { activeRunOwnedResourceCount: 0, verified: true },
      inventory: { newActiveSandboxCount: 0, verified: true },
      status: "succeeded",
    });
    expect(destroyed.slice(0, 2)).toEqual(["parent-1", "child-1"]);
  });

  it("bounds a hanging second authoritative cleanup read by the total convergence deadline", async () => {
    const benchmark = runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock: monotonicConcurrentClock(),
        destroyed: [],
        executed: [],
        hangingInventoryRead: 3,
        inventoryTimeoutMs: 5,
      }),
      environment: enabledEnvironment(),
    });

    const failure = await Promise.race([
      benchmark,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("test harness observed an unbounded read")),
          25,
        );
      }),
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("cleanup is unverified");
    expect((failure as Error).message).not.toContain("test harness");
  });

  it("rejects a second baseline match that settles after the total convergence deadline", async () => {
    await expect(
      runRailwaySandboxLatencyBenchmark({
        dependencies: benchmarkDependencies({
          clock: monotonicConcurrentClock(),
          delayedInventoryRead: { delayMs: 10, read: 3 },
          destroyed: [],
          executed: [],
          inventoryTimeoutMs: 5,
        }),
        environment: enabledEnvironment(),
      }),
    ).rejects.toThrow("cleanup is unverified");
  });

  it("records a reconciled cleanup warning without failing startup after authoritative inventory proves the exact owned sandbox is absent", async () => {
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock: monotonicConcurrentClock(),
        destroyChildThenRejectOnReleaseCall: 2,
        destroyed: [],
        executed: [],
      }),
      environment: enabledEnvironment(),
    });

    expect(report.samples[0]).toMatchObject({
      cleanup: {
        activeRunOwnedResourceCount: 0,
        reconciledWarning: {
          code: "release-settlement-reconciled",
          message:
            "Railway release settlement failed after authoritative inventory verified cleanup.",
        },
        verified: true,
      },
      inventory: { newActiveSandboxCount: 0, verified: true },
      status: "succeeded",
    });
    expect(report.summary).toMatchObject({
      failureCount: 0,
      successfulSampleCount: 20,
    });
    expect(JSON.stringify(report.samples[0])).not.toContain(
      "destroy settlement timed out",
    );
    expect(JSON.stringify(report.samples[0])).not.toContain("child-2");
  });

  it("fails closed when release leaves a run-owned sandbox live", async () => {
    const projectToken = "sensitive-project-token";
    const dependencies = benchmarkDependencies({
      clock: monotonicConcurrentClock(),
      destroyed: [],
      executed: [],
      leakChildOnReleaseCall: 2,
    });

    await expect(
      runRailwaySandboxLatencyBenchmark({
        dependencies,
        environment: {
          ...enabledEnvironment(),
          MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: projectToken,
        },
      }),
    ).rejects.toThrow("authoritative inventory found 1 new active sandbox");
    expect(dependencies.createdCallCount()).toBe(2);
  });

  it("reports an externally appearing live sandbox without exposing or destroying its id", async () => {
    const destroyed: string[] = [];
    const dependencies = benchmarkDependencies({
      clock: monotonicConcurrentClock(),
      destroyed,
      executed: [],
      injectUnknownAfterReleaseCall: 2,
    });

    let failure: unknown;
    try {
      await runRailwaySandboxLatencyBenchmark({
        dependencies,
        environment: enabledEnvironment(),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "authoritative inventory found 1 new active sandbox",
    );
    expect((failure as Error).message).not.toContain("external-unknown-2");
    expect(destroyed).not.toContain("external-unknown-2");
    expect(destroyed).not.toContain("baseline-id");
  });

  it("redacts the dedicated token from a measured create failure", async () => {
    const projectToken = "sensitive-project-token";
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock: monotonicConcurrentClock(),
        createFailureMessage: `provider rejected ${projectToken}`,
        destroyed: [],
        executed: [],
        failCreateOnCall: 2,
      }),
      environment: {
        ...enabledEnvironment(),
        MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: projectToken,
      },
    });

    expect(report.samples[0]).toMatchObject({
      error: { message: "provider rejected [REDACTED]" },
      status: "failed",
    });
    expect(JSON.stringify(report)).not.toContain(projectToken);
  });

  it("treats exactly 15000ms p95 as missing the strict target", async () => {
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock: monotonicConcurrentClock({ createMs: 14_997, childExecMs: 3 }),
        destroyed: [],
        executed: [],
      }),
      environment: enabledEnvironment(),
    });

    expect(report.summary).toMatchObject({
      meetsP95Target: false,
      p95Ms: 15_000,
      targetP95Ms: 15_000,
    });
  });

  it("never includes the separately reported prewarm in percentiles", async () => {
    const report = await runRailwaySandboxLatencyBenchmark({
      dependencies: benchmarkDependencies({
        clock: monotonicConcurrentClock({ prewarmCreateMs: 30_000 }),
        destroyed: [],
        executed: [],
      }),
      environment: enabledEnvironment(),
    });

    expect(report.prewarm.readyAndFirstExecMs).toBe(30_003);
    expect(report.summary).toMatchObject({
      maxMs: 10,
      p50Ms: 10,
      p95Ms: 10,
    });
  });

  it("rejects sample counts outside the safe 20-to-100 range", async () => {
    await expect(
      runRailwaySandboxLatencyBenchmark({
        environment: {
          ...enabledEnvironment(),
          MAKEADEMO_RAILWAY_SANDBOX_BENCHMARK_SAMPLES: "101",
        },
      }),
    ).rejects.toThrow(
      "MAKEADEMO_RAILWAY_SANDBOX_BENCHMARK_SAMPLES must be an integer from 20 to 100.",
    );
  });
});

describe("runRailwaySandboxLatencyBenchmarkCli", () => {
  it("prints the report and fails the command when the p95 target misses", async () => {
    const output: string[] = [];
    const cliProcess = {
      exitCode: undefined as number | undefined,
      stderr: { write() {} },
      stdout: {
        write(value: string) {
          output.push(value);
        },
      },
    };
    const report = {
      summary: { meetsP95Target: false },
    } as RailwaySandboxLatencyBenchmarkReport;

    await runRailwaySandboxLatencyBenchmarkCli({
      process: cliProcess,
      run: async () => report,
    });

    expect(JSON.parse(output.join(""))).toEqual(report);
    expect(cliProcess.exitCode).toBe(1);
  });
});

function enabledEnvironment(): Record<string, string> {
  return {
    MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID: "environment-id",
    MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: "project-token",
    RUN_RAILWAY_SANDBOX_LATENCY_BENCHMARK: "1",
  };
}

function benchmarkDependencies(input: {
  clock: ReturnType<typeof monotonicConcurrentClock>;
  createFailureMessage?: string;
  destroyChildThenRejectOnReleaseCall?: number;
  destroyed: string[];
  executed: string[];
  failChildOnCreateCall?: number;
  failCreateOnCall?: number;
  hangingInventoryRead?: number;
  injectUnknownAfterReleaseCall?: number;
  inventoryTimeoutMs?: number;
  leakChildOnReleaseCall?: number;
  delayedInventoryRead?: Readonly<{ delayMs: number; read: number }>;
  staleChildInventoryAfterReleaseCall?: number;
}) {
  let sample = 0;
  let inventoryReads = 0;
  const activeIds = new Set(["baseline-id"]);
  const gateway: RailwaySandboxGateway = {
    async createSandbox(options) {
      const id = options.env.TEST_SANDBOX_ID;
      if (id === undefined) throw new Error("Missing test sandbox id.");
      activeIds.add(id);
      return { id };
    },
    async destroySandbox(sandbox) {
      input.destroyed.push(sandbox.id);
      if (
        input.staleChildInventoryAfterReleaseCall !== undefined &&
        sandbox.id === `child-${input.staleChildInventoryAfterReleaseCall}`
      ) {
        return;
      }
      activeIds.delete(sandbox.id);
      if (
        input.destroyChildThenRejectOnReleaseCall !== undefined &&
        sandbox.id === `child-${input.destroyChildThenRejectOnReleaseCall}`
      ) {
        throw new Error("destroy settlement timed out");
      }
    },
    execute() {
      throw new Error("Provider fake owns execution for this seam test.");
    },
    async readFile() {
      throw new Error("not used");
    },
    async listActiveSandboxes(options?: { signal?: AbortSignal }) {
      inventoryReads += 1;
      if (inventoryReads === input.hangingInventoryRead) {
        return new Promise<readonly RailwaySandboxGatewaySandbox[]>(
          (_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true },
            );
          },
        );
      }
      if (inventoryReads === input.delayedInventoryRead?.read) {
        await new Promise((resolve) =>
          setTimeout(resolve, input.delayedInventoryRead?.delayMs),
        );
      }
      const active = [...activeIds].map((id) => ({ id }));
      if (input.staleChildInventoryAfterReleaseCall !== undefined) {
        activeIds.delete(`child-${input.staleChildInventoryAfterReleaseCall}`);
      }
      return active;
    },
    async writeFile() {
      throw new Error("not used");
    },
  };
  return {
    createGateway: () => gateway,
    createProvider(trackedGateway: RailwaySandboxGateway) {
      return {
        async create(): Promise<PreparationWorkspaceHandle> {
          sample += 1;
          await input.clock.delay(
            sample === 1 ? input.clock.prewarmCreateMs : input.clock.createMs,
          );
          const parent = { id: `parent-${sample}` };
          const child = { id: `child-${sample}` };
          await register(trackedGateway, parent);
          await register(trackedGateway, child);
          if (input.failCreateOnCall === sample) {
            await trackedGateway.destroySandbox(parent);
            await trackedGateway.destroySandbox(child);
            throw new Error(input.createFailureMessage ?? "create failed");
          }
          return {
            id: parent.id,
            async release() {
              await input.clock.delay(input.clock.releaseMs);
              await trackedGateway.destroySandbox(parent);
              if (input.leakChildOnReleaseCall === sample) {
                throw new Error("release failed before child cleanup");
              }
              await trackedGateway.destroySandbox(child);
              if (input.injectUnknownAfterReleaseCall === sample) {
                activeIds.add(`external-unknown-${sample}`);
              }
            },
            workspace: {
              async execute(command) {
                input.executed.push(`parent:${command}`);
                await input.clock.delay(input.clock.parentExecMs);
                return { exitCode: 0, stderr: "", stdout: "ready\n" };
              },
              async executeSubmittedCode(command) {
                input.executed.push(`child:${command}`);
                await input.clock.delay(input.clock.childExecMs);
                return {
                  exitCode: input.failChildOnCreateCall === sample ? 1 : 0,
                  stderr: "",
                  stdout: "ready\n",
                };
              },
              async uploadFiles() {},
            },
          };
        },
      };
    },
    createdCallCount: () => sample,
    inventoryPollIntervalMs: 1,
    inventoryTimeoutMs: input.inventoryTimeoutMs ?? 100,
    now: () => input.clock.now(),
  };
}

function monotonicConcurrentClock(
  input: {
    childExecMs?: number;
    createMs?: number;
    parentExecMs?: number;
    prewarmCreateMs?: number;
    releaseMs?: number;
  } = {},
) {
  let milliseconds = 0;
  let pending: Array<{ milliseconds: number; resolve(): void }> | undefined;
  return {
    childExecMs: input.childExecMs ?? 3,
    createMs: input.createMs ?? 7,
    delay(duration: number): Promise<void> {
      return new Promise((resolve) => {
        pending ??= [];
        pending.push({ milliseconds: duration, resolve });
        if (pending.length === 1) {
          queueMicrotask(() => {
            const current = pending ?? [];
            pending = undefined;
            milliseconds += Math.max(
              ...current.map((item) => item.milliseconds),
            );
            for (const item of current) item.resolve();
          });
        }
      });
    },
    now: () => milliseconds,
    parentExecMs: input.parentExecMs ?? 2,
    prewarmCreateMs: input.prewarmCreateMs ?? input.createMs ?? 7,
    releaseMs: input.releaseMs ?? 2,
  };
}

async function register(
  gateway: RailwaySandboxGateway,
  sandbox: RailwaySandboxGatewaySandbox,
): Promise<void> {
  await gateway.createSandbox({
    env: { TEST_SANDBOX_ID: sandbox.id },
    idleTimeoutMinutes: 1,
    networkIsolation: "ISOLATED",
    timeoutMs: 1,
  });
}
