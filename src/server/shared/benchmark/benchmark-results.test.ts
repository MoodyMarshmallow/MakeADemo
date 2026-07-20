import { describe, expect, it } from "vitest";

import {
  buildBenchmarkResult,
  findFullPipelineResultPath,
  inferBenchmarkStatusLevel,
  readBenchmarkTerminalPipelineResult,
  summarizeBenchmarkResults,
} from "./benchmark-results";

describe("findFullPipelineResultPath", () => {
  it("finds failed full-pipeline result metadata written to stderr", () => {
    expect(
      findFullPipelineResultPath({
        stderr:
          "Pipeline failed\nResult JSON: /runs/full-pipeline-result.json\n",
        stdout: "",
      }),
    ).toBe("/runs/full-pipeline-result.json");
  });
});

describe("readBenchmarkTerminalPipelineResult", () => {
  const pipelineOutputRoot = "/runs/ghost/pipeline";
  const resultPath =
    "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z/full-pipeline-result.json";

  it("rejects a status-only terminal result", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: { status: "succeeded" },
      }),
    ).toBeUndefined();
  });

  it("rejects a truncated success summary", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          artifacts: { logPath: "/runs/pipeline-log.jsonl" },
          runDirectory: "/runs/full-pipeline-2026-07-20T00-00-00-000Z",
          runId: "full-pipeline-2026-07-20T00-00-00-000Z",
          status: "succeeded",
        },
      }),
    ).toBeUndefined();
  });

  it("rejects a valid-shaped terminal result outside the benchmark run", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath: "/tmp/full-pipeline-result.json",
        value: successfulTerminalSummary(),
      }),
    ).toBeUndefined();
  });

  it("accepts the real full-pipeline success and failure summaries from the run output", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: successfulTerminalSummary(),
      }),
    ).toMatchObject({ resultPath, status: "succeeded" });
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: failedTerminalSummary(),
      }),
    ).toMatchObject({ resultPath, status: "preparation-failed" });
  });
});

describe("inferBenchmarkStatusLevel", () => {
  it("maps whole-pipeline outcomes to benchmark status levels", () => {
    expect(
      inferBenchmarkStatusLevel({ pipelineStatus: "security-rejected" }),
    ).toBe("L0");
    expect(
      inferBenchmarkStatusLevel({ pipelineStatus: "preparation-failed" }),
    ).toBe("L1");
    expect(
      inferBenchmarkStatusLevel({
        stageOutcomes: [{ stage: "repo-preparation", status: "failed" }],
      }),
    ).toBe("L1");
    expect(
      inferBenchmarkStatusLevel({
        stageOutcomes: [
          { stage: "repo-preparation", status: "succeeded" },
          { stage: "script-generation", status: "failed" },
        ],
      }),
    ).toBe("L2");
    expect(
      inferBenchmarkStatusLevel({
        pipelineStatus: "capture-path-validation-failed",
        stageOutcomes: [
          { stage: "repo-preparation", status: "succeeded" },
          { stage: "script-generation", status: "succeeded" },
          { stage: "capture-path-validation", status: "failed" },
        ],
      }),
    ).toBe("L3");
    expect(
      inferBenchmarkStatusLevel({
        stageOutcomes: [
          { stage: "repo-preparation", status: "succeeded" },
          { stage: "script-generation", status: "succeeded" },
          { stage: "capture-path-validation", status: "succeeded" },
        ],
      }),
    ).toBe("L4");
    expect(inferBenchmarkStatusLevel({ pipelineStatus: "succeeded" })).toBe(
      "L5",
    );
    expect(
      inferBenchmarkStatusLevel({
        succeededEvents: ["capture-succeeded"],
      }),
    ).toBe("L4");
    expect(
      inferBenchmarkStatusLevel({
        pipelineStatus: "succeeded",
        succeededEvents: ["capture-succeeded", "compositing-succeeded"],
      }),
    ).toBe("L5");
  });
});

