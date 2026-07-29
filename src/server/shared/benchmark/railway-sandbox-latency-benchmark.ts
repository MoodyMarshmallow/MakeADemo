import { setTimeout as wait } from "node:timers/promises";

import type { PreparationWorkspaceHandle } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  RailwaySandboxGateway,
  RailwaySandboxGatewaySandbox,
} from "../integrations/railway/railway-sandbox-gateway.interface";
import { RailwaySdkSandboxGateway } from "../integrations/railway/railway-sdk-sandbox-gateway";
import { RailwaySpikePreparationWorkspaceProvider } from "../integrations/railway/railway-spike-preparation-workspace-provider";
import {
  railwaySpikeTemplateRecipe,
  railwaySpikeTemplateRevision,
} from "../integrations/railway/railway-spike-template-recipe";

const defaultSampleCount = 20;
const maximumSampleCount = 100;
const sampleTimeoutMs = 60_000;
const firstExecTimeoutMs = 15_000;
const targetP95Ms = 15_000;
const inventoryVerificationPollIntervalMs = 250;
const inventoryVerificationTimeoutMs = 30_000;

type RailwayBenchmarkEnvironment = Readonly<Record<string, string | undefined>>;

type RailwaySandboxLatencyBenchmarkDependencies = {
  createGateway?: (input: {
    environmentId: string;
    projectToken: string;
    railwayAgentSession?: string;
    railwayCaller?: string;
  }) => RailwaySandboxGateway;
  createProvider?: (gateway: RailwaySandboxGateway) => {
    create(options?: {
      signal?: AbortSignal;
    }): Promise<PreparationWorkspaceHandle>;
  };
  inventoryPollIntervalMs?: number;
  inventoryTimeoutMs?: number;
  now?: () => number;
};

export type RailwaySandboxLatencyBenchmarkInput = {
  dependencies?: RailwaySandboxLatencyBenchmarkDependencies;
  environment?: RailwayBenchmarkEnvironment;
  signal?: AbortSignal;
};

type RailwaySandboxLatencySuccessfulSample = Readonly<{
  cleanup: Readonly<{
    activeRunOwnedResourceCount: 0;
    reconciledWarning?: Readonly<{
      code: "release-settlement-reconciled";
      message: string;
    }>;
    releaseMs: number;
    verified: true;
  }>;
  inventory: RailwaySandboxLatencyInventoryVerification;
  phases: Readonly<{
    createMs: number;
    firstExecMs: number;
  }>;
  readyAndFirstExecMs: number;
  sample: number;
  status: "succeeded";
}>;

type RailwaySandboxLatencyFailedSample = Readonly<{
  cleanup: Readonly<{
    activeRunOwnedResourceCount: 0;
    releaseMs: number;
    verified: true;
  }>;
  elapsedMs: number;
  error: Readonly<{ message: string; name: string }>;
  failedPhase: "create" | "first-exec" | "release";
  inventory: RailwaySandboxLatencyInventoryVerification;
  sample: number;
  status: "failed";
}>;

type RailwaySandboxLatencySample =
  | RailwaySandboxLatencyFailedSample
  | RailwaySandboxLatencySuccessfulSample;

type RailwaySandboxLatencyInventoryVerification = Readonly<{
  activeSandboxCount: number;
  baselineActiveSandboxCount: number;
  newActiveSandboxCount: 0;
  verified: true;
}>;

type RailwaySandboxLatencyPrewarm = Omit<
  RailwaySandboxLatencySuccessfulSample,
  "sample"
>;

type RailwaySandboxLatencyAttempt =
  RailwaySandboxLatencySample extends infer Sample
    ? Sample extends RailwaySandboxLatencySample
      ? Omit<Sample, "sample">
      : never
    : never;

export type RailwaySandboxLatencyBenchmarkReport = Readonly<{
  benchmark: "railway-two-sandbox-ready-and-first-exec";
  cohort: "prewarmed-exact-recipe";
  fullPreflightIncluded: false;
  percentileMethod: "nearest-rank over successful samples: sort ascending and select ceil(p * n), one-indexed";
  pinnedToolVersions: Readonly<{
    node: string;
    npm: string;
    playwright: string;
  }>;
  prewarm: RailwaySandboxLatencyPrewarm;
  requestedSampleCount: number;
  samples: readonly RailwaySandboxLatencySample[];
  summary: Readonly<{
    failureCount: number;
    maxMs: number | null;
    meetsP95Target: boolean;
    p50Ms: number | null;
    p95Ms: number | null;
    successfulSampleCount: number;
    targetP95Ms: 15_000;
  }>;
  templateRevision: string;
}>;

