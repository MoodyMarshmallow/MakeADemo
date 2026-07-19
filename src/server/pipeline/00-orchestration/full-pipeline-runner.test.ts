import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "../07-compositing/composite-video";
import { runFullPipelineJob } from "./full-pipeline-runner";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

describe("runFullPipelineJob", () => {
  it("runs the pipeline, captures prepared scenes from the local app URL, and composites the final video", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const calls: string[] = [];
    const cleanupEvents: string[] = [];
    const preparationWorkspace = fakePreparationWorkspaceHandle();
    preparationWorkspace.release = async () => {
      cleanupEvents.push("release");
    };

    try {
      const result = await runFullPipelineJob(
        fullPipelineInput(),
        orchestratorDependencies(calls, undefined, preparationWorkspace),
        {
          async captureScenes(input) {
            calls.push(`capture:${input.baseUrl}`);
            const manifest: CaptureManifest = {
              baseUrl: input.baseUrl,
              createdAt: "2026-01-01T00:00:00.000Z",
              keepTemp: true,
              manifestPath: join(outputRoot, "capture-manifest.json"),
              qualityFindings: [],
              runDirectory: outputRoot,
              runId: "capture",
              scenes: [],
              scriptId: "script_test",
              temporary: true,
              title: "Demo",
            };

            return manifest;
          },
          async compositeVideo(input) {
            calls.push(`composite:${input.captureManifestPath}`);
            expect(input.scriptPath).toBeDefined();
            expect(
              JSON.parse(await readFile(input.scriptPath as string, "utf8")),
            ).toMatchObject({ scriptId: "script_test" });
            const manifest: CompositedVideoManifest = {
              createdAt: "2026-01-01T00:00:00.000Z",
              durationInFrames: 150,
              fps: 30,
              manifestPath: join(outputRoot, "composite-manifest.json"),
              outputVideoPath: join(outputRoot, "final-video.mp4"),
              renderPlanPath: join(outputRoot, "render-plan.json"),
              runDirectory: outputRoot,
              runId: "composite",
              scriptId: "script_test",
              title: "Demo",
              viewUrl: "file:///tmp/final-video.mp4",
            };

            return manifest;
          },
          outputRoot,
          async prepareFreshCaptureState(input) {
            calls.push(`fresh-capture:${input.browserUrl}`);
            return { browserUrl: "https://fresh-preview.example.test/" };
          },
          onLog(entry) {
            cleanupEvents.push(`log:${entry.event}`);
          },
          rawOpenCodeLogPath: join(
            outputRoot,
            "full-run",
            "opencode-raw-output.jsonl",
          ),
          async reviewDraftComposite(input) {
            calls.push(`review:${input.attempt}:${input.opencodeSessionID}`);
            return acceptDraftComposite();
          },
          runId: "full-run",
        },
      );

      expect(calls).toEqual([
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture-path-validation",
        "fresh-capture:https://preview.example.test/",
        "capture:http://localhost:3000/",
        `composite:${join(outputRoot, "capture-manifest.json")}`,
        "review:1:session_prepare_123",
      ]);
      expect(cleanupEvents.indexOf("release")).toBeGreaterThan(
        cleanupEvents.indexOf("log:result-written"),
      );
      expect(cleanupEvents).toEqual(
        expect.arrayContaining([
          "log:preparation-workspace-cleanup.started",
          "log:preparation-workspace-cleanup.succeeded",
        ]),
      );
      expect(result.status).toBe("succeeded");
      expect(result.finalVideo.outputVideoPath).toBe(
        join(outputRoot, "final-video.mp4"),
      );
      expect(result.resultPath).toBe(
        join(outputRoot, "full-run", "full-pipeline-result.json"),
      );
      await expect(readJsonFile(result.resultPath)).resolves.toMatchObject({
        artifacts: {
          captureManifestPath: join(outputRoot, "capture-manifest.json"),
          finalVideoPath: join(outputRoot, "final-video.mp4"),
          generatedScriptPath: join(outputRoot, "full-run", "demo-script.json"),
          logPath: join(outputRoot, "full-run", "pipeline-log.jsonl"),
          rawOpenCodeLogPath: join(
            outputRoot,
            "full-run",
            "opencode-raw-output.jsonl",
          ),
        },
        status: "succeeded",
      });
      expect(result.sandboxLogPath).toBeUndefined();
      await expect(readJsonFile(result.resultPath)).resolves.not.toMatchObject({
        artifacts: { sandboxLogPath: expect.any(String) },
      });
      expect(result.logPath).toBe(
        join(outputRoot, "full-run", "pipeline-log.jsonl"),
      );
      await expect(
        stat(join(outputRoot, "full-run", "demo-script.json")),
      ).resolves.toMatchObject({ isFile: expect.any(Function) });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("reports the sandbox log artifact only when a local sink path is configured", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const sandboxLogPath = join(outputRoot, "full-run", "sandbox-log.jsonl");
    const cleanupEvents: string[] = [];
    const preparationWorkspace = fakePreparationWorkspaceHandle();
    preparationWorkspace.release = async () => {
      throw new Error("provider cleanup unavailable");
    };

    try {
      const result = await runFullPipelineJob(
        fullPipelineInput(),
        orchestratorDependencies([], undefined, preparationWorkspace),
        {
          async captureScenes(input) {
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            return compositeManifest(outputRoot, input.runId ?? "composite");
          },
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          onLog(entry) {
            cleanupEvents.push(entry.event);
          },
          outputRoot,
          reviewDraftComposite: acceptDraftComposite,
          runId: "full-run",
          sandboxLogPath,
        },
      );

      expect(result.sandboxLogPath).toBe(sandboxLogPath);
      await expect(readJsonFile(result.resultPath)).resolves.toMatchObject({
        artifacts: { sandboxLogPath },
        status: "succeeded",
      });
      expect(cleanupEvents).toContain("preparation-workspace-cleanup.failed");
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("stores the generated script on the Demo Request when durable script persistence is configured", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const savedScripts: unknown[] = [];

    try {
      const result = await runFullPipelineJob(
        fullPipelineInput(),
        orchestratorDependencies([]),
        {
          async captureScenes(input) {
            expect(input.scriptPath).toBeUndefined();
            expect(input.scriptPackage).toMatchObject({
              scriptId: "script_test",
            });
            return {
              baseUrl: input.baseUrl,
              createdAt: "2026-01-01T00:00:00.000Z",
              keepTemp: true,
              manifestPath: join(outputRoot, "capture-manifest.json"),
              qualityFindings: [],
              runDirectory: outputRoot,
              runId: "capture",
              scenes: [],
              scriptId: "script_test",
              temporary: true,
              title: "Demo",
            };
          },
          async compositeVideo(input) {
            expect(input.scriptPath).toBeUndefined();
            expect(input.scriptPackage).toMatchObject({
              scriptId: "script_test",
            });
            return {
              createdAt: "2026-01-01T00:00:00.000Z",
              durationInFrames: 150,
              fps: 30,
              manifestPath: join(outputRoot, "composite-manifest.json"),
              outputVideoPath: join(outputRoot, "final-video.mp4"),
              renderPlanPath: join(outputRoot, "render-plan.json"),
              runDirectory: outputRoot,
              runId: "composite",
              scriptId: "script_test",
              title: "Demo",
              viewUrl: "file:///tmp/final-video.mp4",
            };
          },
          context: {
            demoRequestId: "demo-request-123",
            projectId: "project-123",
          },
          demoRequestScriptStore: {
            async saveGeneratedScript(input) {
              savedScripts.push(input);
            },
          },
          outputRoot,
          reviewDraftComposite: acceptDraftComposite,
          runId: "full-run",
        },
      );

      expect(savedScripts).toEqual([
        {
          demoRequestId: "demo-request-123",
          script: expect.objectContaining({
            scriptId: "script_test",
            title: "Demo",
          }),
        },
      ]);
      expect(result.scriptPath).toBeUndefined();
      await expect(
        stat(join(outputRoot, "full-run", "demo-script.json")),
      ).rejects.toThrow();
      await expect(readJsonFile(result.resultPath)).resolves.toMatchObject({
        artifacts: {
          generatedScriptDemoRequestId: "demo-request-123",
        },
        status: "succeeded",
      });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("fails before capture when Capture Path Validation did not produce a browser URL", async () => {
    const preparationWorkspace = fakePreparationWorkspaceHandle();
    let destroyCount = 0;
    preparationWorkspace.release = async () => {
      destroyCount += 1;
    };
    await expect(
      runFullPipelineJob(
        fullPipelineInput(),
        orchestratorDependencies(
          [],
          { includeBrowserUrl: false },
          preparationWorkspace,
        ),
        {
          async captureScenes() {
            throw new Error("capture should not run");
          },
          async compositeVideo() {
            throw new Error("compositing should not run");
          },
        },
      ),
    ).rejects.toThrow(
      "Capture Path Validation succeeded without a browser URL.",
    );
    expect(destroyCount).toBe(1);
  });

  it("preserves the downstream failure when preparation cleanup also fails", async () => {
    const preparationWorkspace = fakePreparationWorkspaceHandle();
    preparationWorkspace.release = async () => {
      throw new Error("cleanup failed");
    };

    await expect(
      runFullPipelineJob(
        fullPipelineInput(),
        orchestratorDependencies(
          [],
          { includeBrowserUrl: false },
          preparationWorkspace,
        ),
      ),
    ).rejects.toThrow(
      "Capture Path Validation succeeded without a browser URL.",
    );
  });

  it("fails default Footage Capture when no fresh-state reset is configured", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));

    try {
      await expect(
        runFullPipelineJob(fullPipelineInput(), orchestratorDependencies([]), {
          async reviewDraftComposite() {
            return acceptDraftComposite();
          },
          outputRoot,
          runId: "full-run",
        }),
      ).rejects.toThrow(
        "Footage Capture requires a fresh deterministic app-state reset before recording.",
      );
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("writes a local result file with failure details when the pipeline fails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));

    try {
      let thrown: unknown;
      try {
        await runFullPipelineJob(
          fullPipelineInput(),
          {
            async generateScriptPackage() {
              throw new Error("script generation should not run");
            },
            async prepareRepo() {
              return {
                fallbackPrompt:
                  "Repo Preparation agent timed out after 600000ms. Inspect the retained Daytona workspace debug log.",
                status: "failed",
              };
            },
            screenRepoSecurity() {
              return { rejections: [], status: "passed", warnings: [] };
            },
            async validateCapturePath() {
              throw new Error("capture path validation should not run");
            },
          },
          {
            outputRoot,
            rawOpenCodeLogPath: join(
              outputRoot,
              "failed-run",
              "opencode-raw-output.jsonl",
            ),
            runId: "failed-run",
          },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        failure: {
          blockers: [
            "Repo Preparation agent timed out after 600000ms. Inspect the retained Daytona workspace debug log.",
          ],
          suggestedChanges: [],
        },
        logPath: join(outputRoot, "failed-run", "pipeline-log.jsonl"),
        rawOpenCodeLogPath: join(
          outputRoot,
          "failed-run",
          "opencode-raw-output.jsonl",
        ),
        resultPath: join(outputRoot, "failed-run", "full-pipeline-result.json"),
        stage: "pipeline",
        status: "preparation-failed",
      });

      await expect(
        readJsonFile(
          join(outputRoot, "failed-run", "full-pipeline-result.json"),
        ),
      ).resolves.toMatchObject({
        artifacts: {
          logPath: join(outputRoot, "failed-run", "pipeline-log.jsonl"),
          rawOpenCodeLogPath: join(
            outputRoot,
            "failed-run",
            "opencode-raw-output.jsonl",
          ),
        },
        failure: {
          blockers: [
            "Repo Preparation agent timed out after 600000ms. Inspect the retained Daytona workspace debug log.",
          ],
          suggestedChanges: [],
        },
        status: "preparation-failed",
      });

      const logEntries = (
        await readFile(
          join(outputRoot, "failed-run", "pipeline-log.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logEntries).toContainEqual(
        expect.objectContaining({
          event: "pipeline-failed",
          level: "error",
          status: "preparation-failed",
        }),
      );
      expect(logEntries).toContainEqual(
        expect.objectContaining({
          event: "stage-progress",
          level: "error",
          stage: "repo-preparation",
          status: "failed",
        }),
      );
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("reports Capture Path Validation exhaustion as a MakeADemo issue instead of preparation advice", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousRepairAttempts =
      process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS;
    process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS = "0";

    try {
      await expect(
        runFullPipelineJob(
          fullPipelineInput(),
          {
            ...orchestratorDependencies([]),
            async validateCapturePath() {
              return {
                blockedNetworkAttempts: [],
                browserUrl: "https://preview.example.test/",
                diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
                failedAction: "locator.click(getByRole(button, Save))",
                failedSceneId: "scene_article_feed",
                failureReason: "Generated selector did not match.",
                logs: ["selector failed"],
                runDirectory:
                  "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed",
                scriptPath:
                  "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed/scene_article_feed.ts",
                status: "failed",
                stderrPath:
                  "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed/scene_article_feed.stderr.log",
                stdoutPath:
                  "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed/scene_article_feed.stdout.log",
                warnings: ["Retry with more seeded data."],
              };
            },
          },
          {
            async captureScenes() {
              throw new Error("capture should not run");
            },
            async compositeVideo() {
              throw new Error("compositing should not run");
            },
            outputRoot,
            runId: "capture-path-fails",
          },
        ),
      ).rejects.toThrow(
        "Pipeline failed with status capture-path-validation-failed",
      );

      await expect(
        readJsonFile(
          join(outputRoot, "capture-path-fails", "full-pipeline-result.json"),
        ),
      ).resolves.toMatchObject({
        failure: {
          blockers: [
            "Capture Path Validation failed. Please report this issue to MakeADemo.",
            "Capture Path Validation reason: Generated selector did not match.",
          ],
          capturePathValidation: {
            diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
            failedAction: "locator.click(getByRole(button, Save))",
            failedSceneId: "scene_article_feed",
            failureReason: "Generated selector did not match.",
            runDirectory:
              "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed",
            scriptPath:
              "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed/scene_article_feed.ts",
            stderrPath:
              "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed/scene_article_feed.stderr.log",
            stdoutPath:
              "/workspace/.makeademo/capture-path-validation-runs/run/scene_article_feed/scene_article_feed.stdout.log",
          },
          suggestedChanges: ["Retry with more seeded data."],
        },
        status: "capture-path-validation-failed",
      });
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
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("does not expose partial-pipeline artifacts when Script Generation fails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));

    try {
      await expect(
        runFullPipelineJob(
          fullPipelineInput(),
          {
            async generateScriptPackage() {
              throw new Error("ScriptGen stalled before artifact output");
            },
            async prepareRepo() {
              return {
                manifest: {
                  assumptions: [],
                  createdFiles: [],
                  demoCommand: "npm run demo",
                  diffArtifactId: "diff",
                  existingDemoEvidence: [],
                  mockedServices: [],
                  modifiedFiles: [],
                  repoUrl: "https://github.com/example/app",
                  risks: [],
                  scriptGenerationContext: [],
                  setupSummary: "Prepared app.",
                  status: "adapted-existing-demo",
                  url: "http://localhost:3000/",
                  workspaceId: "workspace_123",
                },
                opencodeSessionID: "session_prepare_123",
                status: "succeeded",
                workspace: fakePreparationWorkspaceHandle(),
              };
            },
            screenRepoSecurity() {
              return { rejections: [], status: "passed", warnings: [] };
            },
            async validateCapturePath() {
              throw new Error(
                "capture path validation should not run after script generation fails",
              );
            },
          },
          { outputRoot, runId: "scriptgen-fails" },
        ),
      ).rejects.toThrow("ScriptGen stalled before artifact output");

      await expect(
        readdir(join(outputRoot, "scriptgen-fails")),
      ).resolves.toEqual(["pipeline-log.jsonl"]);
      const logEntries = (
        await readFile(
          join(outputRoot, "scriptgen-fails", "pipeline-log.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        logEntries.filter((entry) => entry.event === "pipeline-failed"),
      ).toEqual([
        expect.objectContaining({
          error: "ScriptGen stalled before artifact output",
          level: "error",
          message: "Full pipeline failed unexpectedly.",
        }),
      ]);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("writes the full pipeline progress to the log callback and JSONL log file", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const messages: string[] = [];

    try {
      const result = await runFullPipelineJob(
        fullPipelineInput(),
        orchestratorDependencies([]),
        {
          async captureScenes(input) {
            return {
              baseUrl: input.baseUrl,
              createdAt: "2026-01-01T00:00:00.000Z",
              keepTemp: true,
              manifestPath: join(outputRoot, "capture-manifest.json"),
              qualityFindings: [],
              runDirectory: outputRoot,
              runId: "capture",
              scenes: [
                {
                  durationSeconds: 5,
                  sceneId: "scene_article_feed",
                  sectionId: "demo-script",
                  videoPath: join(outputRoot, "scene.webm"),
                },
              ],
              scriptId: "script_test",
              temporary: true,
              title: "Demo",
            };
          },
          async compositeVideo() {
            return {
              createdAt: "2026-01-01T00:00:00.000Z",
              durationInFrames: 150,
              fps: 30,
              manifestPath: join(outputRoot, "composite-manifest.json"),
              outputVideoPath: join(outputRoot, "final-video.mp4"),
              renderPlanPath: join(outputRoot, "render-plan.json"),
              runDirectory: outputRoot,
              runId: "composite",
              scriptId: "script_test",
              title: "Demo",
              viewUrl: "file:///tmp/final-video.mp4",
            };
          },
          onLog: (entry) => messages.push(entry.message),
          outputRoot,
          reviewDraftComposite: acceptDraftComposite,
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          runId: "full-run",
        },
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          "Full pipeline started.",
          "repo-security-screen started.",
          "repo-preparation started.",
          "script-generation succeeded.",
          "capture-path-validation succeeded.",
          "Accepted Demo Script ready: 1 scene(s).",
          "Footage Capture started.",
          "Footage Capture succeeded: 1 scene video(s).",
          "Compositing started.",
          "Compositing succeeded.",
          "Full pipeline succeeded.",
        ]),
      );

      const logEntries = (await readFile(result.logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(logEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "demo-script-written",
            message: "Accepted Demo Script ready: 1 scene(s).",
            scriptPath: result.scriptPath,
          }),
          expect.objectContaining({
            event: "capture-succeeded",
            durationMs: expect.any(Number),
            artifacts: expect.objectContaining({
              manifestPath: join(outputRoot, "capture-manifest.json"),
            }),
            manifestPath: join(outputRoot, "capture-manifest.json"),
            sceneCount: 1,
          }),
          expect.objectContaining({
            event: "compositing-succeeded",
            durationMs: expect.any(Number),
            artifacts: expect.objectContaining({
              manifestPath: join(outputRoot, "composite-manifest.json"),
              outputVideoPath: join(outputRoot, "final-video.mp4"),
              renderPlanPath: join(outputRoot, "render-plan.json"),
            }),
            outputVideoPath: join(outputRoot, "final-video.mp4"),
            viewUrl: "file:///tmp/final-video.mp4",
          }),
          expect.objectContaining({
            event: "draft-composite-evidence-succeeded",
            durationMs: expect.any(Number),
            artifacts: expect.objectContaining({
              captureManifestPath: join(outputRoot, "capture-manifest.json"),
              compositeManifestPath: join(
                outputRoot,
                "composite-manifest.json",
              ),
            }),
            failedSceneProbeCount: 0,
            staticSceneCount: 0,
          }),
          expect.objectContaining({
            event: "draft-composite-reviewer-succeeded",
            attempt: 1,
            durationMs: expect.any(Number),
            artifacts: expect.objectContaining({
              captureManifestPath: join(outputRoot, "capture-manifest.json"),
              compositeManifestPath: join(
                outputRoot,
                "composite-manifest.json",
              ),
            }),
          }),
          expect.objectContaining({
            event: "capture-succeeded",
            manifestPath: join(outputRoot, "capture-manifest.json"),
            sceneCount: 1,
          }),
          expect.objectContaining({
            event: "compositing-succeeded",
            outputVideoPath: join(outputRoot, "final-video.mp4"),
            viewUrl: "file:///tmp/final-video.mp4",
          }),
          expect.objectContaining({
            event: "result-written",
            message: "Full pipeline result written.",
            resultPath: result.resultPath,
          }),
        ]),
      );
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});

function fullPipelineInput() {
  return {
    demoBrief: { keyProductFeatures: ["article feed"] },
    normalizedSupportingDocuments: [],
    repoSecurity: {
      files: [{ path: "package.json", text: "{}" }],
      repoStats: { fileCount: 1, sizeBytes: 100 },
    },
    repoUrl: "https://github.com/example/app",
    workspaceId: "workspace_123",
  };
}

function orchestratorDependencies(
  calls: string[],
  options: { includeBrowserUrl?: boolean; musicEnabled?: boolean } = {
    includeBrowserUrl: true,
    musicEnabled: false,
  },
  preparationWorkspace = fakePreparationWorkspaceHandle(),
): PipelineOrchestratorDependencies {
  return {
    async generateScriptPackage() {
      calls.push("script-generation");
      return {
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Show the article feed.",
          risks: [],
        },
        demoPlaywrightScript:
          "import { setup, scene } from './makeademo-capture-sdk';\nawait setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });\nawait scene('scene_article_feed', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
        exploration: {
          assumptions: [],
          productSurfaces: ["article feed"],
          summary: "Prepared app.",
        },
        format: "16:9",
        presentation: {
          music: options.musicEnabled
            ? { enabled: true as const, trackId: "focus" as const }
            : { enabled: false as const },
          textOverlays: [],
          transitions: [],
        },
        scenes: [
          {
            expectedVisibleOutcome: "The article feed is visible.",
            humanReadableDescription: "Show article feed.",
            id: "scene_article_feed",
          },
        ],
        scriptId: "script_test",
        title: "Demo",
        version: 1,
      };
    },
    async prepareRepo() {
      calls.push("repo-preparation");
      return {
        manifest: {
          assumptions: [],
          createdFiles: [],
          demoCommand: "npm run demo",
          diffArtifactId: "diff",
          existingDemoEvidence: [],
          mockedServices: [],
          modifiedFiles: [],
          repoUrl: "https://github.com/example/app",
          risks: [],
          scriptGenerationContext: [],
          setupSummary: "Prepared app.",
          status: "adapted-existing-demo",
          url: "http://localhost:3000/",
          workspaceId: "workspace_123",
        },
        opencodeSessionID: "session_prepare_123",
        status: "succeeded",
        workspace: preparationWorkspace,
      };
    },
    screenRepoSecurity() {
      calls.push("repo-security-screen");
      return { rejections: [], status: "passed", warnings: [] };
    },
    async validateCapturePath() {
      calls.push("capture-path-validation");
      return {
        blockedNetworkAttempts: [],
        ...(options.includeBrowserUrl === false
          ? {}
          : { browserUrl: "https://preview.example.test/" }),
        logs: ["validated capture path"],
        status: "succeeded",
        warnings: [],
      };
    },
  };
}

function fakePreparationWorkspaceHandle() {
  return {
    async release() {},
    id: "daytona_workspace",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

function captureManifest(outputRoot: string, runId: string): CaptureManifest {
  return {
    baseUrl: "https://preview.example.test/",
    createdAt: "2026-01-01T00:00:00.000Z",
    keepTemp: true,
    manifestPath: join(outputRoot, `${runId}-capture-manifest.json`),
    qualityFindings: [],
    rawTakePath: join(outputRoot, `${runId}-raw.webm`),
    runDirectory: outputRoot,
    runId,
    scenes: [
      {
        durationSeconds: 5,
        sceneId: "scene_article_feed",
        sectionId: "demo-script",
        videoPath: join(outputRoot, `${runId}.webm`),
      },
    ],
    scriptId: "script_test",
    temporary: true,
    title: "Demo",
  };
}

function compositeManifest(
  outputRoot: string,
  runId: string,
): CompositedVideoManifest {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    durationInFrames: 150,
    fps: 30,
    manifestPath: join(outputRoot, `${runId}-composite-manifest.json`),
    outputVideoPath: join(outputRoot, `${runId}.mp4`),
    renderPlanPath: join(outputRoot, `${runId}-render-plan.json`),
    runDirectory: outputRoot,
    runId,
    scriptId: "script_test",
    title: "Demo",
    viewUrl: `file:///tmp/${runId}.mp4`,
  };
}

function cleanDraftEvidence() {
  return {
    audioPresent: true,
    contactSheetPaths: [],
    ffmpegFindings: [],
    sampledFramePaths: [],
    staticProbeFailedSceneIds: [],
    staticSceneIds: [],
  };
}

async function acceptDraftComposite() {
  return { decision: "accept" as const, reason: "Test draft accepted." };
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