describe("buildBenchmarkResult", () => {
  it("marks a terminated run without a terminal result inconclusive at its latest started stage", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 960_000,
        endedAt: "2026-07-20T00:16:00.000Z",
        expectedLevel: "L5",
        fullPipelineLog: {
          stageOutcomes: [
            { stage: "repo-security-screen", status: "succeeded" },
            { stage: "repo-preparation", status: "started" },
          ],
          succeededEvents: [],
        },
        lifecycle: {
          exitCode: null,
          killed: true,
          terminationReason: "deadline",
        },
        repoId: "ghost",
        repoUrl: "https://github.com/TryGhost/Ghost",
        runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({
      benchmarkTimeoutMs: 960_000,
      disposition: "inconclusive",
      failureStage: "repo-preparation",
      infrastructureFailureKind: "process-terminated",
      status: "failed",
      statusLevel: "L0",
      terminationReason: "deadline",
    });
  });

  it("does not treat an inconclusive Repo Preparation failure event as an L1 achievement", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 960_000,
        endedAt: "2026-07-20T00:16:00.000Z",
        expectedLevel: "L5",
        fullPipelineLog: {
          stageOutcomes: [
            { stage: "repo-preparation", status: "started" },
            { stage: "repo-preparation", status: "failed" },
          ],
          succeededEvents: [],
        },
        lifecycle: {
          exitCode: null,
          killed: true,
          terminationReason: "deadline",
        },
        repoId: "ghost",
        repoUrl: "https://github.com/TryGhost/Ghost",
        runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({
      disposition: "inconclusive",
      failureStage: "repo-preparation",
      statusLevel: "L0",
    });
  });

  it("keeps a readable successful terminal result completed after result grace", () => {
    const result = buildBenchmarkResult({
      benchmarkRunId: "run-1",
      benchmarkTimeoutMs: 960_000,
      command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      durationMs: 1_000,
      endedAt: "2026-07-20T00:00:01.000Z",
      expectedLevel: "L5",
      fullPipelineLog: {
        failureStage: "repo-preparation",
        latestStage: "compositing",
        stageOutcomes: [
          { stage: "repo-preparation", status: "failed" },
          { stage: "compositing", status: "started" },
        ],
        succeededEvents: [],
      },
      fullPipelineResult: {
        resultPath: "/runs/full-pipeline-result.json",
        status: "succeeded",
      },
      lifecycle: {
        exitCode: null,
        killed: true,
        terminationReason: "result-grace",
      },
      repoId: "ghost",
      repoUrl: "https://github.com/TryGhost/Ghost",
      runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
      startedAt: "2026-07-20T00:00:00.000Z",
      stderrPath: "stderr.log",
      stdoutPath: "stdout.log",
    });

    expect(result).toMatchObject({
      disposition: "completed",
      status: "succeeded",
      statusLevel: "L5",
      terminationReason: "result-grace",
    });
    expect(result).not.toHaveProperty("failureStage");
    expect(result).not.toHaveProperty("infrastructureFailureKind");
  });

  it("keeps an authoritative Repo Preparation failure completed at L1", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 1_000,
        endedAt: "2026-07-20T00:00:01.000Z",
        expectedLevel: "L5",
        fullPipelineLog: {
          failureStage: "repo-preparation",
          stageOutcomes: [{ stage: "repo-preparation", status: "failed" }],
          succeededEvents: [],
        },
        fullPipelineResult: {
          resultPath: "/runs/full-pipeline-result.json",
          status: "preparation-failed",
        },
        lifecycle: { exitCode: 1, killed: false },
        repoId: "ghost",
        repoUrl: "https://github.com/TryGhost/Ghost",
        runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({
      disposition: "completed",
      failureStage: "repo-preparation",
      status: "failed",
      statusLevel: "L1",
    });
  });

  it("derives a completed failure stage from the authoritative terminal status", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 1_000,
        endedAt: "2026-07-20T00:00:01.000Z",
        expectedLevel: "L5",
        fullPipelineLog: {
          failureStage: "preparation-workspace-cleanup",
          latestStage: "preparation-workspace-cleanup",
          stageOutcomes: [
            { stage: "capture-path-validation", status: "started" },
            { stage: "preparation-workspace-cleanup", status: "failed" },
          ],
          succeededEvents: [],
        },
        fullPipelineResult: {
          resultPath: "/runs/full-pipeline-result.json",
          status: "capture-path-validation-failed",
        },
        lifecycle: { exitCode: 1, killed: false },
        repoId: "ghost",
        repoUrl: "https://github.com/TryGhost/Ghost",
        runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({
      disposition: "completed",
      failureStage: "capture-path-validation",
      statusLevel: "L3",
    });
  });

  it("does not let stale stage history raise an authoritative Repo Preparation failure", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 1_000,
        endedAt: "2026-07-20T00:00:01.000Z",
        expectedLevel: "L5",
        fullPipelineLog: {
          stageOutcomes: [
            { stage: "repo-preparation", status: "succeeded" },
            { stage: "script-generation", status: "succeeded" },
          ],
          succeededEvents: ["capture-succeeded"],
        },
        fullPipelineResult: {
          resultPath: "/runs/full-pipeline-result.json",
          status: "preparation-failed",
        },
        lifecycle: { exitCode: 1, killed: false },
        repoId: "ghost",
        repoUrl: "https://github.com/TryGhost/Ghost",
        runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({ statusLevel: "L1" });
  });

  it("does not trust a zero exit code without a terminal Pipeline result", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 1_000,
        endedAt: "2026-07-20T00:00:01.000Z",
        expectedLevel: "L5",
        fullPipelineLog: {
          stageOutcomes: [],
          succeededEvents: [],
        },
        lifecycle: { exitCode: 0, killed: false },
        repoId: "ghost",
        repoUrl: "https://github.com/TryGhost/Ghost",
        runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({
      disposition: "inconclusive",
      infrastructureFailureKind: "terminal-result-unavailable",
      status: "failed",
    });
  });
});

