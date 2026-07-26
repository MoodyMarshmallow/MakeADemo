import { basename, dirname, relative, resolve, sep } from "node:path";

import type { BenchmarkStatusLevel } from "./benchmark-manifest";

type BenchmarkTokenUsage = {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
};

export type BenchmarkResult = {
  benchmarkRunId: string;
  benchmarkTimeoutMs?: number;
  commitSha: string;
  command?: string[];
  disposition?: "completed" | "inconclusive";
  durationMs: number;
  endedAt: string;
  expectedLevel: BenchmarkStatusLevel;
  exitCode: number | null;
  failureMessage?: string;
  failureStage?: string;
  infrastructureFailureKind?:
    | "pipeline-cancelled"
    | "pipeline-deadline-exceeded"
    | "dependency-install-sigkill"
    | "process-terminated"
    | "terminal-result-unavailable";
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
  terminationReason?: "deadline" | "result-grace" | "signal";
};

export type BenchmarkTerminalPipelineResult = {
  artifacts?: {
    logPath?: string;
  };
  failure?: {
    blockers?: string[];
    failureKind?:
      | "dependency-install-sigkill"
      | "repository_node_dependency_incompatible";
  };
  cancellationReason?: "deadline-exceeded" | "signal";
  resultPath: string;
  status:
    | "capture-path-validation-failed"
    | "preparation-failed"
    | "cancelled"
    | "security-rejected"
    | "succeeded";
};

export type BenchmarkResultBuildInput = {
  benchmarkRunId: string;
  benchmarkTimeoutMs: number;
  command: string[];
  commitSha: string;
  durationMs: number;
  endedAt: string;
  expectedLevel: BenchmarkStatusLevel;
  fullPipelineLog: BenchmarkStatusInferenceInput & {
    failureStage?: string;
    latestStage?: string;
  };
  fullPipelineResult?: BenchmarkTerminalPipelineResult;
  lifecycle: {
    exitCode: number | null;
    killed: boolean;
    terminationReason?: "deadline" | "result-grace" | "signal";
  };
  repoId: string;
  repoUrl: string;
  runDirectory: string;
  startedAt: string;
  stderrPath: string;
  stdoutPath: string;
};

export type BenchmarkStatusInferenceInput = {
  pipelineStatus?: string;
  stageOutcomes?: Array<{
    stage: string;
    status: "failed" | "started" | "succeeded";
  }>;
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
};

/**
 * Builds one durable benchmark result from the process lifecycle and the
 * authoritative full-pipeline result, when one was written.
 */
