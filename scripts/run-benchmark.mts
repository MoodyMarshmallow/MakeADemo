import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createBenchmarkAdmissionGate } from "../src/server/shared/benchmark/benchmark-admission-gate";
import { parseBenchmarkCommandArgs } from "../src/server/shared/benchmark/benchmark-command";
import { createBenchmarkControlDecisionRecorder } from "../src/server/shared/benchmark/benchmark-control-decisions";
import type { BenchmarkControlEvent } from "../src/server/shared/benchmark/benchmark-control-events.schema";
import type { BenchmarkRepo } from "../src/server/shared/benchmark/benchmark-manifest";
import { redactBenchmarkOutput } from "../src/server/shared/benchmark/benchmark-output-redaction";
import { prepareBenchmarkProcessStart } from "../src/server/shared/benchmark/benchmark-pre-spawn";
import {
  createBenchmarkProcessController,
  parseBenchmarkTimeout,
  runBenchmarkProcess,
} from "../src/server/shared/benchmark/benchmark-process-lifecycle";
import {
  type BenchmarkResult,
  type BenchmarkTerminalPipelineResult,
  buildBenchmarkResult,
  findFullPipelineResultPath,
  isBenchmarkTerminalResultPath,
  readBenchmarkTerminalPipelineResult,
  summarizeBenchmarkResults,
} from "../src/server/shared/benchmark/benchmark-results";
import { runBenchmarkJobs } from "../src/server/shared/benchmark/benchmark-runner";
import {
  benchmarkRepos,
  benchmarkSuite,
  buildBenchmarkPipelineArgs,
  selectBenchmarkRepos,
} from "../src/server/shared/benchmark/benchmark-suite";

const { concurrency, repoIds } = parseBenchmarkCommandArgs(
  process.argv.slice(2),
);
const selectedBenchmarkRepos = selectBenchmarkRepos({
  repoIds,
  repos: benchmarkRepos,
});
const selectedBenchmarkSuite = {
  ...benchmarkSuite,
  repos: selectedBenchmarkRepos,
  sandboxProvider: "daytona" as const,
};
const benchmarkRunId = createRunId();
const outputRoot = join(".makeademo-benchmark-runs", benchmarkRunId);
const resultsPath = join(outputRoot, "benchmark-results.jsonl");
const controlEventsPath = join(outputRoot, "benchmark-control-events.jsonl");
const benchmarkTimeoutMs = parseBenchmarkTimeout(
  process.env.MAKEADEMO_BENCHMARK_TIMEOUT_MS,
);
const benchmarkJobCount = selectedBenchmarkRepos.reduce(
  (count, repo) => count + repo.effectiveRepetitions,
  0,
);
const benchmarkWorkerCount = concurrency ?? benchmarkJobCount;
const admissionPauseAllowanceMs = 300_000;
// Every admitted Pipeline Job receives its own full budget. The suite watchdog
// spans the maximum number of worker waves and one bounded cooldown allowance.
const suiteDeadlineAt =
  Date.now() +
  benchmarkTimeoutMs * Math.ceil(benchmarkJobCount / benchmarkWorkerCount) +
  admissionPauseAllowanceMs;
const processController = createBenchmarkProcessController();
const admissionGate = createBenchmarkAdmissionGate({
  maxAdmissionPauseMs: admissionPauseAllowanceMs,
});
const controlDecisionRecorder = createBenchmarkControlDecisionRecorder({
  admissionGate,
  warn: (error) => {
    process.stderr.write(
      `[benchmark] control-event artifact degraded: ${readErrorMessage(error)}\n`,
    );
  },
  write: (decision) => appendJsonLine(controlEventsPath, decision),
});
const benchmarkCancellation = new AbortController();
const pipelineDeadlineReserveMs = 60_000;
let interrupted = false;
const handleSignal = (signal: NodeJS.Signals) => {
  interrupted = true;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  benchmarkCancellation.abort(new Error(`Benchmark received ${signal}.`));
  void processController.cancelAll("signal");
};
process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

await mkdir(outputRoot, { recursive: true });
await writeFile(
  join(outputRoot, "benchmark-manifest.snapshot.json"),
  `${JSON.stringify(selectedBenchmarkSuite, null, 2)}\n`,
);

process.stdout.write(`Benchmark run: ${benchmarkRunId}\n`);
process.stdout.write(
  `Repos: ${selectedBenchmarkRepos.map((repo) => repo.id).join(", ")}\n`,
);
process.stdout.write(`Output root: ${outputRoot}\n`);
process.stdout.write(`Results: ${resultsPath}\n`);
process.stdout.write(`Control decisions: ${controlEventsPath}\n`);

