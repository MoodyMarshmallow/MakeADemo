import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAgentSession } from "../../../test-support/create-agent-session";
import type { RepoSecurityInput } from "../../02-repo-security-screen/repo-security-screen";
import { createApplicationIdentityBaseline } from "../../03-repo-preparation/application-identity-evidence";
import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type {
  RepoPreparationInput,
  RepoPreparationResult,
} from "../../03-repo-preparation/repo-preparation-agent.interface";
import type { CapturePathValidationFailureKind } from "../../05-capture-path-validation/capture-path-validator.interface";
import { PipelineCancellationError } from "./pipeline-cancellation";
import type { PipelineJobInput } from "./pipeline-job";
import { createRecordingPipelineObserver } from "./pipeline-observer";
import {
  type PipelineOrchestratorDependencies,
  type PipelineOrchestratorOptions,
  runPipelineJob as runPipelineJobWithDependencies,
} from "./pipeline-orchestrator";

type SuccessfulRepoPreparation = Extract<
  RepoPreparationResult,
  { status: "succeeded" }
>;

type TestRepoPreparationResult =
  | Exclude<RepoPreparationResult, { status: "succeeded" }>
  | (Omit<
      SuccessfulRepoPreparation,
      | "applicationIdentityBaseline"
      | "preparedWorkspaceDiff"
      | "runtimePreflight"
    > &
      Partial<
        Pick<
          SuccessfulRepoPreparation,
          | "applicationIdentityBaseline"
          | "preparedWorkspaceDiff"
          | "runtimePreflight"
        >
      >);

type TestPipelineOrchestratorDependencies = Omit<
  PipelineOrchestratorDependencies,
  "prepareRepo" | "reviewPreparedApplicationIdentity" | "reviewRepoSecurity"
> & {
  prepareRepo(input: RepoPreparationInput): Promise<TestRepoPreparationResult>;
} & Partial<
    Pick<
      PipelineOrchestratorDependencies,
      "reviewPreparedApplicationIdentity" | "reviewRepoSecurity"
    >
  >;

function runPipelineJob(
  input: Omit<PipelineJobInput, "repoSecurity"> & {
    repoSecurity: Partial<RepoSecurityInput>;
  },
  dependencies: TestPipelineOrchestratorDependencies,
  options?: PipelineOrchestratorOptions,
) {
  const preparationWorkspace =
    input.preparationWorkspace ?? fakeWorkspaceHandle();
  const prepareRepo = dependencies.prepareRepo;
  return runPipelineJobWithDependencies(
    {
      ...input,
      preparationWorkspace,
      repoSecurity: {
        scannerReports: [],
        ...input.repoSecurity,
      },
    },
    {
      ...dependencies,
      async prepareRepo(preparationInput) {
        const result = await prepareRepo(preparationInput);
        return result.status === "succeeded"
          ? withPreparedIdentityEvidence(preparationInput, result)
          : result;
      },
      reviewPreparedApplicationIdentity:
        dependencies.reviewPreparedApplicationIdentity ??
        (async () => passingIdentityReview()),
      reviewRepoSecurity:
        dependencies.reviewRepoSecurity ??
        (async () => ({
          concerns: [],
          rationale: "Test fixture approval.",
          status: "succeeded" as const,
          verdict: "approved" as const,
        })),
    },
    options,
  );
}

