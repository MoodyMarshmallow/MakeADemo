import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

import { verifyCompletedBenchmarkDemo } from "../src/server/shared/benchmark/benchmark-demo-verification";
import type { BenchmarkRepo } from "../src/server/shared/benchmark/benchmark-manifest";
import { redactBenchmarkOutput } from "../src/server/shared/benchmark/benchmark-output-redaction";
import {
  type BenchmarkResult,
  findFullPipelineResultPath,
  inferBenchmarkStatusLevel,
  summarizeBenchmarkResults,
} from "../src/server/shared/benchmark/benchmark-results";
import { runBenchmarkJobs } from "../src/server/shared/benchmark/benchmark-runner";
import {
  benchmarkRepos,
  benchmarkSuite,
  buildBenchmarkPipelineArgs,
} from "../src/server/shared/benchmark/benchmark-suite";
import { verifyBenchmarkDemoWithCodex } from "../src/server/shared/benchmark/external-codex-benchmark-demo-verifier";

const benchmarkRunId = createRunId();
const outputRoot = join(".makeademo-benchmark-runs", benchmarkRunId);
const resultsPath = join(outputRoot, "benchmark-results.jsonl");

await mkdir(outputRoot, { recursive: true });
await writeFile(
  join(outputRoot, "benchmark-manifest.snapshot.json"),
  `${JSON.stringify(benchmarkSuite, null, 2)}\n`,
);

process.stdout.write(`Benchmark run: ${benchmarkRunId}\n`);
process.stdout.write(`Output root: ${outputRoot}\n`);
process.stdout.write(`Results: ${resultsPath}\n`);

let pendingResultWrite = Promise.resolve();
const results = await runBenchmarkJobs({
  repos: benchmarkRepos,
  run: async ({ repo, repetitionIndex }) => {
    const result = await runRepoBenchmark({
      benchmarkRunId,
      outputRoot,
      repo,
      repetitionIndex,
    });
    pendingResultWrite = pendingResultWrite.then(() =>
      appendJsonLine(resultsPath, result),
    );
    await pendingResultWrite;
    return result;
  },
});

process.stdout.write("\nBenchmark complete.\n");
printSummary(results);

async function runRepoBenchmark(input: {
  benchmarkRunId: string;
  outputRoot: string;
  repo: BenchmarkRepo;
  repetitionIndex: number;
}): Promise<BenchmarkResult> {
  const runName = `${input.repo.id}-r${input.repetitionIndex + 1}`;
  const runDirectory = join(input.outputRoot, runName);
  const stdoutPath = join(runDirectory, "stdout.log");
  const stderrPath = join(runDirectory, "stderr.log");
  const pipelineOutputRoot = join(runDirectory, "pipeline");
  await mkdir(runDirectory, { recursive: true });

  const args = buildBenchmarkPipelineArgs({
    outputRoot: pipelineOutputRoot,
    repo: input.repo,
  });
  const command = ["bun", ...args];
  const startedAt = new Date();
  process.stdout.write(
    `\n[${input.repo.id}] run ${input.repetitionIndex + 1}/${input.repo.effectiveRepetitions}\n`,
  );
  process.stdout.write(`$ ${command.join(" ")}\n`);

  const exitCode = await runCommand({
    args,
    stderrPath,
    stdoutPath,
  });
  const fullPipelineResult = await readFullPipelineResult({
    stderrPath,
    stdoutPath,
  });
  const fullPipelineLog = await readFullPipelineLog(
    fullPipelineResult?.artifacts?.logPath,
  );
  const status = exitCode === 0 ? "succeeded" : "failed";
  const verification = await runExternalVerification({
    fullPipelineResult,
    repo: input.repo,
    runDirectory,
    status,
  });
  const endedAt = new Date();
  const statusLevel = inferBenchmarkStatusLevel(
    fullPipelineResult?.status === undefined
      ? {
          ...(verification === undefined
            ? {}
            : { externalVerificationStatus: verification.status }),
          succeededEvents: fullPipelineLog.succeededEvents,
        }
      : {
          ...(verification === undefined
            ? {}
            : { externalVerificationStatus: verification.status }),
          pipelineStatus: fullPipelineResult.status,
          succeededEvents: fullPipelineLog.succeededEvents,
        },
  );

  const result: BenchmarkResult = {
    benchmarkRunId: input.benchmarkRunId,
    commitSha: input.repo.commitSha,
    command,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    endedAt: endedAt.toISOString(),
    expectedLevel: input.repo.expectedLevel,
    exitCode,
    ...(fullPipelineLog.failureStage === undefined
      ? {}
      : { failureStage: fullPipelineLog.failureStage }),
    ...(fullPipelineResult?.failure?.blockers?.[0] === undefined
      ? {}
      : { failureMessage: fullPipelineResult.failure.blockers[0] }),
    ...(fullPipelineResult?.artifacts?.logPath === undefined
      ? {}
      : { logPath: fullPipelineResult.artifacts.logPath }),
    repoId: input.repo.id,
    repoUrl: input.repo.repoUrl,
    ...(fullPipelineResult?.resultPath === undefined
      ? {}
      : { resultPath: fullPipelineResult.resultPath }),
    runDirectory,
    startedAt: startedAt.toISOString(),
    status,
    statusLevel,
    stderrPath,
    stdoutPath,
    tokenUsage: null,
    ...(verification === undefined ? {} : { verification }),
  };

  process.stdout.write(
    `[${input.repo.id}] ${status} ${statusLevel} in ${formatDuration(result.durationMs)}\n`,
  );
  return result;
}