let pendingResultWrite = Promise.resolve();
let results: BenchmarkResult[];
try {
  results = await runBenchmarkJobs({
    ...(concurrency === undefined ? {} : { concurrency }),
    admissionGate,
    benchmarkTimeoutMs,
    repos: selectedBenchmarkRepos,
    deadlineAt: suiteDeadlineAt,
    signal: benchmarkCancellation.signal,
    onAdmissionPauseExhausted: ({ error, repetitionIndex, repo }) => {
      controlDecisionRecorder.recordAdmissionPauseExhausted(error, {
        repetitionIndex,
        repoId: repo.id,
      });
    },
    onTerminalResult: ({ admission, decision, repetitionIndex, repo }) => {
      if (decision === undefined) return;
      controlDecisionRecorder.recordCircuitDecision(
        decision,
        {
          repetitionIndex,
          repoId: repo.id,
        },
        admission,
      );
    },
    run: async ({ admission, repo, repetitionIndex, deadlineAt }) => {
      if (admission?.kind === "probe") {
        controlDecisionRecorder.recordCircuitDecision(
          admissionGate.recordProbeAdmission(admission),
          { repetitionIndex, repoId: repo.id },
          admission,
        );
      }
      const result = await runRepoBenchmark({
        benchmarkRunId,
        benchmarkTimeoutMs,
        outputRoot,
        repo,
        repetitionIndex,
        sandboxProvider: "daytona",
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        onControlEvent: (event) => {
          if (event.type === "benchmark.daytona-provisioning-succeeded") {
            controlDecisionRecorder.recordProvisioningSucceeded(admission, {
              repetitionIndex,
              repoId: repo.id,
            });
            return;
          }
          const decision = controlDecisionRecorder.record(event, {
            repetitionIndex,
            repoId: repo.id,
          });
          if (decision.extended) {
            process.stderr.write(
              `[benchmark] provider cooldown extended to ${new Date(decision.cooldownUntil).toISOString()} (${decision.requestedDelayMs}ms requested).\n`,
            );
          }
        },
        signal: benchmarkCancellation.signal,
      });
      pendingResultWrite = pendingResultWrite.then(() =>
        appendJsonLine(resultsPath, result),
      );
      await pendingResultWrite;
      return result;
    },
  });
} catch (error) {
  if (!interrupted) throw error;
  results = [];
} finally {
  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);
  await processController.cancelAll();
  await controlDecisionRecorder.finalize();
}

if (!interrupted) {
  process.stdout.write("\nBenchmark complete.\n");
  printSummary(results);
}

