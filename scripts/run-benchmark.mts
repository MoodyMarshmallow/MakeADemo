import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

import {
  type BenchmarkRepo,
  buildBenchmarkPipelineArgs,
  readBenchmarkManifest,
} from "../src/server/shared/benchmark/benchmark-manifest";
import { redactBenchmarkOutput } from "../src/server/shared/benchmark/benchmark-output-redaction";
import {
  type BenchmarkResult,
  inferBenchmarkStatusLevel,
} from "../src/server/shared/benchmark/benchmark-results";
import { runBenchmarkJobs } from "../src/server/shared/benchmark/benchmark-runner";

const manifestPath = process.argv[2];
if (manifestPath === undefined) {
  throw new Error("Usage: bun scripts/run-benchmark.mts <manifest.json>");
}

const manifest = readBenchmarkManifest(
  JSON.parse(await readFile(manifestPath, "utf8")),
);
const benchmarkRunId = createRunId();
const outputRoot =
  manifest.defaults.outputRoot ??
  join(".makeademo-benchmark-runs", benchmarkRunId);
const resultsPath = join(outputRoot, "benchmark-results.jsonl");

await mkdir(outputRoot, { recursive: true });
await writeFile(
  join(outputRoot, "benchmark-manifest.snapshot.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

process.stdout.write(`Benchmark run: ${benchmarkRunId}\n`);
process.stdout.write(`Output root: ${outputRoot}\n`);
process.stdout.write(`Results: ${resultsPath}\n`);

let pendingResultWrite = Promise.resolve();
await runBenchmarkJobs({
  repos: manifest.repos,
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
process.stdout.write(
  `Summarize with: bun scripts/summarize-benchmark.mts ${resultsPath}\n`,
);

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
    `\n[${input.repo.id}] run ${input.repetitionIndex + 1}/${input.repo.effectiveRepetitions}: ${input.repo.effectiveMode}\n`,
  );
  process.stdout.write(`$ ${command.join(" ")}\n`);

  const exitCode = await runCommand({
    args,
    stderrPath,
    stdoutPath,
  });
  const endedAt = new Date();
  const fullPipelineResult = await readFullPipelineResult(stdoutPath);
  const fullPipelineLog = await readFullPipelineLog(
    fullPipelineResult?.artifacts?.logPath,
  );
  const status = exitCode === 0 ? "succeeded" : "failed";
  const statusLevel = inferBenchmarkStatusLevel(
    fullPipelineResult?.status === undefined
      ? {
          exitCode,
          mode: input.repo.effectiveMode,
          succeededEvents: fullPipelineLog.succeededEvents,
        }
      : {
          exitCode,
          mode: input.repo.effectiveMode,
          pipelineStatus: fullPipelineResult.status,
          succeededEvents: fullPipelineLog.succeededEvents,
        },
  );

  const result: BenchmarkResult = {
    benchmarkRunId: input.benchmarkRunId,
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
    mode: input.repo.effectiveMode,
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
  };

  process.stdout.write(
    `[${input.repo.id}] ${status} ${statusLevel} in ${formatDuration(result.durationMs)}\n`,
  );
  return result;
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

async function readFullPipelineResult(stdoutPath: string): Promise<
  | {
      artifacts?: { logPath?: string };
      failure?: { blockers?: string[] };
      resultPath?: string;
      status?: string;
    }
  | undefined
> {
  const stdout = await readFile(stdoutPath, "utf8");
  const resultPath = stdout
    .split("\n")
    .find((line) => line.startsWith("Result JSON: "))
    ?.replace("Result JSON: ", "")
    .trim();
  if (resultPath === undefined) {
    return undefined;
  }

  const result = JSON.parse(await readFile(resultPath, "utf8")) as {
    artifacts?: { logPath?: string };
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
