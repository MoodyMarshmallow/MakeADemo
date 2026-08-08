import { afterEach, describe, expect, it, vi } from "vitest";

import { validateCapturePath } from "./capture-path-validator";

describe("validateCapturePath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs project-level checks before generated capture actions", async () => {
    const calls: string[] = [];
    const sandboxLogs: Array<Record<string, unknown>> = [];

    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle(sandboxLogs),
        demoScript: demoScript(),
      },
      {
        async runRuntimePreflight() {
          calls.push("project-checks");
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene(input) {
            calls.push(
              `scene:${input.scene.id}:${input.baseUrl}:${input.demoPlaywrightScript}`,
            );
            return {
              logs: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
                "scene dry run passed",
              ],
              runDirectory: ".makeademo-capture-path-validation-runs/run_123",
              scriptPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.ts",
              status: "succeeded",
            };
          },
        },
      },
    );

    expect(result).toEqual({
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test/",
      diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
      logs: [
        "project checks passed",
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
        "scene dry run passed",
      ],
      status: "succeeded",
      warnings: [],
    });
    expect(calls).toEqual([
      "project-checks",
      "scene:scene_validation:http://localhost:3000:import { setup, scene } from './makeademo-capture-sdk';\n\nawait setup(async ({ page, baseUrl, expect }) => {\n  await page.goto(baseUrl);\n  await expect(page.locator('body')).toBeVisible();\n});\nawait scene('scene_validation', async ({ page, expect }) => {\n  await expect(page.locator('body')).toBeVisible();\n});",
    ]);
    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "capture-path-validation.runtime-preflight.started",
          stage: "capture-path-validation",
          workspaceId: "workspace_123",
        }),
        expect.objectContaining({
          event: "capture-path-validation.runtime-preflight.succeeded",
          stage: "capture-path-validation",
          workspaceId: "workspace_123",
        }),
        expect.objectContaining({
          event: "capture-path-validation.demo-script.started",
          scenes: expect.arrayContaining([
            expect.objectContaining({ sceneId: "scene_validation" }),
          ]),
          stage: "capture-path-validation",
          workspaceId: "workspace_123",
        }),
        expect.objectContaining({
          event: "capture-path-validation.scene.succeeded",
          runDirectory: ".makeademo-capture-path-validation-runs/run_123",
          sceneId: "scene_validation",
          scriptPath:
            ".makeademo-capture-path-validation-runs/run_123/scene_validation.ts",
          sectionId: "demo-script",
          stage: "capture-path-validation",
          workspaceId: "workspace_123",
        }),
      ]),
    );
  });

  it("preserves machine-readable scene infrastructure failures", async () => {
    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle([]),
        demoScript: demoScript(),
      },
      {
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded" as const,
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              failureKind: "validator-dependency-failed" as const,
              failureReason: "Trusted Playwright is unavailable.",
              logs: ["missing trusted Playwright"],
              status: "failed" as const,
            };
          },
        },
      },
    );

    expect(result).toMatchObject({
      failureKind: "validator-dependency-failed",
      failureReason: "Trusted Playwright is unavailable.",
      status: "failed",
    });
  });

  it("enqueues each demo-script diagnostics event once without a fallback while a serialized sink is slow", async () => {
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const fallbackWarnings: Array<Record<string, unknown>> = [];
    let serializedWrites = Promise.resolve();
    const workspace = {
      async release() {},
      id: "workspace_handle_123",
      workspace: {
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async uploadFiles() {},
        writeSandboxLog(entry: Record<string, unknown>) {
          const delayMs =
            entry.event === "capture-path-validation.demo-script.started"
              ? 30
              : 0;
          const write = serializedWrites.then(
            () =>
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  sandboxLogs.push(entry);
                  resolve();
                }, delayMs);
              }),
          );
          serializedWrites = write;
          return write;
        },
      },
    };

    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspace,
        demoScript: demoScript(),
      },
      {
        diagnosticsLogger: {
          async warn(entry) {
            fallbackWarnings.push(entry);
          },
        },
        diagnosticsWriteTimeoutMs: 50,
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded" as const,
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              logs: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
              ],
              status: "succeeded" as const,
            };
          },
        },
      },
    );

    expect(result.status).toBe("succeeded");
    await serializedWrites;
    expect(
      sandboxLogs.filter(
        (entry) =>
          entry.event === "capture-path-validation.demo-script.started",
      ),
    ).toHaveLength(1);
    expect(fallbackWarnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failedEvent: "capture-path-validation.demo-script.started",
        }),
      ]),
    );
  });

  it("writes verbose failure diagnostics through sandbox logs without the legacy diagnostics JSONL append", async () => {
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const executedCommands: string[] = [];

    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle(sandboxLogs, executedCommands),
        demoScript: demoScript(),
      },
      {
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              errorMessage:
                "Timed out waiting for locator('.article-preview') to be visible",
              failureReason:
                "Scene scene_validation failed during Capture Path Validation.",
              logs: [
                "stdout: loading page",
                "stderr: expect(locator('.article-preview')).toBeVisible timed out",
              ],
              runDirectory: ".makeademo-capture-path-validation-runs/run_123",
              scriptPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.ts",
              status: "failed",
              stderrPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.stderr.log",
              stdoutPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.stdout.log",
            };
          },
        },
      },
    );

    expect(result).toMatchObject({
      diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
      failedSceneId: "scene_validation",
      errorMessage:
        "Timed out waiting for locator('.article-preview') to be visible",
      failureReason:
        "Scene scene_validation failed during Capture Path Validation.",
      status: "failed",
    });
    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
          event: "capture-path-validation.scene.failed",
          errorMessage:
            "Timed out waiting for locator('.article-preview') to be visible",
          failureLogExcerpt: expect.stringContaining("article-preview"),
          sceneId: "scene_validation",
        }),
      ]),
    );
    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
          event: "capture-path-validation.scene.failed",
          logs: expect.arrayContaining([
            expect.stringContaining("article-preview"),
          ]),
        }),
      ]),
    );
    expect(executedCommands.join("\n")).not.toContain(
      "/workspace/.makeademo/capture-path-validation-diagnostics.jsonl",
    );
  });

  it("waits for returned verbose repair diagnostics to become durable before returning", async () => {
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const workspace = controlledVerboseDiagnosticsWorkspaceHandle(sandboxLogs);
    let settled = false;

    const validation = validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspace.handle,
        demoScript: demoScript(),
      },
      {
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              failureReason: "Scene scene_validation failed.",
              logs: ["stdout: before failure"],
              status: "failed",
            };
          },
        },
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    await workspace.verboseDiagnosticsStarted;
    await flushPromises();

    expect(settled).toBe(false);

    workspace.releaseVerboseDiagnostics?.();
    const result = await validation;

    expect(result).toMatchObject({
      diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
      status: "failed",
    });
    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "capture-path-validation.scene.failed",
          logs: ["stdout: before failure"],
        }),
      ]),
    );
  });

  it("logs a structured fallback when verbose diagnostics cannot be written", async () => {
    const fallbackWarnings: Array<Record<string, unknown>> = [];

    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: failingLogWorkspaceHandle(),
        demoScript: demoScript(),
      },
      {
        diagnosticsLogger: {
          async warn(entry) {
            fallbackWarnings.push(entry);
          },
        },
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: [],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              failureReason: "Scene scene_validation failed.",
              logs: ["stdout: before failure"],
              status: "failed",
            };
          },
        },
      },
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(fallbackWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
          diagnosticsSource: "capture-path-validation",
          error: "disk full",
          event: "capture-path-validation.diagnostics-log-write-failed",
          failedEvent: "capture-path-validation.scene.failed",
          stage: "capture-path-validation",
          workspaceId: "workspace_123",
        }),
      ]),
    );
  });

  it("does not block Capture Path Validation when fallback warning logging hangs", async () => {
    vi.useFakeTimers();
    const resultPromise = validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: failingLogWorkspaceHandle(),
        demoScript: demoScript(),
      },
      {
        diagnosticsLogger: {
          async warn() {
            await new Promise(() => {});
          },
        },
        diagnosticsWriteTimeoutMs: 100,
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: [],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              failureReason: "Scene scene_validation failed.",
              logs: ["stdout: before failure"],
              status: "failed",
            };
          },
        },
      },
    );

    await expect(
      resolveAfterCapturePathTimers(resultPromise),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("reports diagnostics write timeouts through fallback warning logging", async () => {
    vi.useFakeTimers();
    const fallbackWarnings: Array<Record<string, unknown>> = [];
    const resultPromise = validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: hangingLogWorkspaceHandle(),
        demoScript: demoScript(),
      },
      {
        diagnosticsLogger: {
          async warn(entry) {
            fallbackWarnings.push(entry);
          },
        },
        diagnosticsWriteTimeoutMs: 100,
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              logs: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
              ],
              status: "succeeded",
            };
          },
        },
      },
    );

    await expect(
      resolveAfterCapturePathTimers(resultPromise),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(fallbackWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error:
            "Capture Path Validation diagnostics log write timed out after 100ms.",
          event: "capture-path-validation.diagnostics-log-write-failed",
          failedEvent: "capture-path-validation.run.started",
          stage: "capture-path-validation",
          workspaceId: "workspace_123",
        }),
      ]),
    );
  });

  it("returns a repairable failure for Demo Scripts that bypass the generated Capture SDK contract", async () => {
    const script = demoScript({
      demoPlaywrightScript:
        "import { setup, scene } from './makeademo-capture-sdk';\nawait scene('scene_validation', async ({ page, expect }) => {\n  await page.context().newPage({ recordVideo: { dir: 'videos' } });\n  console.log('[makeademo:scene]', '{}');\n  await expect(page.locator('body')).toBeVisible();\n});",
    });
    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle([]),
        demoScript: script,
      },
      {
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: [],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            throw new Error("scene validator should not run");
          },
        },
      },
    );

    expect(result).toMatchObject({
      failureReason: expect.stringContaining(
        "Playwright recordVideo is owned by MakeADemo",
      ),
      status: "failed",
    });
  });

  it("returns a repairable failure for declared Scenes without visible assertions", async () => {
    const calls: string[] = [];
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const script = demoScript({
      demoPlaywrightScript:
        "import { setup, scene } from './makeademo-capture-sdk';\nawait scene('scene_validation', async ({ page }) => {\n  await page.getByRole('button', { name: 'Save' }).click();\n});",
    });

    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle(sandboxLogs),
        demoScript: script,
      },
      {
        async runRuntimePreflight() {
          calls.push("project-checks");
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: [],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            calls.push("scene-validation");
            throw new Error("scene validator should not run");
          },
        },
      },
    );

    expect(result).toMatchObject({
      diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
      failedSceneId: "scene_validation",
      failureReason:
        "Scene scene_validation must include a visible Playwright assertion before it ends.",
      status: "failed",
    });
    expect(calls).toEqual([]);
    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "capture-path-validation.demo-script.failed",
          failedSceneId: "scene_validation",
          failureReason:
            "Scene scene_validation must include a visible Playwright assertion before it ends.",
        }),
      ]),
    );
  });

  it("does not block Capture Path Validation when workspace log writes hang", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const calls: string[] = [];
    const resultPromise = validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: hangingLogWorkspaceHandle(),
        demoScript: demoScript(),
      },
      {
        diagnosticsWriteTimeoutMs: 100,
        async runRuntimePreflight() {
          calls.push("project-checks");
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            calls.push("scene-validation");
            return {
              logs: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
              ],
              status: "succeeded",
            };
          },
        },
      },
    );

    const result = await resolveAfterCapturePathTimers(resultPromise);

    expect(result).toMatchObject({ status: "succeeded" });
    expect(calls).toEqual(["project-checks", "scene-validation"]);
  });

  it("returns a repairable failure when the Demo Script dry-run times out", async () => {
    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle([]),
        demoScript: demoScript(),
      },
      {
        sceneValidationTimeoutMs: 1,
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return await new Promise<never>(() => {});
          },
        },
      },
    );

    expect(result).toMatchObject({
      browserUrl: "https://preview.example.test/",
      failedSceneId: "scene_validation",
      failureReason: "Demo Script dry-run timed out after 1ms.",
      logs: [
        "project checks passed",
        "Demo Script dry-run timed out after 1ms.",
      ],
      status: "failed",
    });
  });

  it("preserves a dry-run timeout result that settles after staging and provider evidence", async () => {
    vi.useFakeTimers();
    let sceneStarted = false;
    const resultPromise = validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle([]),
        demoScript: demoScript(),
      },
      {
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            sceneStarted = true;
            return await new Promise<{
              failureReason: string;
              logs: string[];
              status: "failed";
            }>((resolve) => {
              setTimeout(() => {
                resolve({
                  failureReason:
                    "Demo Script dry-run timed out after 120000ms.",
                  logs: ["sandbox exited 124 after returning evidence"],
                  status: "failed",
                });
              }, 145_000);
            });
          },
        },
      },
    );
    for (let index = 0; !sceneStarted && index < 100; index += 1) {
      await Promise.resolve();
    }
    expect(sceneStarted).toBe(true);

    vi.advanceTimersByTime(145_000);
    const result = await resultPromise;

    expect(result).toMatchObject({
      failureReason: "Demo Script dry-run timed out after 120000ms.",
      logs: [
        "project checks passed",
        "sandbox exited 124 after returning evidence",
      ],
      status: "failed",
    });
  });

  it.each([
    {
      expectedReason: "Capture Path emitted malformed Scene marker",
      logs: ['[makeademo:scene] {"event":"started"}'],
      name: "malformed marker",
    },
    {
      expectedReason:
        "Capture Path emitted undeclared Scene marker scene_extra.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_extra"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_extra"}',
      ],
      name: "undeclared marker",
    },
    {
      expectedReason: "Capture Path emitted nested Scene markers.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":11,"event":"started","sceneId":"scene_second"}',
      ],
      name: "nested markers",
    },
    {
      expectedReason:
        "Capture Path emitted duplicate Scene marker scene_validation.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":30,"event":"started","sceneId":"scene_validation"}',
      ],
      name: "duplicate markers",
    },
    {
      expectedReason:
        "Capture Path emitted succeeded marker before start for Scene scene_validation.",
      logs: [
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
      ],
      name: "out-of-order markers",
    },
    {
      expectedReason:
        "Scene scene_second did not emit complete Capture Path markers.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
      ],
      name: "uncovered declared scene",
    },
    {
      expectedReason:
        "Capture Path emitted Scene start marker without an end marker.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
      ],
      name: "missing terminal marker",
    },
  ])("rejects $name", async ({ expectedReason, logs }) => {
    const script = demoScript({
      demoPlaywrightScript: validTwoSceneDemoPlaywrightScript(),
      scenes: [
        {
          expectedVisibleOutcome: "Validation is visible.",
          humanReadableDescription: "Show validation.",
          id: "scene_validation",
        },
        {
          expectedVisibleOutcome: "Second scene is visible.",
          humanReadableDescription: "Show second scene.",
          id: "scene_second",
        },
      ],
    });
    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle([]),
        demoScript: script,
      },
      {
        async runRuntimePreflight() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: [],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return { logs, status: "succeeded" };
          },
        },
      },
    );

    expect(result).toMatchObject({
      failureReason: expect.stringContaining(expectedReason),
      status: "failed",
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

function demoScript(
  overrides: {
    demoPlaywrightScript?: string;
    scenes?: Array<{
      expectedVisibleOutcome: string;
      humanReadableDescription: string;
      id: string;
    }>;
  } = {},
) {
  return {
    demoPlaywrightScript:
      overrides.demoPlaywrightScript ??
      "import { setup, scene } from './makeademo-capture-sdk';\n\nawait setup(async ({ page, baseUrl, expect }) => {\n  await page.goto(baseUrl);\n  await expect(page.locator('body')).toBeVisible();\n});\nawait scene('scene_validation', async ({ page, expect }) => {\n  await expect(page.locator('body')).toBeVisible();\n});",
    format: "16:9",
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: overrides.scenes ?? [
      {
        expectedVisibleOutcome: "Validation is visible.",
        humanReadableDescription: "Show validation.",
        id: "scene_validation",
      },
    ],
    scriptId: "script_test",
    title: "Demo",
    version: 1,
  };
}

function validTwoSceneDemoPlaywrightScript() {
  return [
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });",
    "await scene('scene_validation', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
    "await scene('scene_second', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
  ].join("\n");
}

