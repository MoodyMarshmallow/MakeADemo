import type {
  BenchmarkDemoVerification,
  BenchmarkDemoVerificationStatus,
} from "./benchmark-demo-verifier.interface";
import type { BenchmarkStatusLevel } from "./benchmark-manifest";

type BenchmarkTokenUsage = {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
};

export type BenchmarkResult = {
  benchmarkRunId: string;
  commitSha: string;
  command?: string[];
  durationMs: number;
  endedAt: string;
  expectedLevel: BenchmarkStatusLevel;
  exitCode: number | null;
  failureMessage?: string;
  failureStage?: string;
  logPath?: string;
  repoId: string;
  repoUrl: string;
  resultPath?: string;
  runDirectory?: string;
  startedAt: string;
  status: "failed" | "succeeded";
  statusLevel: BenchmarkStatusLevel;
  stderrPath?: string;
  stdoutPath?: string;
  tokenUsage: BenchmarkTokenUsage | null;
  verification?: BenchmarkDemoVerification;
};

export type BenchmarkStatusInferenceInput = {
  externalVerificationStatus?: BenchmarkDemoVerificationStatus;
  pipelineStatus?: string;
  succeededEvents?: string[];
};

export type BenchmarkSummary = {
  averageDurationMs: number | null;
  failureStageCounts: Record<string, number>;
  levelCounts: Partial<Record<BenchmarkStatusLevel, number>>;
  maxDurationMs: number | null;
  medianDurationMs: number | null;
  repoCount: number;
  runDurations: Array<{ durationMs: number; repoId: string }>;
  successCount: number;
  tokenUsage: {
    measuredRunCount: number;
    totalCompletionTokens: number;
    totalPromptTokens: number;
    totalTokens: number;
  };
  verificationStatusCounts: Partial<
    Record<BenchmarkDemoVerificationStatus, number>
  >;
};

export function inferBenchmarkStatusLevel(
  input: BenchmarkStatusInferenceInput,
): BenchmarkStatusLevel {
  const succeededEvents = new Set(input.succeededEvents ?? []);

  if (succeededEvents.has("compositing-succeeded")) {
    return input.externalVerificationStatus === "verified" ? "L6" : "L5";
  }
  if (succeededEvents.has("capture-succeeded")) {
    return "L4";
  }
  switch (input.pipelineStatus) {
    case "succeeded":
      return "L5";
    case "validation-failed":
      return "L1";
    default:
      return "L0";
  }
}

export function summarizeBenchmarkResults(
  results: BenchmarkResult[],
): BenchmarkSummary {
  const durations = results
    .map((result) => result.durationMs)
    .sort((a, b) => a - b);
  const measuredTokenRuns = results.filter(
    (result): result is BenchmarkResult & { tokenUsage: BenchmarkTokenUsage } =>
      result.tokenUsage !== null,
  );

  return {
    averageDurationMs: average(durations),
    failureStageCounts: countBy(
      results
        .filter((result) => result.status === "failed")
        .map((result) => result.failureStage ?? "unknown"),
    ),
    levelCounts: countBy(results.map((result) => result.statusLevel)),
    maxDurationMs: durations.at(-1) ?? null,
    medianDurationMs: median(durations),
    repoCount: results.length,
    runDurations: results.map(({ durationMs, repoId }) => ({
      durationMs,
      repoId,
    })),
    successCount: results.filter((result) => result.status === "succeeded")
      .length,
    tokenUsage: {
      measuredRunCount: measuredTokenRuns.length,
      totalCompletionTokens: sumBy(
        measuredTokenRuns,
        (result) => result.tokenUsage.completionTokens,
      ),
      totalPromptTokens: sumBy(
        measuredTokenRuns,
        (result) => result.tokenUsage.promptTokens,
      ),
      totalTokens: sumBy(
        measuredTokenRuns,
        (result) => result.tokenUsage.totalTokens,
      ),
    },
    verificationStatusCounts: countBy(
      results.flatMap((result) =>
        result.verification === undefined ? [] : [result.verification.status],
      ),
    ),
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle] ?? null;
  }

  const left = values[middle - 1];
  const right = values[middle];
  if (left === undefined || right === undefined) {
    return null;
  }

  return (left + right) / 2;
}

function sumBy<T>(values: T[], readValue: (value: T) => number): number {
  return values.reduce((total, value) => total + readValue(value), 0);
}