describe("summarizeBenchmarkResults", () => {
  it("summarizes success levels, runtime, tokens, and failure stages", () => {
    expect(
      summarizeBenchmarkResults([
        {
          benchmarkRunId: "run-1",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          durationMs: 1000,
          endedAt: "2026-06-15T00:00:01.000Z",
          expectedLevel: "L5",
          exitCode: 0,
          repoId: "one",
          repoUrl: "https://github.com/example/one",
          startedAt: "2026-06-15T00:00:00.000Z",
          status: "succeeded",
          statusLevel: "L5",
          tokenUsage: {
            completionTokens: 30,
            promptTokens: 70,
            totalTokens: 100,
          },
        },
        {
          benchmarkRunId: "run-1",
          commitSha: "89abcdef0123456789abcdef0123456789abcdef",
          durationMs: 3000,
          endedAt: "2026-06-15T00:00:04.000Z",
          expectedLevel: "L5",
          exitCode: 1,
          failureStage: "repo-preparation",
          repoId: "two",
          repoUrl: "https://github.com/example/two",
          startedAt: "2026-06-15T00:00:01.000Z",
          status: "failed",
          statusLevel: "L1",
          tokenUsage: null,
        },
      ]),
    ).toMatchObject({
      averageDurationMs: 2000,
      failureStageCounts: { "repo-preparation": 1 },
      levelCounts: { L1: 1, L5: 1 },
      medianDurationMs: 2000,
      repoCount: 2,
      runDurations: [
        { durationMs: 1000, repoId: "one" },
        { durationMs: 3000, repoId: "two" },
      ],
      successCount: 1,
      tokenUsage: {
        measuredRunCount: 1,
        totalTokens: 100,
      },
    });
    expect(summarizeBenchmarkResults([])).not.toHaveProperty(
      "verificationStatusCounts",
    );
  });
});

function successfulTerminalSummary() {
  return {
    artifacts: {
      captureManifestPath: "/runs/capture-manifest.json",
      compositeManifestPath: "/runs/composite-manifest.json",
      finalVideoPath: "/runs/final-video.mp4",
      logPath: "/runs/pipeline-log.jsonl",
      renderPlanPath: "/runs/render-plan.json",
      viewUrl: "https://example.com/video",
    },
    draftCompositeReview: {
      attempts: 1,
      findings: [],
      status: "accepted",
      warnings: [],
    },
    runDirectory: "/runs/full-pipeline-2026-07-20T00-00-00-000Z",
    runId: "full-pipeline-2026-07-20T00-00-00-000Z",
    script: { sceneCount: 1, scriptId: "script-1", title: "Demo" },
    status: "succeeded",
  };
}

function failedTerminalSummary() {
  return {
    artifacts: { logPath: "/runs/pipeline-log.jsonl" },
    failure: { blockers: ["Setup failed"], suggestedChanges: [] },
    runDirectory: "/runs/full-pipeline-2026-07-20T00-00-00-000Z",
    runId: "full-pipeline-2026-07-20T00-00-00-000Z",
    status: "preparation-failed",
  };
}