export function buildBenchmarkResult(
  input: BenchmarkResultBuildInput,
): BenchmarkResult {
  const terminalResult = input.fullPipelineResult;
  const terminalInfrastructureFailureKind =
    terminalResult?.failure?.failureKind === "dependency-install-sigkill"
      ? terminalResult.failure.failureKind
      : undefined;
  const disposition =
    terminalResult === undefined ||
    terminalResult.status === "cancelled" ||
    terminalInfrastructureFailureKind !== undefined
      ? "inconclusive"
      : "completed";
  const status =
    terminalResult?.status === "succeeded" ? "succeeded" : "failed";
  const latestStage =
    input.fullPipelineLog.latestStage ??
    input.fullPipelineLog.stageOutcomes?.at(-1)?.stage;
  const failureStage =
    disposition === "inconclusive"
      ? latestStage
      : terminalResult?.status === "succeeded"
        ? undefined
        : failureStageForTerminalStatus(terminalResult?.status);
  const infrastructureFailureKind =
    disposition === "completed"
      ? undefined
      : terminalInfrastructureFailureKind !== undefined
        ? terminalInfrastructureFailureKind
        : terminalResult?.status === "cancelled"
          ? terminalResult.cancellationReason === "deadline-exceeded"
            ? "pipeline-deadline-exceeded"
            : "pipeline-cancelled"
          : input.lifecycle.terminationReason === undefined
            ? "terminal-result-unavailable"
            : "process-terminated";
  const stageOutcomes = input.fullPipelineLog.stageOutcomes ?? [];

  return {
    benchmarkRunId: input.benchmarkRunId,
    benchmarkTimeoutMs: input.benchmarkTimeoutMs,
    command: input.command,
    commitSha: input.commitSha,
    disposition,
    durationMs: input.durationMs,
    endedAt: input.endedAt,
    expectedLevel: input.expectedLevel,
    exitCode: input.lifecycle.exitCode,
    ...(failureStage === undefined ? {} : { failureStage }),
    ...(terminalResult?.failure?.blockers?.[0] === undefined
      ? {}
      : { failureMessage: terminalResult.failure.blockers[0] }),
    ...(infrastructureFailureKind === undefined
      ? {}
      : { infrastructureFailureKind }),
    ...(terminalResult?.artifacts?.logPath === undefined
      ? {}
      : { logPath: terminalResult.artifacts.logPath }),
    repoId: input.repoId,
    repoUrl: input.repoUrl,
    ...(terminalResult === undefined
      ? {}
      : { resultPath: terminalResult.resultPath }),
    runDirectory: input.runDirectory,
    startedAt: input.startedAt,
    status,
    statusLevel: inferBenchmarkStatusLevel({
      ...(terminalResult === undefined
        ? {}
        : { pipelineStatus: terminalResult.status }),
      stageOutcomes:
        terminalResult === undefined || terminalResult.status === "cancelled"
          ? stageOutcomes.filter((outcome) => outcome.status !== "failed")
          : stageOutcomes,
      succeededEvents: input.fullPipelineLog.succeededEvents ?? [],
    }),
    stderrPath: input.stderrPath,
    stdoutPath: input.stdoutPath,
    tokenUsage: null,
    ...(input.lifecycle.terminationReason === undefined
      ? {}
      : { terminationReason: input.lifecycle.terminationReason }),
  };
}

export function findFullPipelineResultPath(input: {
  stderr: string;
  stdout: string;
}): string | undefined {
  return [input.stdout, input.stderr]
    .flatMap((output) => output.split("\n"))
    .find((line) => line.startsWith("Result JSON: "))
    ?.replace("Result JSON: ", "")
    .trim();
}

/**
 * Reads only terminal full-pipeline summaries emitted inside this benchmark
 * run's pipeline output root. Marker text or a status field alone is not
 * sufficient evidence that a Pipeline Job completed.
 */
export function readBenchmarkTerminalPipelineResult(input: {
  pipelineOutputRoot: string;
  resultPath: string;
  value: unknown;
}): BenchmarkTerminalPipelineResult | undefined {
  if (!isBenchmarkTerminalResultPath(input)) return undefined;
  if (!isRecord(input.value)) return undefined;

  const result = input.value;
  const owningRunDirectory = dirname(resolve(input.resultPath));
  if (
    result.runId !== basename(owningRunDirectory) ||
    typeof result.runDirectory !== "string" ||
    resolve(result.runDirectory) !== owningRunDirectory
  ) {
    return undefined;
  }
  if (result.status === "succeeded") {
    if (!isSuccessSummary(result)) return undefined;
    return {
      artifacts: { logPath: result.artifacts.logPath },
      resultPath: input.resultPath,
      status: "succeeded",
    };
  }

  if (
    result.status !== "capture-path-validation-failed" &&
    result.status !== "preparation-failed" &&
    result.status !== "security-rejected" &&
    result.status !== "cancelled"
  ) {
    return undefined;
  }
  if (!isFailureSummary(result)) return undefined;
  if (result.status === "cancelled") {
    const cancellation = result.cancellation;
    if (
      !isRecord(cancellation) ||
      (cancellation.reason !== "deadline-exceeded" &&
        cancellation.reason !== "signal")
    ) {
      return undefined;
    }
    return {
      artifacts: { logPath: result.artifacts.logPath },
      cancellationReason: cancellation.reason,
      failure: { blockers: result.failure.blockers },
      resultPath: input.resultPath,
      status: "cancelled",
    };
  }
  return {
    artifacts: { logPath: result.artifacts.logPath },
    failure: { blockers: result.failure.blockers },
    resultPath: input.resultPath,
    status: result.status,
  };
}