function workspaceHandle(
  logs: Array<Record<string, unknown>>,
  executedCommands: string[] = [],
) {
  return {
    async release() {},
    id: "workspace_handle_123",
    workspace: {
      async execute(command: string) {
        executedCommands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async uploadFiles() {},
      async writeSandboxLog(entry: Record<string, unknown>) {
        logs.push(entry);
      },
    },
  };
}

function hangingLogWorkspaceHandle() {
  return {
    async release() {},
    id: "workspace_handle_123",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async uploadFiles() {},
      async writeSandboxLog() {
        await new Promise(() => {});
      },
    },
  };
}

function failingLogWorkspaceHandle() {
  return {
    async release() {},
    id: "workspace_handle_123",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async uploadFiles() {},
      async writeSandboxLog() {
        throw new Error("disk full");
      },
    },
  };
}

function controlledVerboseDiagnosticsWorkspaceHandle(
  logs: Array<Record<string, unknown>>,
) {
  let releaseVerboseDiagnostics: (() => void) | undefined;
  let markVerboseDiagnosticsStarted!: () => void;
  const verboseDiagnosticsStarted = new Promise<void>((resolve) => {
    markVerboseDiagnosticsStarted = resolve;
  });
  return {
    get releaseVerboseDiagnostics() {
      return releaseVerboseDiagnostics;
    },
    verboseDiagnosticsStarted,
    handle: {
      async release() {},
      id: "workspace_handle_123",
      workspace: {
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async uploadFiles() {},
        async writeSandboxLog(entry: Record<string, unknown>) {
          if (
            entry.event === "capture-path-validation.scene.failed" &&
            "logs" in entry
          ) {
            markVerboseDiagnosticsStarted();
            await new Promise<void>((resolve) => {
              releaseVerboseDiagnostics = () => {
                logs.push(entry);
                resolve();
              };
            });
            return;
          }

          logs.push(entry);
        },
      },
    },
  };
}

async function flushPromises() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function resolveAfterCapturePathTimers<T>(resultPromise: Promise<T>) {
  let settled = false;
  const observedPromise = resultPromise.finally(() => {
    settled = true;
  });

  for (let index = 0; !settled && index < 20; index += 1) {
    vi.advanceTimersByTime(100);
    await flushPromises();
  }

  if (!settled) {
    throw new Error(
      "Capture Path Validation did not settle after draining fake timers.",
    );
  }

  return await observedPromise;
}