/**
 * Returns the one-indexed nearest-rank percentile: after sorting ascending,
 * select item `ceil(percentile * sample count)`.
 */
export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number {
  if (values.length === 0) {
    throw new Error("A percentile requires at least one value.");
  }
  if (percentile <= 0 || percentile > 1) {
    throw new Error("Percentile must be greater than 0 and at most 1.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] as number;
}

/**
 * Measures Railway's warm two-sandbox readiness separately from the complete
 * Demo Runtime Preflight. The opt-in and credentials are intentionally
 * dedicated so imports and ordinary tests cannot provision resources.
 */
export async function runRailwaySandboxLatencyBenchmark(
  input: RailwaySandboxLatencyBenchmarkInput = {},
): Promise<RailwaySandboxLatencyBenchmarkReport> {
  const environment = input.environment ?? process.env;
  if (environment.RUN_RAILWAY_SANDBOX_LATENCY_BENCHMARK !== "1") {
    throw new Error(
      "Railway sandbox latency benchmark requires RUN_RAILWAY_SANDBOX_LATENCY_BENCHMARK=1.",
    );
  }
  const projectToken =
    environment.MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN?.trim();
  if (!projectToken) {
    throw new Error(
      "Railway sandbox latency benchmark requires MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN.",
    );
  }
  const environmentId =
    environment.MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID?.trim();
  if (!environmentId) {
    throw new Error(
      "Railway sandbox latency benchmark requires MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID.",
    );
  }
  const sampleCount = readSampleCount(environment);
  const credentials = {
    environmentId,
    projectToken,
    ...optionalValue("railwayAgentSession", environment.RAILWAY_AGENT_SESSION),
    ...optionalValue("railwayCaller", environment.RAILWAY_CALLER),
  };
  const dependencies = input.dependencies ?? {};
  const gateway = new TrackingRailwaySandboxGateway(
    dependencies.createGateway?.(credentials) ??
      new RailwaySdkSandboxGateway(credentials),
    {
      pollIntervalMs:
        dependencies.inventoryPollIntervalMs ??
        inventoryVerificationPollIntervalMs,
      timeoutMs:
        dependencies.inventoryTimeoutMs ?? inventoryVerificationTimeoutMs,
    },
  );
  const provider =
    dependencies.createProvider?.(gateway) ??
    new RailwaySpikePreparationWorkspaceProvider({ gateway });
  const now = dependencies.now ?? (() => performance.now());
  const samples: RailwaySandboxLatencySample[] = [];
  const baseline = await gateway.captureActiveInventoryBaseline();
  const prewarmAttempt = await runBenchmarkAttempt({
    baseline,
    gateway,
    now,
    projectToken,
    provider,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (prewarmAttempt.status === "failed") {
    throw new Error(
      `Railway exact-recipe prewarm failed during ${prewarmAttempt.failedPhase}: ${prewarmAttempt.error.message}`,
    );
  }
  const prewarm = prewarmAttempt;

  for (let index = 0; index < sampleCount; index += 1) {
    const attempt = await runBenchmarkAttempt({
      baseline,
      gateway,
      now,
      projectToken,
      provider,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    samples.push({ ...attempt, sample: index + 1 });
  }

  const successfulSamples = samples.filter(
    (sample): sample is RailwaySandboxLatencySuccessfulSample =>
      sample.status === "succeeded",
  );
  const durations = successfulSamples.map(
    (sample) => sample.readyAndFirstExecMs,
  );
  const p95Ms = percentileOrNull(durations, 0.95);
  const failureCount = samples.length - successfulSamples.length;
  return {
    benchmark: "railway-two-sandbox-ready-and-first-exec",
    cohort: "prewarmed-exact-recipe",
    fullPreflightIncluded: false,
    percentileMethod:
      "nearest-rank over successful samples: sort ascending and select ceil(p * n), one-indexed",
    pinnedToolVersions: {
      node: railwaySpikeTemplateRecipe.node.version,
      npm: railwaySpikeTemplateRecipe.node.npmVersion,
      playwright: railwaySpikeTemplateRecipe.playwright.version,
    },
    prewarm,
    requestedSampleCount: sampleCount,
    samples,
    summary: {
      failureCount,
      maxMs: durations.length === 0 ? null : Math.max(...durations),
      meetsP95Target:
        failureCount === 0 && p95Ms !== null && p95Ms < targetP95Ms,
      p50Ms: percentileOrNull(durations, 0.5),
      p95Ms,
      successfulSampleCount: successfulSamples.length,
      targetP95Ms,
    },
    templateRevision: railwaySpikeTemplateRevision,
  };
}

async function runBenchmarkAttempt(input: {
  baseline: ReadonlySet<string>;
  gateway: TrackingRailwaySandboxGateway;
  now: () => number;
  projectToken: string;
  provider: {
    create(options?: {
      signal?: AbortSignal;
    }): Promise<PreparationWorkspaceHandle>;
  };
  signal?: AbortSignal;
}): Promise<RailwaySandboxLatencyAttempt> {
  throwIfAborted(input.signal);
  input.gateway.assertNoActiveRunOwnedResources();
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new Error(
          `Railway latency benchmark sample timed out after ${sampleTimeoutMs}ms.`,
        ),
      ),
    sampleTimeoutMs,
  );
  const signal = combineSignals(input.signal, timeoutController.signal);
  const startedAt = input.now();
  let createdAt: number | undefined;
  let readyAt: number | undefined;
  let handle: PreparationWorkspaceHandle | undefined;
  let failedPhase: RailwaySandboxLatencyFailedSample["failedPhase"] = "create";
  let operationError: unknown;
  let releaseError: unknown;
  let releaseMs = 0;
  try {
    handle = await input.provider.create({ signal });
    createdAt = input.now();
    failedPhase = "first-exec";
    const executeSubmittedCode = handle.workspace.executeSubmittedCode;
    if (executeSubmittedCode === undefined) {
      throw new Error(
        "Railway latency benchmark requires an independent submitted-code sandbox.",
      );
    }
    const [parentResult, childResult] = await Promise.all([
      handle.workspace.execute("true", { timeoutMs: firstExecTimeoutMs }),
      executeSubmittedCode.call(handle.workspace, "true", {
        timeoutMs: firstExecTimeoutMs,
      }),
    ]);
    assertSuccessfulFirstExec("parent", parentResult.exitCode);
    assertSuccessfulFirstExec("child", childResult.exitCode);
    readyAt = input.now();
  } catch (error) {
    operationError = error;
  } finally {
    clearTimeout(timeout);
    if (handle !== undefined) {
      const releaseStartedAt = input.now();
      try {
        await handle.release();
      } catch (error) {
        releaseError = error;
        operationError =
          operationError === undefined
            ? error
            : new AggregateError(
                [operationError, error],
                "Railway latency sample operation and release both failed.",
              );
        failedPhase = "release";
      }
      releaseMs = input.now() - releaseStartedAt;
    }
  }
  const inventory = await input.gateway.verifyActiveInventoryMatchesBaseline(
    input.baseline,
    signal,
  );
  input.gateway.assertNoActiveRunOwnedResources();
  const releaseOnlyError =
    releaseError !== undefined && operationError === releaseError;
  if (operationError !== undefined && !releaseOnlyError) {
    return {
      cleanup: {
        activeRunOwnedResourceCount: 0,
        releaseMs,
        verified: true,
      },
      elapsedMs: input.now() - startedAt,
      error: readRedactedError(operationError, input.projectToken),
      failedPhase,
      inventory,
      status: "failed",
    };
  }
  if (createdAt === undefined || readyAt === undefined) {
    throw new Error("Railway latency sample completed without timings.");
  }
  return {
    cleanup: {
      activeRunOwnedResourceCount: 0,
      ...(releaseOnlyError
        ? {
            reconciledWarning: {
              code: "release-settlement-reconciled" as const,
              message:
                "Railway release settlement failed after authoritative inventory verified cleanup.",
            },
          }
        : {}),
      releaseMs,
      verified: true,
    },
    inventory,
    phases: {
      createMs: createdAt - startedAt,
      firstExecMs: readyAt - createdAt,
    },
    readyAndFirstExecMs: readyAt - startedAt,
    status: "succeeded",
  };
}

type RailwaySandboxLatencyBenchmarkCliProcess = {
  exitCode: number | undefined;
  off?(event: NodeJS.Signals, listener: () => void): unknown;
  once?(event: NodeJS.Signals, listener: () => void): unknown;
  stderr: { write(value: string): unknown };
  stdout: { write(value: string): unknown };
};

/** Runs the opt-in latency benchmark and preserves cleanup on interruption. */
export async function runRailwaySandboxLatencyBenchmarkCli(
  input: {
    process?: RailwaySandboxLatencyBenchmarkCliProcess;
    run?: (
      input: RailwaySandboxLatencyBenchmarkInput,
    ) => Promise<RailwaySandboxLatencyBenchmarkReport>;
  } = {},
): Promise<void> {
  const cliProcess = input.process ?? process;
  const run = input.run ?? runRailwaySandboxLatencyBenchmark;
  const controller = new AbortController();
  let signalExitCode: 130 | 143 | undefined;
  const onSigint = () => {
    signalExitCode ??= 130;
    controller.abort(new Error("SIGINT"));
  };
  const onSigterm = () => {
    signalExitCode ??= 143;
    controller.abort(new Error("SIGTERM"));
  };
  cliProcess.once?.("SIGINT", onSigint);
  cliProcess.once?.("SIGTERM", onSigterm);
  try {
    const report = await run({ signal: controller.signal });
    cliProcess.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    cliProcess.exitCode = report.summary.meetsP95Target ? 0 : 1;
  } catch (error) {
    const secret = process.env.MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN ?? "";
    const diagnostic = readRedactedError(error, secret);
    cliProcess.stderr.write(
      `${JSON.stringify({
        error: diagnostic,
        event: "railway-sandbox-latency-benchmark-failed",
      })}\n`,
    );
    cliProcess.exitCode = signalExitCode ?? 1;
  } finally {
    cliProcess.off?.("SIGINT", onSigint);
    cliProcess.off?.("SIGTERM", onSigterm);
  }
}

function percentileOrNull(
  values: readonly number[],
  percentile: number,
): number | null {
  return values.length === 0 ? null : nearestRankPercentile(values, percentile);
}

function readRedactedError(
  error: unknown,
  secret: string,
): { message: string; name: string } {
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    message:
      secret === ""
        ? source.message
        : source.message.split(secret).join("[REDACTED]"),
    name: source.name,
  };
}

function readSampleCount(environment: RailwayBenchmarkEnvironment): number {
  const raw = environment.MAKEADEMO_RAILWAY_SANDBOX_BENCHMARK_SAMPLES;
  if (raw === undefined) return defaultSampleCount;
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < defaultSampleCount ||
    parsed > maximumSampleCount
  ) {
    throw new Error(
      `MAKEADEMO_RAILWAY_SANDBOX_BENCHMARK_SAMPLES must be an integer from ${defaultSampleCount} to ${maximumSampleCount}.`,
    );
  }
  return parsed;
}

function optionalValue<Key extends string>(
  key: Key,
  value: string | undefined,
): { [Property in Key]?: string } {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === ""
    ? {}
    : ({ [key]: trimmed } as { [Property in Key]?: string });
}

function assertSuccessfulFirstExec(role: string, exitCode: number): void {
  if (exitCode !== 0) {
    throw new Error(
      `Railway latency benchmark ${role} first exec exited ${exitCode}.`,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Railway latency benchmark was aborted.");
  }
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  return signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);
}

class TrackingRailwaySandboxGateway implements RailwaySandboxGateway {
  private readonly activeRunOwnedIds = new Set<string>();
  private readonly allRunOwnedIds = new Set<string>();

  constructor(
    private readonly gateway: RailwaySandboxGateway,
    private readonly inventoryVerification: {
      pollIntervalMs: number;
      timeoutMs: number;
    },
  ) {}

  async captureActiveInventoryBaseline(): Promise<ReadonlySet<string>> {
    return new Set(
      (await this.listAuthoritativeActiveSandboxes()).map(
        (sandbox) => sandbox.id,
      ),
    );
  }

  async createSandbox(
    options: Parameters<RailwaySandboxGateway["createSandbox"]>[0],
  ): Promise<RailwaySandboxGatewaySandbox> {
    const sandbox = await this.gateway.createSandbox(options);
    if (this.allRunOwnedIds.has(sandbox.id)) {
      throw new Error(`Railway returned duplicate sandbox id ${sandbox.id}.`);
    }
    this.allRunOwnedIds.add(sandbox.id);
    this.activeRunOwnedIds.add(sandbox.id);
    return sandbox;
  }

  drainPendingCreations(options: { timeoutMs: number }): Promise<void> {
    return this.gateway.drainPendingCreations?.(options) ?? Promise.resolve();
  }

  async destroySandbox(sandbox: RailwaySandboxGatewaySandbox): Promise<void> {
    if (!this.allRunOwnedIds.has(sandbox.id)) {
      throw new Error(
        `Railway latency benchmark refused to destroy unowned sandbox ${sandbox.id}.`,
      );
    }
    await this.gateway.destroySandbox(sandbox);
    this.activeRunOwnedIds.delete(sandbox.id);
  }

  execute(
    ...args: Parameters<RailwaySandboxGateway["execute"]>
  ): ReturnType<RailwaySandboxGateway["execute"]> {
    return this.gateway.execute(...args);
  }

  listActiveSandboxes(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<readonly RailwaySandboxGatewaySandbox[]> {
    return this.listAuthoritativeActiveSandboxes(options);
  }

  readFile(
    ...args: Parameters<RailwaySandboxGateway["readFile"]>
  ): ReturnType<RailwaySandboxGateway["readFile"]> {
    return this.gateway.readFile(...args);
  }

  writeFile(
    ...args: Parameters<RailwaySandboxGateway["writeFile"]>
  ): ReturnType<RailwaySandboxGateway["writeFile"]> {
    return this.gateway.writeFile(...args);
  }

  async verifyActiveInventoryMatchesBaseline(
    baseline: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<RailwaySandboxLatencyInventoryVerification> {
    const deadline = Date.now() + this.inventoryVerification.timeoutMs;
    let consecutiveBaselineMatches = 0;
    let active: readonly RailwaySandboxGatewaySandbox[] = [];
    let newActiveCount = 0;
    for (;;) {
      throwIfAborted(signal);
      const remainingBeforeRead = deadline - Date.now();
      if (remainingBeforeRead <= 0) {
        throw inventoryConvergenceError(newActiveCount);
      }
      active = await readAuthoritativeInventoryWithinDeadline(
        (readSignal) =>
          this.listAuthoritativeActiveSandboxes({
            signal: readSignal,
            timeoutMs: remainingBeforeRead,
          }),
        remainingBeforeRead,
        signal,
      );
      throwIfAborted(signal);
      if (Date.now() >= deadline) {
        throw inventoryConvergenceError(newActiveCount);
      }
      newActiveCount = active.filter(
        (sandbox) => !baseline.has(sandbox.id),
      ).length;
      consecutiveBaselineMatches =
        newActiveCount === 0 ? consecutiveBaselineMatches + 1 : 0;
      if (consecutiveBaselineMatches === 2) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw inventoryConvergenceError(newActiveCount);
      }
      await waitForInventoryPoll(
        Math.min(this.inventoryVerification.pollIntervalMs, remainingMs),
        signal,
      );
    }
    const authoritativeActiveIds = new Set(active.map((sandbox) => sandbox.id));
    for (const id of this.activeRunOwnedIds) {
      if (!authoritativeActiveIds.has(id)) {
        this.activeRunOwnedIds.delete(id);
      }
    }
    return {
      activeSandboxCount: active.length,
      baselineActiveSandboxCount: baseline.size,
      newActiveSandboxCount: 0,
      verified: true,
    };
  }

  assertNoActiveRunOwnedResources(): void {
    if (this.activeRunOwnedIds.size > 0) {
      throw new Error(
        `Railway latency benchmark cleanup left ${this.activeRunOwnedIds.size} run-owned sandbox(es) active.`,
      );
    }
  }

  private listAuthoritativeActiveSandboxes(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<readonly RailwaySandboxGatewaySandbox[]> {
    const list = this.gateway.listActiveSandboxes;
    if (list === undefined) {
      throw new Error(
        "Railway latency benchmark requires authoritative active-sandbox inventory.",
      );
    }
    return list.call(this.gateway, options);
  }
}

function inventoryConvergenceError(newActiveCount: number): Error {
  return new Error(
    newActiveCount > 0
      ? `Railway latency benchmark authoritative inventory found ${newActiveCount} new active sandbox(es) relative to baseline; cleanup is unverified.`
      : "Railway latency benchmark authoritative inventory did not converge before its deadline; cleanup is unverified.",
  );
}

function readAuthoritativeInventoryWithinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const combinedSignal =
    signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
  const timeoutError = inventoryConvergenceError(0);
  return new Promise<T>((resolve, reject) => {
    if (combinedSignal.aborted) {
      reject(
        combinedSignal.reason instanceof Error
          ? combinedSignal.reason
          : timeoutError,
      );
      return;
    }
    let settled = false;
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      combinedSignal.removeEventListener("abort", onAbort);
      result();
    };
    const onAbort = () => {
      const reason = combinedSignal.reason;
      settle(() => reject(reason instanceof Error ? reason : timeoutError));
    };
    combinedSignal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      Math.max(1, timeoutMs),
    );
    timeout.unref?.();
    Promise.resolve()
      .then(() => operation(combinedSignal))
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

async function waitForInventoryPoll(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await wait(Math.max(1, milliseconds));
    return;
  }
  await wait(Math.max(1, milliseconds), undefined, { signal });
}