export function inferBenchmarkStatusLevel(
  input: BenchmarkStatusInferenceInput,
): BenchmarkStatusLevel {
  switch (input.pipelineStatus) {
    case "succeeded":
      return "L5";
    case "capture-path-validation-failed":
      return "L3";
    case "preparation-failed":
    case "validation-failed":
      return "L1";
    case "security-rejected":
      return "L0";
  }

  const succeededEvents = new Set(input.succeededEvents ?? []);
  const succeededStages = new Set(
    (input.stageOutcomes ?? [])
      .filter((outcome) => outcome.status === "succeeded")
      .map((outcome) => outcome.stage),
  );
  const failedStages = new Set(
    (input.stageOutcomes ?? [])
      .filter((outcome) => outcome.status === "failed")
      .map((outcome) => outcome.stage),
  );

  if (succeededEvents.has("compositing-succeeded")) {
    return "L5";
  }
  if (
    succeededEvents.has("capture-succeeded") ||
    succeededStages.has("capture-path-validation")
  ) {
    return "L4";
  }
  if (succeededStages.has("script-generation")) {
    return "L3";
  }
  if (succeededStages.has("repo-preparation")) {
    return "L2";
  }
  if (failedStages.has("repo-preparation")) {
    return "L1";
  }
  return "L0";
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

export function isBenchmarkTerminalResultPath(input: {
  pipelineOutputRoot: string;
  resultPath: string;
}) {
  const pathFromOutputRoot = relative(
    resolve(input.pipelineOutputRoot),
    resolve(input.resultPath),
  );
  const pathParts = pathFromOutputRoot.split(sep);
  return (
    pathParts.length === 2 &&
    (pathParts[0]?.length ?? 0) > "full-pipeline-".length &&
    pathParts[0]?.startsWith("full-pipeline-") === true &&
    pathParts[1] === "full-pipeline-result.json"
  );
}

function isSuccessSummary(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  artifacts: { logPath: string };
} {
  return (
    isRecord(value.artifacts) &&
    hasStringFields(value.artifacts, [
      "captureManifestPath",
      "compositeManifestPath",
      "finalVideoPath",
      "logPath",
      "renderPlanPath",
      "viewUrl",
    ]) &&
    isDraftCompositeReviewSummary(value.draftCompositeReview) &&
    hasStringFields(value, ["runDirectory", "runId"]) &&
    isRecord(value.script) &&
    typeof value.script.sceneCount === "number" &&
    hasStringFields(value.script, ["scriptId", "title"])
  );
}

function isDraftCompositeReviewSummary(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.attempts === "number" &&
    isStringArray(value.findings) &&
    (value.status === "accepted" || value.status === "exhausted") &&
    isStringArray(value.warnings)
  );
}

function isFailureSummary(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  artifacts: { logPath: string };
  failure: { blockers: string[] };
} {
  return (
    isRecord(value.artifacts) &&
    hasStringFields(value.artifacts, ["logPath"]) &&
    isRecord(value.failure) &&
    isStringArray(value.failure.blockers) &&
    isStringArray(value.failure.suggestedChanges) &&
    hasStringFields(value, ["runDirectory", "runId"])
  );
}

function hasStringFields(value: Record<string, unknown>, fields: string[]) {
  return fields.every((field) => typeof value[field] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function failureStageForTerminalStatus(
  status: BenchmarkTerminalPipelineResult["status"] | undefined,
) {
  switch (status) {
    case "capture-path-validation-failed":
      return "capture-path-validation";
    case "preparation-failed":
      return "repo-preparation";
    case "security-rejected":
      return "repo-security-screen";
    case "cancelled":
    case "succeeded":
    case undefined:
      return undefined;
  }
}
