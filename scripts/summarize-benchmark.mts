import { readFile } from "node:fs/promises";

import {
  type BenchmarkResult,
  summarizeBenchmarkResults,
} from "../src/server/shared/benchmark/benchmark-results";

const resultsPath = process.argv[2];
if (resultsPath === undefined) {
  throw new Error(
    "Usage: bun scripts/summarize-benchmark.mts <benchmark-results.jsonl>",
  );
}

const results = (await readFile(resultsPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as BenchmarkResult);
const summary = summarizeBenchmarkResults(results);

process.stdout.write(`Benchmark results: ${resultsPath}\n`);
process.stdout.write(`Runs: ${summary.repoCount}\n`);
process.stdout.write(`Succeeded: ${summary.successCount}\n`);
process.stdout.write("Individual durations:\n");
for (const run of summary.runDurations) {
  process.stdout.write(`  ${run.repoId}: ${formatDuration(run.durationMs)}\n`);
}
process.stdout.write(
  `Average duration: ${formatDuration(summary.averageDurationMs)}\n`,
);
process.stdout.write(
  `Median duration: ${formatDuration(summary.medianDurationMs)}\n`,
);
process.stdout.write(
  `Max duration: ${formatDuration(summary.maxDurationMs)}\n`,
);
process.stdout.write("\nStatus levels:\n");
for (const [level, count] of Object.entries(summary.levelCounts).sort()) {
  process.stdout.write(`  ${level}: ${count}\n`);
}

process.stdout.write("\nFailure stages:\n");
const failureEntries = Object.entries(summary.failureStageCounts).sort();
if (failureEntries.length === 0) {
  process.stdout.write("  none\n");
} else {
  for (const [stage, count] of failureEntries) {
    process.stdout.write(`  ${stage}: ${count}\n`);
  }
}

process.stdout.write("\nToken usage:\n");
if (summary.tokenUsage.measuredRunCount === 0) {
  process.stdout.write("  not instrumented yet\n");
} else {
  process.stdout.write(
    `  measured runs: ${summary.tokenUsage.measuredRunCount}\n`,
  );
  process.stdout.write(`  prompt: ${summary.tokenUsage.totalPromptTokens}\n`);
  process.stdout.write(
    `  completion: ${summary.tokenUsage.totalCompletionTokens}\n`,
  );
  process.stdout.write(`  total: ${summary.tokenUsage.totalTokens}\n`);
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null) {
    return "n/a";
  }

  return `${Math.round(durationMs / 1000)}s`;
}