async function runRepoBenchmark(input: {
  benchmarkRunId: string;
  benchmarkTimeoutMs: number;
  outputRoot: string;
  repo: BenchmarkRepo;
  repetitionIndex: number;
  sandboxProvider: "daytona";
  deadlineAt?: number;
  onControlEvent: (event: BenchmarkControlEvent) => void;
  signal: AbortSignal;
}): Promise<BenchmarkResult> {
  const runName = `${input.repo.id}-r${input.repetitionIndex + 1}`;
  const runDirectory = join(input.outputRoot, runName);
  const stdoutPath = join(runDirectory, "stdout.log");
  const stderrPath = join(runDirectory, "stderr.log");
  const pipelineOutputRoot = join(runDirectory, "pipeline");
  const args = buildBenchmarkPipelineArgs({
    deadlineAt: Math.max(
      Date.now(),
      (input.deadlineAt ?? Date.now() + input.benchmarkTimeoutMs) -
        pipelineDeadlineReserveMs,
    ),
    outputRoot: pipelineOutputRoot,
    repo: input.repo,
    sandboxProvider: input.sandboxProvider,
  });
  const command = ["bun", ...args];
  let startedAt: Date | undefined;
  const lifecycle = await prepareBenchmarkProcessStart({
    setup: async () => {
      await mkdir(runDirectory, { recursive: true });
    },
    signal: input.signal,
    start: () => {
      startedAt = new Date();
      process.stdout.write(
        `\n[${input.repo.id}] run ${input.repetitionIndex + 1}/${input.repo.effectiveRepetitions}\n`,
      );
      process.stdout.write(`$ ${command.join(" ")}\n`);
      return runBenchmarkProcess({
        args,
        stderrPath,
        stdoutPath,
        deadlineAt: input.deadlineAt ?? Date.now() + input.benchmarkTimeoutMs,
        controller: processController,
        env: {
          ...process.env,
          MAKEADEMO_BENCHMARK_CONTROL_FD: "3",
        },
        onControlEvent: input.onControlEvent,
        signal: input.signal,
      });
    },
  });
  if (startedAt === undefined) {
    throw new Error("Benchmark child started without a timestamp.");
  }
  await Promise.all([
    redactBenchmarkLog(stdoutPath),
    redactBenchmarkLog(stderrPath),
  ]);
  const fullPipelineResult = await readFullPipelineResult({
    pipelineOutputRoot,
    stderrPath,
    stdoutPath,
  });
  const pipelineLogPath =
    fullPipelineResult?.artifacts?.logPath ??
    (await findPipelineLogPath(pipelineOutputRoot));
  const fullPipelineLog = await readFullPipelineLog(pipelineLogPath);
  const endedAt = new Date();
  const result = buildBenchmarkResult({
    benchmarkRunId: input.benchmarkRunId,
    benchmarkTimeoutMs: input.benchmarkTimeoutMs,
    commitSha: input.repo.commitSha,
    command,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    endedAt: endedAt.toISOString(),
    expectedLevel: input.repo.expectedLevel,
    fullPipelineLog,
    ...(fullPipelineResult === undefined ? {} : { fullPipelineResult }),
    lifecycle,
    repoId: input.repo.id,
    repoUrl: input.repo.repoUrl,
    runDirectory,
    sandboxProvider: input.sandboxProvider,
    startedAt: startedAt.toISOString(),
    stderrPath,
    stdoutPath,
  });

  process.stdout.write(
    `[${input.repo.id}] ${result.status} ${result.statusLevel} in ${formatDuration(result.durationMs)}\n`,
  );
  return result;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function redactBenchmarkLog(path: string) {
  const output = await readFile(path, "utf8");
  const redacted = redactBenchmarkOutput(output);
  if (redacted !== output) {
    await writeFile(path, redacted);
  }
}

async function readFullPipelineResult(input: {
  pipelineOutputRoot: string;
  stderrPath: string;
  stdoutPath: string;
}): Promise<BenchmarkTerminalPipelineResult | undefined> {
  const [stderr, stdout] = await Promise.all([
    readFile(input.stderrPath, "utf8"),
    readFile(input.stdoutPath, "utf8"),
  ]);
  const resultPath = findFullPipelineResultPath({ stderr, stdout });
  if (resultPath === undefined) {
    return undefined;
  }
  if (
    !isBenchmarkTerminalResultPath({
      pipelineOutputRoot: input.pipelineOutputRoot,
      resultPath,
    })
  ) {
    return undefined;
  }

  try {
    const result = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
    return readBenchmarkTerminalPipelineResult({
      pipelineOutputRoot: input.pipelineOutputRoot,
      resultPath,
      value: result,
    });
  } catch {
    return undefined;
  }
}

async function readFullPipelineLog(logPath: string | undefined): Promise<{
  failureStage?: string;
  latestStage?: string;
  stageOutcomes: Array<{
    stage: string;
    status: "failed" | "started" | "succeeded";
  }>;
  succeededEvents: string[];
}> {
  if (logPath === undefined) {
    return {
      stageOutcomes: [] as Array<{
        stage: string;
        status: "failed" | "started" | "succeeded";
      }>,
      succeededEvents: [] as string[],
    };
  }

  let contents: string;
  try {
    contents = await readFile(logPath, "utf8");
  } catch {
    return {
      stageOutcomes: [] as Array<{
        stage: string;
        status: "failed" | "started" | "succeeded";
      }>,
      succeededEvents: [] as string[],
    };
  }
  const lines = contents.split("\n").filter((line) => line.trim().length > 0);
  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const succeededEvents = events
    .map((event) => event.event)
    .filter((event): event is string => typeof event === "string");
  const stageOutcomes: Array<{
    stage: string;
    status: "failed" | "started" | "succeeded";
  }> = events.flatMap((event) => {
    if (
      event.event !== "stage-progress" ||
      typeof event.stage !== "string" ||
      (event.status !== "failed" &&
        event.status !== "started" &&
        event.status !== "succeeded")
    ) {
      return [];
    }

    return [{ stage: event.stage, status: event.status }];
  });
  const failedEvent = events.find((event) =>
    typeof event.event === "string" ? event.event.endsWith("failed") : false,
  );
  const failedStage = stageOutcomes
    .slice()
    .reverse()
    .find((outcome) => outcome.status === "failed")?.stage;
  const latestStage = stageOutcomes.at(-1)?.stage;

  return {
    ...(typeof failedEvent?.stage === "string"
      ? { failureStage: failedEvent.stage }
      : failedStage === undefined
        ? {}
        : { failureStage: failedStage }),
    stageOutcomes,
    succeededEvents,
    ...(latestStage === undefined ? {} : { latestStage }),
  };
}

async function findPipelineLogPath(
  pipelineOutputRoot: string,
): Promise<string | undefined> {
  try {
    const paths = await readdir(pipelineOutputRoot, { recursive: true });
    return paths
      .filter((path) => path.endsWith("pipeline-log.jsonl"))
      .sort()
      .map((path) => join(pipelineOutputRoot, path))
      .at(-1);
  } catch {
    return undefined;
  }
}

async function appendJsonLine(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "a" });
}

function createRunId() {
  return `benchmark-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

function formatDuration(durationMs: number) {
  return `${Math.round(durationMs / 1000)}s`;
}

function printSummary(results: BenchmarkResult[]) {
  const summary = summarizeBenchmarkResults(results);
  process.stdout.write("Individual durations:\n");
  for (const run of summary.runDurations) {
    process.stdout.write(
      `  ${run.repoId}: ${formatDuration(run.durationMs)}\n`,
    );
  }
  process.stdout.write(
    `Average duration: ${formatOptionalDuration(summary.averageDurationMs)}\n`,
  );
  process.stdout.write(
    `Median duration: ${formatOptionalDuration(summary.medianDurationMs)}\n`,
  );
  process.stdout.write(
    `Max duration: ${formatOptionalDuration(summary.maxDurationMs)}\n`,
  );
}

function formatOptionalDuration(durationMs: number | null) {
  return durationMs === null ? "n/a" : formatDuration(durationMs);
}
