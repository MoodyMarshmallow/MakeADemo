import { describe, expect, it } from "vitest";

import { createAgentSession } from "../../../test-support/create-agent-session";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import { createRecordingPipelineObserver } from "./pipeline-observer";
import { runPipelineJob } from "./pipeline-orchestrator";

describe("runPipelineJob", () => {
  it("runs security screen, repo preparation, script generation, and capture path validation in order", async () => {
    const calls: string[] = [];
    const commitSha = "0123456789abcdef0123456789abcdef01234567";

    const result = await runPipelineJob(
      {
        commitSha,
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
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
          return {
            manifest: manifest(),
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          calls.push("repo-security-screen");
          return { rejections: [], status: "passed", warnings: [] };
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
      "repo-preparation",
      "script-generation",
      "capture-path-validation",
    ]);
  });

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
          demoBrief: { keyProductFeatures: ["validation"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 1_000 },
          },
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
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
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
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
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
          demoBrief: { keyProductFeatures: ["validation"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 1_000 },
          },
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
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
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
            warnings: ["Uses postinstall script."],
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
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
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
          demoBrief: { keyProductFeatures: ["validation"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 1_000 },
          },
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

  it("returns a fallback prompt and stops when Repo Preparation fails", async () => {
    const result = await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
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

    expect(result).toEqual({
      fallbackPrompt: "Prepare local dashboard fixtures.",
      failureKind: "dependency-install-sigkill",
      status: "preparation-failed",
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
