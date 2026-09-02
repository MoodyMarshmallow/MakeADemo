import { describe, expect, it } from "vitest";

import {
  type BenchmarkResultBuildInput,
  buildBenchmarkResult,
  findFullPipelineResultPath,
  inferBenchmarkStatusLevel,
  readBenchmarkTerminalPipelineResult,
  summarizeBenchmarkResults,
} from "./benchmark-results";
import { preparedApplicationIdentityEvaluationCases } from "./prepared-application-identity-evaluation-suite";

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

  it("rejects a result whose run identity does not own its containing directory", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          ...successfulTerminalSummary(),
          runId: "full-pipeline-some-other-run",
        },
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

  it("reads the real structured replacement decision from an identity-review terminal result", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          artifacts: { logPath: "/runs/pipeline-log.jsonl" },
          failure: {
            blockers: ["Prepared Application Identity Review failed."],
            identityReview: {
              explanation: "The prepared app is a replacement shell.",
              failureKind: "replacement-detected",
              mockedBoundaries: [],
              nativeSurfacesRendered: [],
              replacementEvidence: ["prepared:diff"],
              sourceCitations: [],
              status: "succeeded",
              verdict: "fail",
            },
            suggestedChanges: [],
          },
          runDirectory:
            "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
          runId: "full-pipeline-2026-07-20T00-00-00-000Z",
          status: "identity-review-failed",
        },
      }),
    ).toMatchObject({
      failure: {
        identityReview: {
          failureKind: "replacement-detected",
          verdict: "fail",
        },
      },
      status: "identity-review-failed",
    });
  });

  it("preserves the sandbox provider attribution emitted by the Pipeline", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: { ...successfulTerminalSummary(), sandboxProvider: "daytona" },
      }),
    ).toMatchObject({
      resultPath,
      sandboxProvider: "daytona",
      status: "succeeded",
    });
  });

  it("accepts a durable cooperative cancellation result from this benchmark run", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          artifacts: { logPath: "/runs/pipeline-log.jsonl" },
          cancellation: { reason: "deadline-exceeded" },
          failure: {
            blockers: ["Pipeline deadline exceeded."],
            suggestedChanges: [],
          },
          runDirectory:
            "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
          runId: "full-pipeline-2026-07-20T00-00-00-000Z",
          status: "cancelled",
        },
      }),
    ).toMatchObject({ status: "cancelled" });
  });

  it("preserves a Repo Security sandbox infrastructure failure for inconclusive benchmarking", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          artifacts: { logPath: "/runs/pipeline-log.jsonl" },
          failure: {
            blockers: ["Sandbox infrastructure was unavailable."],
            failureKind: "sandbox-infrastructure-failed",
            infrastructure: {
              phase: "release-settlement",
              provider: "daytona",
            },
            suggestedChanges: [],
          },
          runDirectory:
            "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
          runId: "full-pipeline-2026-07-20T00-00-00-000Z",
          sandboxProvider: "daytona",
          status: "infrastructure-failed",
        },
      }),
    ).toMatchObject({
      failure: {
        failureKind: "sandbox-infrastructure-failed",
        infrastructure: {
          phase: "release-settlement",
          provider: "daytona",
        },
      },
      resultPath,
      sandboxProvider: "daytona",
      status: "infrastructure-failed",
    });
  });

  it("preserves a Capture Path validator infrastructure kind when reading a terminal result", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          artifacts: { logPath: "/runs/pipeline-log.jsonl" },
          failure: {
            blockers: ["Trusted Playwright is unavailable."],
            failureKind: "validator-dependency-failed",
            suggestedChanges: [],
          },
          runDirectory:
            "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
          runId: "full-pipeline-2026-07-20T00-00-00-000Z",
          status: "infrastructure-failed",
        },
      }),
    ).toMatchObject({
      failure: { failureKind: "validator-dependency-failed" },
      status: "infrastructure-failed",
    });
  });

  it("preserves an exact Repo Security reviewer failure kind for inconclusive benchmarking", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          artifacts: { logPath: "/runs/pipeline-log.jsonl" },
          failure: {
            blockers: ["Repo Security reviewer timed out."],
            failureKind: "timeout",
            suggestedChanges: [],
          },
          runDirectory:
            "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
          runId: "full-pipeline-2026-07-20T00-00-00-000Z",
          status: "infrastructure-failed",
        },
      }),
    ).toMatchObject({
      failure: { failureKind: "timeout" },
      status: "infrastructure-failed",
    });
  });

  it("preserves a Repo Preparation registry acquisition diagnostic for inconclusive benchmarking", () => {
    expect(
      readBenchmarkTerminalPipelineResult({
        pipelineOutputRoot,
        resultPath,
        value: {
          artifacts: { logPath: "/runs/pipeline-log.jsonl" },
          failure: {
            blockers: ["Sandbox infrastructure was unavailable."],
            failureKind: "sandbox-infrastructure-failed",
            infrastructure: {
              phase: "registry-acquisition",
              provider: "daytona",
            },
            suggestedChanges: [],
          },
          runDirectory:
            "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
          runId: "full-pipeline-2026-07-20T00-00-00-000Z",
          sandboxProvider: "daytona",
          status: "infrastructure-failed",
        },
      }),
    ).toMatchObject({
      failure: {
        failureKind: "sandbox-infrastructure-failed",
        infrastructure: {
          phase: "registry-acquisition",
          provider: "daytona",
        },
      },
      status: "infrastructure-failed",
    });
  });

  it("carries safe SIGKILL resource diagnostics from the terminal artifact into the benchmark result", () => {
    const terminal = readBenchmarkTerminalPipelineResult({
      pipelineOutputRoot,
      resultPath,
      value: {
        ...failedTerminalSummary(),
        failure: {
          blockers: ["Dependency installation ended with SIGKILL."],
          failureKind: "dependency-install-sigkill",
          resourceDiagnostics: {
            classification: "cgroup-oom-kill",
            memoryOomKillDelta: 1,
            memoryPeakBytes: 4_123_456_789,
            providerState: "running",
            rawProviderReason: "secret provider response",
          },
          suggestedChanges: [],
        },
      },
    });

    expect(terminal).toMatchObject({
      failure: {
        failureKind: "dependency-install-sigkill",
        resourceDiagnostics: {
          classification: "cgroup-oom-kill",
          memoryOomKillDelta: 1,
          memoryPeakBytes: 4_123_456_789,
          providerState: "running",
        },
      },
    });
    expect(terminal?.failure?.resourceDiagnostics).not.toHaveProperty(
      "rawProviderReason",
    );
    if (terminal === undefined) throw new Error("expected terminal result");

    const result = buildBenchmarkResult({
      benchmarkRunId: "run-1",
      benchmarkTimeoutMs: 960_000,
      command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      durationMs: 1_000,
      endedAt: "2026-07-20T00:00:01.000Z",
      expectedLevel: "L5",
      fullPipelineLog: {
        stageOutcomes: [{ stage: "repo-preparation", status: "failed" }],
      },
      fullPipelineResult: terminal,
      lifecycle: { exitCode: 1, killed: false },
      repoId: "cal",
      repoUrl: "https://github.com/calcom/cal.com",
      runDirectory: ".makeademo-benchmark-runs/run-1/cal-r1",
      startedAt: "2026-07-20T00:00:00.000Z",
      stderrPath: "stderr.log",
      stdoutPath: "stdout.log",
    });

    expect(result.resourceDiagnostics).toEqual({
      classification: "cgroup-oom-kill",
      memoryOomKillDelta: 1,
      memoryPeakBytes: 4_123_456_789,
      providerState: "running",
    });
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
  it("passes a native identity evaluation when the real Pipeline stage succeeds before a later failure", () => {
    const identityEvaluation = preparedApplicationIdentityEvaluationCases[0];

    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: identityEvaluation.repo.commitSha,
        durationMs: 1_000,
        endedAt: "2026-07-20T00:00:01.000Z",
        expectedLevel: "L6",
        fullPipelineLog: {
          stageOutcomes: [
            {
              stage: "prepared-application-identity-review",
              status: "succeeded",
            },
            { stage: "capture-path-validation", status: "failed" },
          ],
          succeededEvents: [],
        },
        fullPipelineResult: {
          resultPath: "/runs/full-pipeline-result.json",
          status: "capture-path-validation-failed",
        },
        identityEvaluation,
        lifecycle: { exitCode: 1, killed: false },
        repoId: identityEvaluation.repo.id,
        repoUrl: identityEvaluation.repo.repoUrl,
        runDirectory: ".makeademo-benchmark-runs/run-1/directus-r1",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({
      identityEvaluation: {
        actualDecision: { verdict: "pass" },
        assessment: "passed",
        caseId: "directus-rest-native",
        expectedDecision: { verdict: "pass" },
      },
    });
  });

  it("passes the replacement evaluation only for the real replacement-detected decision", () => {
    const identityEvaluation = preparedApplicationIdentityEvaluationCases[3];
    const input = identityEvaluationBenchmarkInput(identityEvaluation);

    const replacementResult = buildBenchmarkResult({
      ...input,
      fullPipelineLog: {
        stageOutcomes: [
          { stage: "repo-preparation", status: "succeeded" },
          {
            stage: "prepared-application-identity-review",
            status: "failed",
          },
        ],
        succeededEvents: [],
      },
      fullPipelineResult: {
        failure: {
          blockers: ["Replacement application detected."],
          identityReview: {
            failureKind: "replacement-detected",
            verdict: "fail",
          },
        },
        resultPath: "/runs/full-pipeline-result.json",
        status: "identity-review-failed",
      },
    });

    expect(replacementResult).toMatchObject({
      identityEvaluation: {
        actualDecision: {
          failureKind: "replacement-detected",
          verdict: "fail",
        },
        assessment: "passed",
        caseId: "midday-local-database-replacement",
        expectedDecision: {
          failureKind: "replacement-detected",
          verdict: "fail",
        },
      },
    });
    expect(
      buildBenchmarkResult({
        ...input,
        fullPipelineLog: {
          stageOutcomes: [
            {
              stage: "prepared-application-identity-review",
              status: "failed",
            },
          ],
          succeededEvents: [],
        },
        fullPipelineResult: {
          failure: {
            blockers: ["Application identity was not proven."],
            identityReview: {
              failureKind: "identity-not-proven",
              verdict: "fail",
            },
          },
          resultPath: "/runs/full-pipeline-result.json",
          status: "identity-review-failed",
        },
      }).identityEvaluation,
    ).toMatchObject({
      actualDecision: {
        failureKind: "identity-not-proven",
        verdict: "fail",
      },
      assessment: "failed",
    });
  });

  it("keeps a pre-review infrastructure failure inconclusive in identity evaluation mode", () => {
    const identityEvaluation = preparedApplicationIdentityEvaluationCases[2];
    const input = identityEvaluationBenchmarkInput(identityEvaluation);

    expect(
      buildBenchmarkResult({
        ...input,
        fullPipelineLog: {
          latestStage: "repo-preparation",
          stageOutcomes: [
            { stage: "repo-security-screen", status: "succeeded" },
            { stage: "repo-preparation", status: "failed" },
          ],
          succeededEvents: [],
        },
        fullPipelineResult: {
          failure: {
            blockers: ["Sandbox infrastructure was unavailable."],
            failureKind: "sandbox-infrastructure-failed",
          },
          resultPath: "/runs/full-pipeline-result.json",
          status: "infrastructure-failed",
        },
      }),
    ).toMatchObject({
      identityEvaluation: {
        assessment: "inconclusive",
        caseId: "mattermost-authentication-native",
        expectedDecision: { verdict: "pass" },
      },
    });
  });

  it("does not reuse a stale identity pass when the latest reviewer attempt fails as infrastructure", () => {
    const identityEvaluation = preparedApplicationIdentityEvaluationCases[0];
    const input = identityEvaluationBenchmarkInput(identityEvaluation);

    expect(
      buildBenchmarkResult({
        ...input,
        fullPipelineLog: {
          latestStage: "prepared-application-identity-review",
          stageOutcomes: [
            {
              stage: "prepared-application-identity-review",
              status: "succeeded",
            },
            {
              stage: "prepared-application-identity-review",
              status: "started",
            },
            {
              stage: "prepared-application-identity-review",
              status: "failed",
            },
          ],
          succeededEvents: [],
        },
        fullPipelineResult: {
          failure: {
            blockers: ["Prepared Application Identity reviewer timed out."],
            failureKind: "timeout",
          },
          resultPath: "/runs/full-pipeline-result.json",
          status: "infrastructure-failed",
        },
      }).identityEvaluation,
    ).toMatchObject({ assessment: "inconclusive" });
  });

  it("keeps a durable succeeded result inconclusive when CLI cleanup exits nonzero", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 20_000,
        endedAt: "2026-07-20T00:00:20.000Z",
        expectedLevel: "L5",
        fullPipelineLog: { stageOutcomes: [], succeededEvents: [] },
        fullPipelineResult: {
          resultPath: "/runs/full-pipeline-result.json",
          status: "succeeded",
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
      disposition: "inconclusive",
      infrastructureFailureKind: "terminal-cleanup-failed",
      status: "failed",
      statusLevel: "L5",
    });
  });

  it("keeps a cooperative pipeline deadline inconclusive at the last trusted milestone", () => {
    expect(
      buildBenchmarkResult({
        benchmarkRunId: "run-1",
        benchmarkTimeoutMs: 960_000,
        command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        durationMs: 900_000,
        endedAt: "2026-07-20T00:15:00.000Z",
        expectedLevel: "L5",
        fullPipelineLog: {
          latestStage: "repo-preparation",
          stageOutcomes: [
            { stage: "repo-security-screen", status: "succeeded" },
            { stage: "repo-preparation", status: "started" },
          ],
          succeededEvents: [],
        },
        fullPipelineResult: {
          cancellationReason: "deadline-exceeded",
          resultPath: "/runs/full-pipeline-result.json",
          status: "cancelled",
        },
        lifecycle: { exitCode: 1, killed: false },
        repoId: "ghost",
        repoUrl: "https://github.com/TryGhost/Ghost",
        runDirectory: ".makeademo-benchmark-runs/run-1/ghost-r1",
        sandboxProvider: "daytona",
        startedAt: "2026-07-20T00:00:00.000Z",
        stderrPath: "stderr.log",
        stdoutPath: "stdout.log",
      }),
    ).toMatchObject({
      disposition: "inconclusive",
      failureStage: "repo-preparation",
      infrastructureFailureKind: "pipeline-deadline-exceeded",
      sandboxProvider: "daytona",
      statusLevel: "L0",
    });
  });

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

  it.each(["footage-capture", "compositing"])(
    "reports %s as the active stage when cooperative cancellation interrupts it",
    (activeStage) => {
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
              { stage: "capture-path-validation", status: "succeeded" },
              { stage: activeStage, status: "started" },
            ],
            succeededEvents: [],
          },
          fullPipelineResult: {
            cancellationReason: "deadline-exceeded",
            resultPath: "/runs/full-pipeline-result.json",
            status: "cancelled",
          },
          lifecycle: {
            exitCode: null,
            killed: false,
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
        failureStage: activeStage,
        infrastructureFailureKind: "pipeline-deadline-exceeded",
      });
    },
  );

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

  it("keeps a Capture Path validator dependency failure inconclusive", () => {
    expect(
      buildBenchmarkResult(
        infrastructureBenchmarkInput({
          blocker: "Trusted Playwright is unavailable.",
          failureKind: "validator-dependency-failed",
          failureStage: "capture-path-validation",
          pipelineStatus: "infrastructure-failed",
        }),
      ),
    ).toMatchObject({
      disposition: "inconclusive",
      failureStage: "capture-path-validation",
      infrastructureFailureKind: "validator-dependency-failed",
      status: "failed",
    });
  });

  it("keeps a durable sandbox infrastructure failure inconclusive", () => {
    expect(
      buildBenchmarkResult(
        infrastructureBenchmarkInput({
          blocker: "Sandbox infrastructure was unavailable.",
          failureKind: "sandbox-infrastructure-failed",
          failureStage: "repo-security-screen",
          infrastructure: { phase: "command-or-clone", provider: "daytona" },
          pipelineStatus: "infrastructure-failed",
          sandboxProvider: "daytona",
        }),
      ),
    ).toMatchObject({
      disposition: "inconclusive",
      infrastructureFailureKind: "sandbox-infrastructure-failed",
      status: "failed",
      statusLevel: "L0",
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

function infrastructureBenchmarkInput(input: {
  blocker: string;
  failureKind:
    | "dependency-install-sigkill"
    | "sandbox-infrastructure-failed"
    | "validator-dependency-failed";
  failureStage: string;
  infrastructure?: { phase: "command-or-clone"; provider: "daytona" };
  pipelineStatus: "infrastructure-failed" | "preparation-failed";
  sandboxProvider?: "daytona";
}): BenchmarkResultBuildInput {
  return {
    benchmarkRunId: "run-1",
    benchmarkTimeoutMs: 960_000,
    command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    durationMs: 1_000,
    endedAt: "2026-07-20T00:00:01.000Z",
    expectedLevel: "L5",
    fullPipelineLog: {
      failureStage: input.failureStage,
      stageOutcomes: [{ stage: input.failureStage, status: "failed" }],
      succeededEvents: [],
    },
    fullPipelineResult: {
      failure: {
        blockers: [input.blocker],
        failureKind: input.failureKind,
        ...(input.infrastructure === undefined
          ? {}
          : { infrastructure: input.infrastructure }),
      },
      resultPath: "/runs/full-pipeline-result.json",
      status: input.pipelineStatus,
    },
    lifecycle: { exitCode: 1, killed: false },
    repoId: "cal",
    repoUrl: "https://github.com/calcom/cal.com",
    runDirectory: ".makeademo-benchmark-runs/run-1/cal-r1",
    ...(input.sandboxProvider === undefined
      ? {}
      : { sandboxProvider: input.sandboxProvider }),
    startedAt: "2026-07-20T00:00:00.000Z",
    stderrPath: "stderr.log",
    stdoutPath: "stdout.log",
  };
}

function identityEvaluationBenchmarkInput(
  identityEvaluation: (typeof preparedApplicationIdentityEvaluationCases)[number],
): BenchmarkResultBuildInput {
  return {
    benchmarkRunId: "run-1",
    benchmarkTimeoutMs: 960_000,
    command: ["bun", "src/server/composition/full-pipeline-cli.mts"],
    commitSha: identityEvaluation.repo.commitSha,
    durationMs: 1_000,
    endedAt: "2026-07-20T00:00:01.000Z",
    expectedLevel: "L6",
    fullPipelineLog: { stageOutcomes: [], succeededEvents: [] },
    identityEvaluation,
    lifecycle: { exitCode: 1, killed: false },
    repoId: identityEvaluation.repo.id,
    repoUrl: identityEvaluation.repo.repoUrl,
    runDirectory: `.makeademo-benchmark-runs/run-1/${identityEvaluation.repo.id}-r1`,
    startedAt: "2026-07-20T00:00:00.000Z",
    stderrPath: "stderr.log",
    stdoutPath: "stdout.log",
  };
}

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
    runDirectory: "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
    runId: "full-pipeline-2026-07-20T00-00-00-000Z",
    script: { sceneCount: 1, scriptId: "script-1", title: "Demo" },
    status: "succeeded",
  };
}

function failedTerminalSummary() {
  return {
    artifacts: { logPath: "/runs/pipeline-log.jsonl" },
    failure: { blockers: ["Setup failed"], suggestedChanges: [] },
    runDirectory: "/runs/ghost/pipeline/full-pipeline-2026-07-20T00-00-00-000Z",
    runId: "full-pipeline-2026-07-20T00-00-00-000Z",
    status: "preparation-failed",
  };
}