async function runExternalVerification(input: {
  fullPipelineResult:
    | {
        artifacts?: {
          compositeManifestPath?: string;
          finalVideoPath?: string;
        };
        status?: string;
      }
    | undefined;
  repo: BenchmarkRepo;
  runDirectory: string;
  status: "failed" | "succeeded";
}) {
  if (
    input.status !== "succeeded" ||
    input.fullPipelineResult?.status !== "succeeded" ||
    input.fullPipelineResult.artifacts?.compositeManifestPath === undefined ||
    input.fullPipelineResult.artifacts.finalVideoPath === undefined
  ) {
    return undefined;
  }

  process.stdout.write(
    `[${input.repo.id}] external Codex verification starting\n`,
  );
  const verification = await verifyCompletedBenchmarkDemo({
    compositeManifestPath:
      input.fullPipelineResult.artifacts.compositeManifestPath,
    finalVideoPath: input.fullPipelineResult.artifacts.finalVideoPath,
    repo: input.repo,
    runDirectory: input.runDirectory,
    verifier: verifyBenchmarkDemoWithCodex,
  });
  process.stdout.write(
    `[${input.repo.id}] external Codex verification ${verification.status}: ${verification.reason}\n`,
  );
  return verification;
}

function runCommand(input: {
  args: string[];
  stderrPath: string;
  stdoutPath: string;
}): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", input.args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createWriteStream(input.stdoutPath);
    const stderr = createWriteStream(input.stderrPath);

    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);

    child.on("error", reject);
    child.on("close", async (code) => {
      try {
        await Promise.all([finished(stdout), finished(stderr)]);
        await Promise.all([
          redactBenchmarkLog(input.stdoutPath),
          redactBenchmarkLog(input.stderrPath),
        ]);
        resolve(code);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function redactBenchmarkLog(path: string) {
  const output = await readFile(path, "utf8");
  const redacted = redactBenchmarkOutput(output);
  if (redacted !== output) {
    await writeFile(path, redacted);
  }
}

async function readFullPipelineResult(input: {
  stderrPath: string;
  stdoutPath: string;
}): Promise<
  | {
      artifacts?: {
        compositeManifestPath?: string;
        finalVideoPath?: string;
        logPath?: string;
      };
      failure?: { blockers?: string[] };
      resultPath?: string;
      status?: string;
    }
  | undefined
> {
  const [stderr, stdout] = await Promise.all([
    readFile(input.stderrPath, "utf8"),
    readFile(input.stdoutPath, "utf8"),
  ]);
  const resultPath = findFullPipelineResultPath({ stderr, stdout });
  if (resultPath === undefined) {
    return undefined;
  }

  const result = JSON.parse(await readFile(resultPath, "utf8")) as {
    artifacts?: {
      compositeManifestPath?: string;
      finalVideoPath?: string;
      logPath?: string;
    };
    failure?: { blockers?: string[] };
    status?: string;
  };

  return { ...result, resultPath };
}

async function readFullPipelineLog(logPath: string | undefined) {
  if (logPath === undefined) {
    return { succeededEvents: [] as string[] };
  }

  const lines = (await readFile(logPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const events = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const succeededEvents = events
    .map((event) => event.event)
    .filter((event): event is string => typeof event === "string");
  const failedEvent = events.find((event) =>
    typeof event.event === "string" ? event.event.endsWith("failed") : false,
  );

  return {
    ...(typeof failedEvent?.stage === "string"
      ? { failureStage: failedEvent.stage }
      : {}),
    succeededEvents,
  };
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
