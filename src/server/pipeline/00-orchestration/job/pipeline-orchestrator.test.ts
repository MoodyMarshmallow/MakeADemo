import { describe, expect, it } from "vitest";

import { createAgentSession } from "../../../test-support/create-agent-session";
import type { RepoSecurityInput } from "../../02-repo-security-screen/repo-security-screen";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { CapturePathValidationFailureKind } from "../../05-capture-path-validation/capture-path-validator.interface";
import { PipelineCancellationError } from "./pipeline-cancellation";
import type { PipelineJobInput } from "./pipeline-job";
import { createRecordingPipelineObserver } from "./pipeline-observer";
import {
  type PipelineOrchestratorDependencies,
  type PipelineOrchestratorOptions,
  runPipelineJob as runPipelineJobWithDependencies,
} from "./pipeline-orchestrator";

function runPipelineJob(
  input: Omit<PipelineJobInput, "repoSecurity"> & {
    repoSecurity: Partial<RepoSecurityInput>;
  },
  dependencies: Omit<PipelineOrchestratorDependencies, "reviewRepoSecurity"> &
    Partial<Pick<PipelineOrchestratorDependencies, "reviewRepoSecurity">>,
  options?: PipelineOrchestratorOptions,
) {
  const preparationWorkspace =
    input.preparationWorkspace ?? fakeWorkspaceHandle();
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
      async reviewRepoSecurity() {
        return {
          concerns: [],
          rationale: "Test fixture approval.",
          status: "succeeded",
          verdict: "approved",
        };
      },
      ...dependencies,
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
      "script-generation",
      "capture-path-validation",
    ]);
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

function manifest() {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
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
