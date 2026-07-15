import { describe, expect, it } from "vitest";

import {
  findFullPipelineResultPath,
  inferBenchmarkStatusLevel,
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

describe("inferBenchmarkStatusLevel", () => {
  it("maps whole-pipeline outcomes to benchmark status levels", () => {
    expect(
      inferBenchmarkStatusLevel({ pipelineStatus: "security-rejected" }),
    ).toBe("L0");
    expect(
      inferBenchmarkStatusLevel({ pipelineStatus: "preparation-failed" }),
    ).toBe("L0");
    expect(
      inferBenchmarkStatusLevel({ pipelineStatus: "validation-failed" }),
    ).toBe("L1");
    expect(inferBenchmarkStatusLevel({ pipelineStatus: "succeeded" })).toBe(
      "L5",
    );
    expect(
      inferBenchmarkStatusLevel({
        pipelineStatus: "succeeded",
        succeededEvents: ["capture-succeeded"],
      }),
    ).toBe("L4");
    expect(
      inferBenchmarkStatusLevel({
        pipelineStatus: "succeeded",
        succeededEvents: ["capture-succeeded", "compositing-succeeded"],
      }),
    ).toBe("L5");
    expect(
      inferBenchmarkStatusLevel({
        externalVerificationStatus: "verified",
        pipelineStatus: "succeeded",
        succeededEvents: ["capture-succeeded", "compositing-succeeded"],
      }),
    ).toBe("L6");
    expect(
      inferBenchmarkStatusLevel({
        externalVerificationStatus: "rejected",
        pipelineStatus: "succeeded",
        succeededEvents: ["capture-succeeded", "compositing-succeeded"],
      }),
    ).toBe("L5");
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
          verification: {
            artifactPath: "/runs/one/external-verification/codex-verdict.json",
            comparisons: [],
            mismatches: [],
            reason: "The evidence was insufficient.",
            status: "inconclusive",
            verifier: "external-codex",
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
          statusLevel: "L0",
          tokenUsage: null,
        },
      ]),
    ).toMatchObject({
      averageDurationMs: 2000,
      failureStageCounts: { "repo-preparation": 1 },
      levelCounts: { L0: 1, L5: 1 },
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
      verificationStatusCounts: { inconclusive: 1 },
    });
  });
});