describe("runPipelineJob", () => {
  it("requires read-only agent approval between deterministic screening and Repo Preparation", async () => {
    const calls: string[] = [];
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const parentWorkspace = fakeWorkspaceHandle();
    const scannerReports: RepoSecurityInput["scannerReports"] = [
      {
        findingCount: 1,
        findings: [
          {
            id: "makeademo.test",
            line: 4,
            message: "Review this lifecycle behavior.",
            path: "scripts/install.sh",
            scanner: "semgrep",
          },
        ],
        omittedFindingCount: 0,
        scanner: "semgrep",
        status: "completed",
        summary: "Semgrep reported one advisory finding.",
        version: "1.172.0",
      },
    ];

    const result = await runPipelineJob(
      {
        commitSha,
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          scannerReports,
        },
        repoUrl: "https://github.com/example/app",
        preparationWorkspace: parentWorkspace,
        workspaceId: "workspace_123",
      },
      {
        async generateDemoScript() {
          calls.push("script-generation");
          return demoScript();
        },
        async prepareRepo(input) {
          calls.push("repo-preparation");
          expect(input.commitSha).toBe(commitSha);
          expect(input).not.toHaveProperty("repoSecurity");
          expect(input.preparationWorkspace).toBe(parentWorkspace);
          return {
            manifest: manifest(),
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        async reviewRepoSecurity(input) {
          calls.push("repo-security-agent-review");
          expect(input.preparationWorkspace).toBe(parentWorkspace);
          expect(input.scannerReports).toBe(scannerReports);
          return {
            concerns: [],
            rationale: "No concrete execution safety risk was found.",
            status: "succeeded",
            verdict: "approved",
          };
        },
        async reviewPreparedApplicationIdentity(input) {
          calls.push("prepared-application-identity-review");
          expect(input.evidenceLedger.commitSha).toBe(commitSha);
          expect(input.evidenceLedger.evidence.map(({ kind }) => kind)).toEqual(
            [
              "prepared-change",
              "prepared-screenshot",
              "accessibility-snapshot",
            ],
          );
          return passingIdentityReview();
        },
        screenRepoSecurity() {
          calls.push("repo-security-screen");
          return {
            rejections: [],
            status: "passed",
            warnings: [
              {
                code: "scanner-finding",
                line: 4,
                message: "Review this lifecycle behavior.",
                path: "scripts/install.sh",
                ruleId: "makeademo.test",
                scanner: "semgrep",
                severity: "warning",
              },
            ],
          };
        },
        async validateCapturePath(input) {
          calls.push("capture-path-validation");
          expect(input.preparationWorkspace?.id).toBe("daytona_workspace");
          expect(input.demoScript.scriptId).toBe("script_test");
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["validated"],
            status: "succeeded",
            warnings: [],
          };
        },
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.demoScript.scriptId).toBe("script_test");
    }
    expect(calls).toEqual([
      "repo-security-screen",
      "repo-security-agent-review",
      "repo-preparation",
      "prepared-application-identity-review",
      "script-generation",
      "capture-path-validation",
    ]);
  });

  it("stops before Script Generation when the prepared runtime replaces Midday with a generic dashboard", async () => {
    let generated = false;
    const progress: Array<{
      reason?: string;
      stage: string;
      status: string;
    }> = [];
    const result = await runPipelineJob(
      pipelineJobInput(),
      successfulPipelineDependencies({
        async generateDemoScript() {
          generated = true;
          throw new Error("must not generate");
        },
        async reviewPreparedApplicationIdentity() {
          return {
            explanation:
              "The prepared runtime is a generic analytics dashboard and no longer renders Midday's native workspace.",
            failureKind: "replacement-detected",
            mockedBoundaries: [],
            nativeSurfacesRendered: [],
            replacementEvidence: ["accessibility-snapshot:sha256:replacement"],
            sourceCitations: [
              { endLine: 40, path: "src/App.tsx", startLine: 1 },
            ],
            status: "succeeded",
            verdict: "fail",
          };
        },
      }),
      { onProgress: (event) => progress.push(event) },
    );

    expect(result).toMatchObject({
      identityReview: {
        failureKind: "replacement-detected",
        verdict: "fail",
      },
      status: "identity-review-failed",
    });
    expect(generated).toBe(false);
    expect(progress.at(-1)).toEqual({
      reason: "replacement-detected",
      stage: "prepared-application-identity-review",
      status: "failed",
    });
  });

  it("stops before Script Generation when native application identity is not proven", async () => {
    let generated = false;
    const result = await runPipelineJob(
      pipelineJobInput(),
      successfulPipelineDependencies({
        async generateDemoScript() {
          generated = true;
          throw new Error("must not generate");
        },
        async reviewPreparedApplicationIdentity() {
          return {
            explanation:
              "The retained evidence does not establish which native surface rendered.",
            failureKind: "identity-not-proven",
            mockedBoundaries: [],
            nativeSurfacesRendered: [],
            replacementEvidence: [],
            sourceCitations: [],
            status: "succeeded",
            verdict: "fail",
          };
        },
      }),
    );

    expect(result).toMatchObject({
      identityReview: {
        explanation: expect.stringContaining("does not establish"),
        failureKind: "identity-not-proven",
      },
      status: "identity-review-failed",
    });
    expect(generated).toBe(false);
  });

  it("accepts native UI with backend mocking declared by the Preparation Manifest", async () => {
    let reviewedBoundaries: readonly string[] = [];
    const result = await runPipelineJob(
      pipelineJobInput(),
      successfulPipelineDependencies({
        async prepareRepo() {
          const preparedManifest = manifest();
          preparedManifest.mockingPlan.boundaries.push({
            kind: "backend",
            localReplacement: "src/demo/api.ts",
            source: "api.midday.ai",
          });
          return {
            manifest: preparedManifest,
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        async reviewPreparedApplicationIdentity(input) {
          reviewedBoundaries = input.evidenceLedger.mockedBoundaries;
          return {
            ...passingIdentityReview(),
            mockedBoundaries: ["0:backend:api.midday.ai"],
          };
        },
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(reviewedBoundaries).toEqual(["0:backend:api.midday.ai"]);
  });

  it("fails identity review when Script Generation changes reviewed source", async () => {
    let validateCalls = 0;
    let sourceChanged = false;
    const workspace = fakeWorkspaceHandle();
    workspace.workspace.capturePreparedWorkspaceDiff = async () =>
      sourceChanged
        ? preparedWorkspaceDiff({
            modifiedPaths: ["src/App.tsx", "src/native-feed.tsx"],
            patch:
              "diff --git a/src/native-feed.tsx b/src/native-feed.tsx\n+replacement shell\n",
          })
        : preparedWorkspaceDiff();

    const result = await runPipelineJob(
      pipelineJobInput(),
      successfulPipelineDependencies({
        async generateDemoScript() {
          sourceChanged = true;
          return demoScript();
        },
        async prepareRepo() {
          return { manifest: manifest(), status: "succeeded", workspace };
        },
        async validateCapturePath() {
          validateCalls += 1;
          throw new Error("must not validate changed source");
        },
      }),
    );

    expect(result).toMatchObject({
      identityReview: {
        failureKind: "identity-not-proven",
        verdict: "fail",
      },
      status: "identity-review-failed",
    });
    expect(validateCalls).toBe(0);
  });

  it.each(["unavailable", "timeout", "invalid-output"] as const)(
    "maps prepared application identity reviewer %s to a stage-specific infrastructure failure",
    async (failureKind) => {
      let generated = false;
      const result = await runPipelineJob(
        pipelineJobInput(),
        successfulPipelineDependencies({
          async generateDemoScript() {
            generated = true;
            throw new Error("must not generate");
          },
          async reviewPreparedApplicationIdentity() {
            return { failureKind, status: "failed" };
          },
        }),
      );

      expect(result).toMatchObject({
        failureKind,
        failureReason: expect.stringContaining(failureKind),
        stage: "prepared-application-identity-review",
        status: "infrastructure-failed",
      });
      expect(generated).toBe(false);
    },
  );

  it("fails closed before identity review when preparation evidence does not match its manifest", async () => {
    let generated = false;
    let reviewed = false;
    const result = await runPipelineJob(
      pipelineJobInput(),
      successfulPipelineDependencies({
        async generateDemoScript() {
          generated = true;
          throw new Error("must not generate");
        },
        async prepareRepo() {
          const prepared = withPreparedIdentityEvidence(pipelineJobInput(), {
            manifest: manifest(),
            status: "succeeded" as const,
            workspace: fakeWorkspaceHandle(),
          });
          return {
            ...prepared,
            preparedWorkspaceDiff: {
              ...prepared.preparedWorkspaceDiff,
              artifactId: "different-diff-artifact",
            },
          };
        },
        async reviewPreparedApplicationIdentity() {
          reviewed = true;
          return passingIdentityReview();
        },
      }),
    );

    expect(result).toMatchObject({
      failureKind: "invalid-output",
      failureReason: expect.stringContaining("did not match"),
      stage: "prepared-application-identity-review",
      status: "infrastructure-failed",
    });
    expect({ generated, reviewed }).toEqual({
      generated: false,
      reviewed: false,
    });
  });

  it("fails closed before review when the pre-mutation UI identity digest is altered", async () => {
    let reviewed = false;
    const result = await runPipelineJob(
      pipelineJobInput(),
      successfulPipelineDependencies({
        async prepareRepo() {
          const prepared = withPreparedIdentityEvidence(pipelineJobInput(), {
            manifest: manifest(),
            status: "succeeded" as const,
            workspace: fakeWorkspaceHandle(),
          });
          return {
            ...prepared,
            applicationIdentityBaseline: {
              ...prepared.applicationIdentityBaseline,
              uiIdentityIndex: {
                ...prepared.applicationIdentityBaseline.uiIdentityIndex,
                indexSha256: "0".repeat(64),
              },
            },
          };
        },
        async reviewPreparedApplicationIdentity() {
          reviewed = true;
          return passingIdentityReview();
        },
      }),
    );

    expect(result).toMatchObject({
      failureKind: "invalid-output",
      failureReason: expect.stringContaining("digest or size"),
      stage: "prepared-application-identity-review",
      status: "infrastructure-failed",
    });
    expect(reviewed).toBe(false);
  });

  it("propagates cancellation from prepared application identity review", async () => {
    await expect(
      runPipelineJob(
        pipelineJobInput(),
        successfulPipelineDependencies({
          async reviewPreparedApplicationIdentity() {
            throw new PipelineCancellationError("signal");
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "signal" });
  });

  it("keeps signal cancellation primary when identity review settles with another error", async () => {
    const controller = new AbortController();
    await expect(
      runPipelineJob(
        pipelineJobInput(),
        successfulPipelineDependencies({
          async reviewPreparedApplicationIdentity() {
            controller.abort();
            throw new Error("review transport closed");
          },
        }),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ reason: "signal" });
  });

  it("stops before preparation when the read-only agent rejects execution", async () => {
    const calls: string[] = [];
    const input = pipelineJobInput();
    input.preparationWorkspace.discard = async () => {
      calls.push("parent-discard");
    };
    input.preparationWorkspace.release = async () => {
      calls.push("parent-release");
    };
    const result = await runPipelineJob(input, {
      async generateDemoScript() {
        throw new Error("must not generate");
      },
      async prepareRepo() {
        calls.push("repo-preparation");
        throw new Error("must not prepare");
      },
      async reviewRepoSecurity() {
        calls.push("repo-security-agent-review");
        return {
          concerns: [
            "The postinstall downloads and executes an unpinned script.",
          ],
          rationale: "The bounded evidence establishes an execution risk.",
          status: "succeeded",
          verdict: "rejected",
        };
      },
      screenRepoSecurity() {
        calls.push("repo-security-screen");
        return { rejections: [], status: "passed", warnings: [] };
      },
      async validateCapturePath() {
        throw new Error("must not validate");
      },
    });

    expect(result).toMatchObject({
      review: { verdict: "rejected" },
      status: "security-rejected",
    });
    expect(calls).toEqual([
      "repo-security-screen",
      "repo-security-agent-review",
      "parent-discard",
    ]);
  });

  it.each(["unavailable", "timeout", "invalid-output"] as const)(
    "returns typed infrastructure failure when security review is %s",
    async (failureKind) => {
      let prepared = false;
      const result = await runPipelineJob(pipelineJobInput(), {
        async generateDemoScript() {
          throw new Error("must not generate");
        },
        async prepareRepo() {
          prepared = true;
          throw new Error("must not prepare");
        },
        async reviewRepoSecurity() {
          return {
            failureKind,
            status: "failed",
          };
        },
        screenRepoSecurity() {
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateCapturePath() {
          throw new Error("must not validate");
        },
      });

      expect(result).toMatchObject({
        failureKind,
        stage: "repo-security-screen",
        status: "infrastructure-failed",
      });
      expect(prepared).toBe(false);
    },
  );

  it("settles active submitted-code validation before propagating Pipeline cancellation", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const workspace = fakeWorkspaceHandle();
    let settleValidation: (() => void) | undefined;
    workspace.workspace.cancelActiveCommands = async () => {
      events.push("validation-cancelled");
      settleValidation?.();
    };

    await expect(
      runPipelineJob(
        {
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          demoBrief: { keyProductFeatures: ["validation"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {},
          repoUrl: "https://github.com/example/app",
          workspaceId: "workspace_123",
        },
        {
          async generateDemoScript() {
            return demoScript();
          },
          async prepareRepo() {
            return { manifest: manifest(), status: "succeeded", workspace };
          },
          screenRepoSecurity() {
            return { rejections: [], status: "passed", warnings: [] };
          },
          async validateCapturePath() {
            events.push("validation-started");
            await new Promise<void>((resolve) => {
              settleValidation = resolve;
              queueMicrotask(() => controller.abort());
            });
            events.push("validation-settled");
            return {
              blockedNetworkAttempts: [],
              browserUrl: "https://preview.example.test/",
              logs: [],
              status: "succeeded",
              warnings: [],
            };
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ reason: "signal" });
    expect(events).toEqual([
      "validation-started",
      "validation-cancelled",
      "validation-settled",
    ]);
  });

  it("keeps cancelling sequential validation commands started after abort", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const workspace = fakeWorkspaceHandle();
    let activeCommand: (() => void) | undefined;
    let markFirstCommandStarted: (() => void) | undefined;
    const firstCommandStarted = new Promise<void>((resolve) => {
      markFirstCommandStarted = resolve;
    });
    workspace.workspace.cancelActiveCommands = async () => {
      events.push("cancel-snapshot");
      activeCommand?.();
    };
    const runCommand = async (name: string) => {
      events.push(`${name}-started`);
      if (name === "first-command") markFirstCommandStarted?.();
      await new Promise<void>((resolve) => {
        activeCommand = resolve;
      });
      activeCommand = undefined;
      events.push(`${name}-settled`);
    };

    const running = runPipelineJob(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {},
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateDemoScript() {
          return demoScript();
        },
        async prepareRepo() {
          return { manifest: manifest(), status: "succeeded", workspace };
        },
        screenRepoSecurity() {
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateCapturePath() {
          await runCommand("first-command");
          await runCommand("second-command");
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: [],
            status: "succeeded",
            warnings: [],
          };
        },
      },
      { signal: controller.signal },
    );
    await firstCommandStarted;
    controller.abort();

    await expect(running).rejects.toMatchObject({ reason: "signal" });
    expect(events).toEqual([
      "first-command-started",
      "cancel-snapshot",
      "first-command-settled",
      "second-command-started",
      "cancel-snapshot",
      "second-command-settled",
    ]);
  });

  it("reports stage progress in order", async () => {
    const progress: string[] = [];

    await runPipelineJob(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {},
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateDemoScript() {
          return demoScript();
        },
        async prepareRepo() {
          return {
            manifest: manifest(),
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateCapturePath() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["validated"],
            status: "succeeded",
            warnings: [],
          };
        },
      },
      {
        onProgress: (event) => progress.push(`${event.stage}:${event.status}`),
      },
    );

    expect(progress).toEqual([
      "repo-security-screen:started",
      "repo-security-screen:succeeded",
      "repo-preparation:started",
      "repo-preparation:succeeded",
      "prepared-application-identity-review:started",
      "prepared-application-identity-review:succeeded",
      "script-generation:started",
      "script-generation:succeeded",
      "capture-path-validation:started",
      "capture-path-validation:succeeded",
    ]);
  });

  it("fails the Capture Path Validation stage when a success result omits the browser URL", async () => {
    const progress: string[] = [];
    const observer = createRecordingPipelineObserver();

    await expect(
      runPipelineJob(
        {
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          demoBrief: { keyProductFeatures: ["validation"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {},
          repoUrl: "https://github.com/example/app",
          workspaceId: "workspace_123",
        },
        {
          async generateDemoScript() {
            return demoScript();
          },
          async prepareRepo() {
            return {
              manifest: manifest(),
              status: "succeeded",
              workspace: fakeWorkspaceHandle(),
            };
          },
          screenRepoSecurity() {
            return { rejections: [], status: "passed", warnings: [] };
          },
          async validateCapturePath() {
            return {
              blockedNetworkAttempts: [],
              logs: ["validated without preview"],
              status: "succeeded",
              warnings: [],
            };
          },
        },
        {
          observer,
          onProgress: (event) =>
            progress.push(`${event.stage}:${event.status}`),
        },
      ),
    ).rejects.toThrow(
      "Capture Path Validation succeeded without a browser URL.",
    );

    expect(progress).toContain("capture-path-validation:failed");
    expect(observer.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "stage.failed",
          stage: "capture-path-validation",
          status: "failed",
        }),
      ]),
    );
  });

  it("reports structured stage observability events with durations and safe summary counts", async () => {
    const observer = createRecordingPipelineObserver();
    let now = 1_000;

    await runPipelineJob(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {},
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateDemoScript() {
          now += 40;
          return demoScript();
        },
        async prepareRepo() {
          now += 20;
          return {
            manifest: {
              ...manifest(),
              assumptions: ["Uses seeded demo data."],
              createdFiles: ["makeademo.config.json"],
              mockedServices: ["billing"],
              risks: ["Needs deterministic auth fixture."],
            },
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          now += 5;
          return {
            rejections: [],
            status: "passed",
            warnings: [
              {
                code: "scanner-finding",
                message: "Uses postinstall script.",
                path: "package.json",
                ruleId: "guarddog.npm-exec-base64",
                scanner: "guarddog",
                severity: "warning",
              },
            ],
          };
        },
        async validateCapturePath() {
          now += 30;
          return {
            blockedNetworkAttempts: [
              {
                direction: "outbound",
                host: "api.example.com",
                phase: "runtime",
              },
            ],
            browserUrl: "https://preview.example.test/",
            logs: ["validated"],
            status: "succeeded",
            warnings: ["Viewport fallback used."],
          };
        },
      },
      {
        context: {
          demoRequestId: "demo-request-1",
          projectId: "project-1",
        },
        now: () => now,
        observer,
      },
    );

    expect(
      observer.events.map((event) => ({
        blockedNetworkAttemptCount: event.blockedNetworkAttemptCount,
        createdFileCount: event.createdFileCount,
        demoRequestId: event.demoRequestId,
        durationMs: event.durationMs,
        event: event.event,
        mockedServiceCount: event.mockedServiceCount,
        projectId: event.projectId,
        riskCount: event.riskCount,
        sceneCount: event.sceneCount,
        stage: event.stage,
        status: event.status,
        warningCount: event.warningCount,
        workspaceId: event.workspaceId,
      })),
    ).toEqual([
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "repo-security-screen",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: 5,
        event: "stage.succeeded",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "repo-security-screen",
        status: "succeeded",
        warningCount: 1,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "repo-preparation",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: 1,
        demoRequestId: "demo-request-1",
        durationMs: 20,
        event: "stage.succeeded",
        mockedServiceCount: 1,
        projectId: "project-1",
        riskCount: 1,
        sceneCount: undefined,
        stage: "repo-preparation",
        status: "succeeded",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "prepared-application-identity-review",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: 0,
        event: "stage.succeeded",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "prepared-application-identity-review",
        status: "succeeded",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "script-generation",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: 40,
        event: "stage.succeeded",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: 1,
        sceneCount: 1,
        stage: "script-generation",
        status: "succeeded",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "capture-path-validation",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: 1,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: 30,
        event: "stage.succeeded",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: 1,
        stage: "capture-path-validation",
        status: "succeeded",
        warningCount: 1,
        workspaceId: "workspace_123",
      },
    ]);
  });

  it("carries the preparation Agent Session into script generation and capture path validation", async () => {
    const calls: string[] = [];
    const preparationAgentSession = createAgentSession();

    const result = await runPipelineJob(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {},
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateDemoScript({ agentSession, preparationWorkspace }) {
          calls.push("script-generation");
          expect(agentSession).toBe(preparationAgentSession);
          expect(preparationWorkspace?.id).toBe("daytona_workspace");
          return demoScript();
        },
        async prepareRepo() {
          calls.push("repo-preparation");
          return {
            manifest: manifest(),
            agentSession: preparationAgentSession,
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          calls.push("repo-security-screen");
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateCapturePath({ preparationWorkspace, demoScript }) {
          calls.push("capture-path-validation");
          expect(preparationWorkspace?.id).toBe("daytona_workspace");
          expect(demoScript.scriptId).toBe("script_test");
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["validated capture path"],
            status: "succeeded",
            warnings: [],
          };
        },
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.agentSession).toBe(preparationAgentSession);
    }
    expect(calls).toEqual([
      "repo-security-screen",
      "repo-preparation",
      "script-generation",
      "capture-path-validation",
    ]);
  });

  it("repairs the Demo Script after Capture Path Validation fails and reruns validation", async () => {
    const previousRepairAttempts =
      process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS;
    process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS = "1";
    const calls: string[] = [];
    const preparationAgentSession = createAgentSession();
    const repairAgentSessions: unknown[] = [];
    const observer = createRecordingPipelineObserver();
    const controller = new AbortController();
    const pipelineDeadlineAt = Date.now() + 900_000;

    try {
      const result = await runPipelineJob(
        {
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          demoBrief: { keyProductFeatures: ["validation"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {},
          repoUrl: "https://github.com/example/app",
          workspaceId: "workspace_123",
        },
        {
          async generateDemoScript(input) {
            expect(input.signal).toBe(controller.signal);
            expect(input.deadlineAt).toBe(pipelineDeadlineAt);
            calls.push("script-generation");
            return demoScript({ scriptId: "script_bad" });
          },
          async prepareRepo(input) {
            expect(input.signal).toBe(controller.signal);
            expect(input.deadlineAt).toBeLessThan(pipelineDeadlineAt);
            calls.push("repo-preparation");
            return {
              manifest: manifest(),
              agentSession: preparationAgentSession,
              status: "succeeded",
              workspace: fakeWorkspaceHandle(),
            };
          },
          async repairCapturePathFailure(input) {
            expect(input.signal).toBe(controller.signal);
            expect(input.deadlineAt).toBe(pipelineDeadlineAt);
            repairAgentSessions.push(input.agentSession);
            calls.push(
              `repair:${input.attempt}:${input.failure.failedSceneId}`,
            );
            return {
              preparationManifest: input.preparationManifest,
              demoScript: demoScript({ scriptId: "script_repaired" }),
            };
          },
          screenRepoSecurity() {
            calls.push("repo-security-screen");
            return { rejections: [], status: "passed", warnings: [] };
          },
          async validateCapturePath(input) {
            calls.push(`capture-path-validation:${input.demoScript.scriptId}`);
            if (input.demoScript.scriptId === "script_bad") {
              return {
                blockedNetworkAttempts: [],
                browserUrl: "https://preview.example.test/",
                failedSceneId: "scene_validation",
                failureReason: "Button was not found.",
                logs: ["missing button"],
                status: "failed",
                warnings: [],
              };
            }

            return {
              blockedNetworkAttempts: [],
              browserUrl: "https://preview.example.test/",
              logs: ["validated repaired script"],
              status: "succeeded",
              warnings: [],
            };
          },
        },
        { deadlineAt: pipelineDeadlineAt, observer, signal: controller.signal },
      );

      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.demoScript.scriptId).toBe("script_repaired");
      }
      expect(calls).toEqual([
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture-path-validation:script_bad",
        "repair:1:scene_validation",
        "capture-path-validation:script_repaired",
      ]);
      expect(repairAgentSessions).toEqual([preparationAgentSession]);
      expect(observer.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "stage.retrying",
            nextAttempt: 2,
            reason: "Button was not found.",
            stage: "capture-path-validation",
            status: "retrying",
          }),
        ]),
      );
    } finally {
      if (previousRepairAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS =
          previousRepairAttempts;
      }
    }
  });

  it("fails identity review when Capture Path repair changes reviewed source", async () => {
    const previousRepairAttempts =
      process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS;
    process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS = "1";
    let repairChangedSource = false;
    let validationCalls = 0;
    const workspace = fakeWorkspaceHandle();
    workspace.workspace.capturePreparedWorkspaceDiff = async () =>
      repairChangedSource
        ? preparedWorkspaceDiff({
            artifactId: "workspace-diff:sha256:changed-after-repair",
            createdPaths: ["src/replacement-dashboard.tsx"],
            patch:
              "diff --git a/src/replacement-dashboard.tsx b/src/replacement-dashboard.tsx\n+replacement\n",
          })
        : preparedWorkspaceDiff({ artifactId: manifest().diffArtifactId });

    try {
      const result = await runPipelineJob(
        pipelineJobInput(),
        successfulPipelineDependencies({
          async generateDemoScript() {
            return demoScript({ scriptId: "script_bad" });
          },
          async prepareRepo() {
            return { manifest: manifest(), status: "succeeded", workspace };
          },
          async repairCapturePathFailure(input) {
            repairChangedSource = true;
            return {
              demoScript: demoScript({ scriptId: "script_repaired" }),
              preparationManifest: input.preparationManifest,
            };
          },
          async validateCapturePath(input) {
            validationCalls += 1;
            if (input.demoScript.scriptId === "script_bad") {
              return {
                blockedNetworkAttempts: [],
                browserUrl: "https://preview.example.test/",
                failedSceneId: "scene_validation",
                failureReason: "Button was not found.",
                logs: [],
                status: "failed",
                warnings: [],
              };
            }
            throw new Error("must not validate source-changing repair");
          },
        }),
      );

      expect(result).toMatchObject({
        identityReview: {
          failureKind: "identity-not-proven",
          verdict: "fail",
        },
        status: "identity-review-failed",
      });
      expect(validationCalls).toBe(1);
    } finally {
      if (previousRepairAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS =
          previousRepairAttempts;
      }
    }
  });

  it("preserves the failed validation result when Capture Path repair throws", async () => {
    const result = await runPipelineJob(
      pipelineJobInput(),
      capturePathFailureDependencies({
        async repairCapturePathFailure() {
          throw new Error("Capture Path repair produced invalid artifacts.");
        },
      }),
    );

    expect(result).toMatchObject({
      capturePathValidation: {
        blockedNetworkAttempts: [],
        browserUrl: "https://preview.example.test/",
        failedSceneId: "scene_validation",
        failureReason: "Generated selector did not match.",
        logs: ["selector failed"],
        status: "failed",
        warnings: ["Retry with a stable selector."],
      },
      status: "capture-path-validation-failed",
    });
  });

  it("returns infrastructure failures without asking an agent to repair them", async () => {
    let repairCalls = 0;
    const result = await runPipelineJob(
      pipelineJobInput(),
      capturePathFailureDependencies({
        failureKind: "validator-dependency-failed",
        async repairCapturePathFailure() {
          repairCalls += 1;
          throw new Error("infrastructure failures are not repairable");
        },
      }),
    );

    expect(repairCalls).toBe(0);
    expect(result).toMatchObject({
      failureKind: "validator-dependency-failed",
      failureReason: "Generated selector did not match.",
      stage: "capture-path-validation",
      status: "infrastructure-failed",
    });
  });

  it.each([
    "browser-not-interactable",
    "browser-load-failed",
    "demo-script-type-validation-failed",
  ] as const)("still asks an agent to repair %s", async (failureKind) => {
    let repairCalls = 0;
    const result = await runPipelineJob(
      pipelineJobInput(),
      capturePathFailureDependencies({
        failureKind,
        async repairCapturePathFailure() {
          repairCalls += 1;
          throw new Error("stop after proving repair is attempted");
        },
      }),
    );

    expect(repairCalls).toBe(1);
    expect(result).toMatchObject({
      capturePathValidation: { failureKind },
      status: "capture-path-validation-failed",
    });
  });

  it("propagates Pipeline deadline cancellation from Capture Path repair", async () => {
    await expect(
      runPipelineJob(
        pipelineJobInput(),
        capturePathFailureDependencies({
          async repairCapturePathFailure() {
            throw new PipelineCancellationError("deadline-exceeded");
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "deadline-exceeded" });
  });

  it("propagates Pipeline signal cancellation when Capture Path repair stops with another error", async () => {
    const controller = new AbortController();

    await expect(
      runPipelineJob(
        pipelineJobInput(),
        capturePathFailureDependencies({
          async repairCapturePathFailure() {
            controller.abort();
            throw new Error("Capture Path repair stopped after abort.");
          },
        }),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ reason: "signal" });
  });

  it("returns Repo Preparation infrastructure failures directly", async () => {
    const result = await runPipelineJob(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        demoBrief: { keyProductFeatures: ["dashboard"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {},
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateDemoScript() {
          throw new Error(
            "script generation should not run after preparation fails",
          );
        },
        async prepareRepo() {
          return {
            fallbackPrompt: "Prepare local dashboard fixtures.",
            failureKind: "dependency-install-sigkill",
            resourceDiagnostics: {
              classification: "cgroup-oom-kill" as const,
              memoryOomKillDelta: 1,
            },
            status: "failed",
          };
        },
        screenRepoSecurity() {
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateCapturePath() {
          throw new Error("validation should not run after preparation fails");
        },
      },
    );

    expect(result).toMatchObject({
      failureKind: "dependency-install-sigkill",
      failureReason: "Prepare local dashboard fixtures.",
      resourceDiagnostics: {
        classification: "cgroup-oom-kill",
        memoryOomKillDelta: 1,
      },
      stage: "repo-preparation",
      status: "infrastructure-failed",
    });
  });
});

function manifest(): PreparationManifest {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockingPlan: {
      boundaries: [],
      fixturePaths: [],
      loadedPlaybooks: [],
      nativeUiRoots: ["src/App.tsx"],
      plannedPresentationChanges: [],
    },
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId: "workspace_123",
  };
}

function withPreparedIdentityEvidence(
  input: { commitSha: string; repoUrl: string },
  result: Extract<TestRepoPreparationResult, { status: "succeeded" }>,
): SuccessfulRepoPreparation {
  const accessibilityText = "main: Native article feed\nbutton: Open article";
  const applicationIdentityBaseline = createApplicationIdentityBaseline({
    pinnedRevision: input.commitSha,
    repoUrl: input.repoUrl,
    sourceControlledPaths: ["src/App.tsx"],
    sourceTreeObjectId: "1111111111111111111111111111111111111111",
  });
  const identityDiff = preparedWorkspaceDiff({
    artifactId: result.manifest.diffArtifactId,
  });
  const runtimePreflight = {
    accessibilitySnapshot: {
      sha256: sha256(accessibilityText),
      sizeBytes: Buffer.byteLength(accessibilityText),
      text: accessibilityText,
    },
    blockedNetworkAttempts: [],
    logs: [],
    screenshot: {
      mimeType: "image/png" as const,
      path: "/tmp/prepared-app.png",
      sha256: sha256("prepared-app-screenshot"),
      sizeBytes: 23,
    },
    status: "succeeded" as const,
    warnings: [],
  };
  return {
    ...result,
    applicationIdentityBaseline:
      result.applicationIdentityBaseline ?? applicationIdentityBaseline,
    preparedWorkspaceDiff: result.preparedWorkspaceDiff ?? identityDiff,
    runtimePreflight: result.runtimePreflight ?? runtimePreflight,
  };
}

function preparedWorkspaceDiff(
  input: {
    artifactId?: string;
    createdPaths?: string[];
    deletedPaths?: string[];
    modifiedPaths?: string[];
    patch?: string;
  } = {},
) {
  const patch = input.patch ?? "diff --git a/src/App.tsx b/src/App.tsx\n";
  const patchSha256 = sha256(patch);
  return {
    artifactId: input.artifactId ?? `workspace-diff:sha256:${patchSha256}`,
    createdPaths: input.createdPaths ?? [],
    deletedPaths: input.deletedPaths ?? [],
    modifiedPaths: input.modifiedPaths ?? ["src/App.tsx"],
    patch,
    patchSha256,
    sizeBytes: Buffer.byteLength(patch),
  };
}

function passingIdentityReview() {
  return {
    explanation: "The prepared runtime renders the submitted native UI.",
    mockedBoundaries: [],
    nativeSurfacesRendered: ["src/App.tsx"],
    replacementEvidence: [],
    sourceCitations: [{ endLine: 12, path: "src/App.tsx", startLine: 1 }],
    status: "succeeded" as const,
    verdict: "pass" as const,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function pipelineJobInput() {
  return {
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    demoBrief: { keyProductFeatures: ["validation"] },
    normalizedSupportingDocuments: [],
    preparationWorkspace: fakeWorkspaceHandle(),
    repoSecurity: { scannerReports: [] },
    repoUrl: "https://github.com/example/app",
    workspaceId: "workspace_123",
  };
}

function successfulPipelineDependencies(
  overrides: Partial<TestPipelineOrchestratorDependencies> = {},
): TestPipelineOrchestratorDependencies {
  return {
    async generateDemoScript() {
      return demoScript();
    },
    async prepareRepo() {
      return {
        manifest: manifest(),
        status: "succeeded",
        workspace: fakeWorkspaceHandle(),
      };
    },
    screenRepoSecurity() {
      return { rejections: [], status: "passed", warnings: [] };
    },
    async validateCapturePath() {
      return {
        blockedNetworkAttempts: [],
        browserUrl: "https://preview.example.test/",
        logs: [],
        status: "succeeded",
        warnings: [],
      };
    },
    ...overrides,
  };
}

function capturePathFailureDependencies(input: {
  failureKind?: CapturePathValidationFailureKind;
  repairCapturePathFailure: NonNullable<
    Parameters<typeof runPipelineJob>[1]["repairCapturePathFailure"]
  >;
}): Parameters<typeof runPipelineJob>[1] {
  return {
    async generateDemoScript() {
      return demoScript({ scriptId: "script_invalid" });
    },
    async prepareRepo() {
      return {
        manifest: manifest(),
        status: "succeeded",
        workspace: fakeWorkspaceHandle(),
      };
    },
    repairCapturePathFailure: input.repairCapturePathFailure,
    screenRepoSecurity() {
      return { rejections: [], status: "passed", warnings: [] };
    },
    async validateCapturePath() {
      return {
        blockedNetworkAttempts: [],
        browserUrl: "https://preview.example.test/",
        failedSceneId: "scene_validation",
        ...(input.failureKind === undefined
          ? {}
          : { failureKind: input.failureKind }),
        failureReason: "Generated selector did not match.",
        logs: ["selector failed"],
        status: "failed",
        warnings: ["Retry with a stable selector."],
      };
    },
  };
}

function demoScript(input: { scriptId?: string } = {}) {
  return {
    demoPlaywrightScript:
      "await scene('scene_validation', async () => { await page.goto(baseUrl); });",
    format: "16:9",
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Validation is visible.",
        humanReadableDescription: "Show validation.",
        id: "scene_validation",
      },
    ],
    scriptId: input.scriptId ?? "script_test",
    title: "Demo",
    version: 1,
  };
}

function fakeWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "daytona_workspace",
    workspace: {
      async capturePreparedWorkspaceDiff() {
        return preparedWorkspaceDiff({ artifactId: manifest().diffArtifactId });
      },
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl(port: number) {
        return `https://preview.example.test:${port}`;
      },
      async uploadFiles() {},
    },
  };
}
