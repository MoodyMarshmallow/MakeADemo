import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import { captureScenesFromScript } from "./capture-scenes";
import type { SceneRecorder } from "./scene-recorder.interface";

describe("captureScenesFromScript", () => {
  it("accepts a Demo Script with a continuous Playwright flow and declared Scenes without durations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const scriptPath = join(workspace, "script.json");
    const tempRoot = join(workspace, "runs");

    await writeFile(
      scriptPath,
      JSON.stringify({
        demoPlaywrightScript: [
          "import { scene, setup } from './makeademo-capture-sdk';",
          "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl); });",
          "await scene('scene-001', async ({ page }) => { await expect(page.locator('body')).toBeVisible(); });",
          "await scene('scene-002', async ({ page }) => { await expect(page.locator('body')).toBeVisible(); });",
        ].join("\n"),
        presentation: {
          music: { enabled: true, trackId: "clean" },
          textOverlays: [
            {
              content: "Demo Script",
              font: "Inter",
              position: "top-left",
              sceneId: "scene-001",
              size: "medium",
            },
          ],
          transitions: [
            {
              durationSeconds: 0.25,
              fromSceneId: "scene-001",
              style: "fade",
              toSceneId: "scene-002",
            },
          ],
        },
        scenes: [
          {
            humanReadableDescription: "Open the app.",
            expectedVisibleOutcome: "The prepared app shell is visible.",
            id: "scene-001",
          },
          {
            humanReadableDescription: "Click the main action.",
            expectedVisibleOutcome: "The main action result is visible.",
            id: "scene-002",
          },
        ],
        scriptId: "script-001",
        title: "Demo Script",
        version: 1,
        format: "16:9",
      }),
    );

    const recordedSceneIds: string[] = [];
    const recorder: SceneRecorder = {
      async recordScenes(input) {
        recordedSceneIds.push(...input.scenes.map((scene) => scene.id));
        return input.scenes.map((scene, sceneIndex) => ({
          durationSeconds: 4,
          markerEndMs: 2_000 + sceneIndex,
          markerStartMs: 1_000 + sceneIndex,
          sceneId: scene.id,
          sectionId: input.sectionId,
          videoPath: join(
            input.runDirectory,
            "scene-clips",
            `${scene.id}.webm`,
          ),
        }));
      },
    };

    const manifest = await captureScenesFromScript({
      baseUrl: "http://localhost:3000",
      recorder,
      scriptPath,
      tempRoot,
    });

    expect(recordedSceneIds).toEqual(["scene-001", "scene-002"]);
    expect(manifest.scriptId).toBe("script-001");
    expect(manifest.temporary).toBe(true);
    expect(manifest.scenes).toEqual([
      {
        durationSeconds: 4,
        markerEndMs: 2000,
        markerStartMs: 1000,
        sceneId: "scene-001",
        sectionId: "demo-script",
        videoPath: join(manifest.runDirectory, "scene-clips", "scene-001.webm"),
      },
      {
        durationSeconds: 4,
        markerEndMs: 2001,
        markerStartMs: 1001,
        sceneId: "scene-002",
        sectionId: "demo-script",
        videoPath: join(manifest.runDirectory, "scene-clips", "scene-002.webm"),
      },
    ]);
    expect(manifest.markerLogPath).toBe(
      join(manifest.runDirectory, "scene-markers.jsonl"),
    );
    expect(manifest.qualityFindings).toEqual([]);
    expect(manifest.rawTakePath).toBeUndefined();

    const manifestJson = JSON.parse(
      await readFile(manifest.manifestPath, "utf8"),
    ) as typeof manifest;
    expect(manifestJson).toEqual(manifest);
  });

  it("records the diagnostic raw take path only when capture retention is enabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const recorder: SceneRecorder = {
      async recordScenes(input) {
        return input.scenes.map((scene) => ({
          durationSeconds: 4,
          markerEndMs: 2_000,
          markerStartMs: 1_000,
          sceneId: scene.id,
          sectionId: input.sectionId,
          videoPath: join(
            input.runDirectory,
            "scene-clips",
            `${scene.id}.webm`,
          ),
        }));
      },
    };

    const manifest = await captureScenesFromScript({
      baseUrl: "http://localhost:3000",
      keepTemp: true,
      recorder,
      demoScript: validDemoScript(),
      tempRoot,
    });

    expect(manifest.rawTakePath).toBe(
      join(manifest.runDirectory, "raw-scenes", "continuous-take.webm"),
    );
  });

  it("runs Footage Capture scripts, trimming, and probing inside the prepared workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const executedCommands: string[] = [];
    const submittedCommands: string[] = [];
    const uploadedDestinations: string[] = [];
    const downloadedSources: string[] = [];
    const trimEvents: string[] = [];
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "daytona_workspace",
      workspace: {
        async downloadFiles() {
          throw new Error("parent download must not be used for scene files");
        },
        async downloadSubmittedCodeFiles(files) {
          downloadedSources.push(...files.map((file) => file.sourcePath));
          await Promise.all(
            files.map(async (file) => {
              await mkdir(dirname(file.destinationPath), { recursive: true });
              await writeFile(file.destinationPath, "downloaded video");
            }),
          );
        },
        async execute(command) {
          executedCommands.push(command);
          if (
            command.includes("bun ") ||
            command.includes("find ") ||
            command.includes("ffmpeg") ||
            command.includes("ffprobe") ||
            command.includes("continuous-take") ||
            command.includes("raw-scenes")
          ) {
            throw new Error(
              "outer workspace execution must not run capture commands",
            );
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(command) {
          submittedCommands.push(command);
          if (command.includes("find ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout:
                "/workspace/.makeademo/footage-capture-runs/capture-sandbox/work/continuous-take/playwright-videos/raw.webm\n",
            };
          }
          if (
            command.includes("ffprobe") &&
            command.includes("avg_frame_rate")
          ) {
            return { exitCode: 0, stderr: "", stdout: "25/1\n" };
          }
          if (command.includes("ffprobe")) {
            return { exitCode: 0, stderr: "", stdout: "1.240\n" };
          }
          if (command.includes("ssim")) {
            return {
              exitCode: 0,
              stderr: "SSIM Y:1.000000 U:1.000000 V:1.000000 All:1.000000",
              stdout: "",
            };
          }
          if (command.includes("bun ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: [
                '[makeademo:scene] {"elapsedMs":100,"event":"started","sceneId":"scene-001"}',
                '[makeademo:scene] {"elapsedMs":900,"event":"succeeded","sceneId":"scene-001"}',
              ].join("\n"),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async uploadFiles() {
          throw new Error("parent upload must not be used for scene files");
        },
        async uploadSubmittedCodeFiles(files) {
          uploadedDestinations.push(
            ...files.map((file) => file.destinationPath),
          );
        },
      },
    };

    const manifest = await captureScenesFromScript({
      baseUrl: "https://preview.example.test/",
      keepTemp: true,
      log: async (entry) => {
        trimEvents.push(entry.event);
      },
      preparationWorkspace,
      runId: "capture-sandbox",
      demoScript: validDemoScript(),
      tempRoot,
    });

    expect(manifest.scenes).toEqual([
      expect.objectContaining({
        durationSeconds: 1.24,
        markerEndMs: 900,
        markerStartMs: 100,
        sceneId: "scene-001",
        videoPath: join(manifest.runDirectory, "scene-clips", "scene-001.webm"),
      }),
    ]);
    expect(uploadedDestinations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/workspace/.makeademo/footage-capture-runs/capture-sandbox/work/continuous-take/demo-script.ts",
        ),
        expect.stringContaining("makeademo-capture-sdk.js"),
      ]),
    );
    expect(submittedCommands.join("\n")).toContain(
      "/workspace/.makeademo/footage-capture-runs/capture-sandbox",
    );
    expect(submittedCommands.join("\n")).toContain(
      "/opt/makeademo/playwright-runtime/node_modules",
    );
    expect(submittedCommands.join("\n")).not.toContain("npm root -g");
    expect(submittedCommands.join("\n")).toContain("ffmpeg");
    expect(submittedCommands.join("\n")).toContain("ffprobe");
    expect(submittedCommands.join("\n")).toContain("ssim");
    expect(submittedCommands.join("\n")).not.toContain("-c copy");
    expect(trimEvents).toEqual([
      "scene-clip-trim-started",
      "scene-clip-trim-succeeded",
    ]);
    expect(executedCommands.join("\n")).not.toContain("ffmpeg");
    expect(executedCommands.join("\n")).not.toContain("ffprobe");
    expect(downloadedSources).toEqual(
      expect.arrayContaining([
        expect.stringContaining("raw-scenes/continuous-take.webm"),
        expect.stringContaining("scene-clips/scene-001.webm"),
      ]),
    );
    await expect(
      readFile(
        join(manifest.runDirectory, "scene-clips", "scene-001.webm"),
        "utf8",
      ),
    ).resolves.toBe("downloaded video");
  });

  it("fails prepared-workspace Footage Capture before video discovery when runtime network is blocked", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const submittedCommands: string[] = [];
    const downloadedSources: string[] = [];
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "daytona_workspace",
      workspace: {
        async downloadFiles(files) {
          downloadedSources.push(...files.map((file) => file.sourcePath));
        },
        async execute() {
          throw new Error(
            "outer workspace execution must not run capture commands",
          );
        },
        async executeSubmittedCode(command) {
          submittedCommands.push(command);
          if (command.includes("bun ")) {
            return {
              exitCode: 0,
              stderr:
                '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime"}',
              stdout: "",
            };
          }
          if (
            command.includes("find ") ||
            command.includes("ffmpeg") ||
            command.includes("ffprobe")
          ) {
            throw new Error("post-network-block capture command must not run");
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async uploadFiles() {},
      },
    };

    await expect(
      captureScenesFromScript({
        baseUrl: "https://preview.example.test/",
        keepTemp: true,
        preparationWorkspace,
        runId: "capture-sandbox",
        demoScript: validDemoScript(),
        tempRoot,
      }),
    ).rejects.toThrow(
      "Footage Capture blocked runtime network access from the generated Demo Script: analytics.example.com",
    );
    expect(submittedCommands.join("\n")).toContain("bun ");
    expect(submittedCommands.join("\n")).not.toContain("ffmpeg");
    expect(submittedCommands.join("\n")).not.toContain("ffprobe");
    expect(downloadedSources).toEqual([]);
  });

  it("requires a prepared workspace when no explicit test recorder is injected", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        demoScript: validDemoScript(),
        tempRoot,
      }),
    ).rejects.toThrow(
      "Footage Capture requires a prepared workspace; local capture is not allowed.",
    );
  });

  it("stops before video discovery when the Demo Script command exits 124", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const submittedCommands: string[] = [];
    const downloadedSources: string[] = [];
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "daytona_workspace",
      workspace: {
        async downloadFiles() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async downloadSubmittedCodeFiles(files) {
          downloadedSources.push(...files.map((file) => file.sourcePath));
        },
        async executeSubmittedCode(command) {
          submittedCommands.push(command);
          if (command.includes("bun ")) {
            return { exitCode: 124, stderr: "command timed out", stdout: "" };
          }
          if (command.includes("find ") || command.includes("ffprobe")) {
            throw new Error("video discovery must not run after timeout");
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async uploadFiles() {},
        async uploadSubmittedCodeFiles() {},
      },
    };

    await expect(
      captureScenesFromScript({
        baseUrl: "https://preview.example.test/",
        preparationWorkspace,
        runId: "capture-sandbox",
        demoScript: validDemoScript(),
        tempRoot,
      }),
    ).rejects.toThrow("Scene continuous-take timed out.");
    expect(submittedCommands.join("\n")).not.toContain("find ");
    expect(submittedCommands.join("\n")).not.toContain("ffprobe");
    expect(downloadedSources).toEqual([]);
  });

  it("reports the declared Scene when capture emits incomplete markers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const submittedCommands: string[] = [];
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "daytona_workspace",
      workspace: {
        async downloadFiles() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async downloadSubmittedCodeFiles() {},
        async executeSubmittedCode(command) {
          submittedCommands.push(command);
          if (command.includes("bun ") || command.includes("continuous-take")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout:
                '[makeademo:scene] {"elapsedMs":100,"event":"started","sceneId":"scene-001"}',
            };
          }
          if (command.includes("find ") || command.includes("ffprobe")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: command.includes("find ") ? "/tmp/raw.webm\n" : "1.000\n",
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async uploadFiles() {},
        async uploadSubmittedCodeFiles() {},
      },
    };

    await expect(
      captureScenesFromScript({
        baseUrl: "https://preview.example.test/",
        preparationWorkspace,
        runId: "capture-sandbox",
        demoScript: validDemoScript(),
        tempRoot,
      }),
    ).rejects.toThrow(
      "Capture script emitted Scene start marker without an end marker for Scene scene-001.",
    );
  });

  it("rejects Demo Scripts with agent-authored recorded Scene durations before recording starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    let recordSceneWasCalled = false;

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        recorder: {
          async recordScenes() {
            recordSceneWasCalled = true;
            return [];
          },
        },
        demoScript: {
          demoPlaywrightScript: "await scene('scene-001', async () => {});",
          presentation: {
            music: { enabled: false },
            textOverlays: [],
            transitions: [],
          },
          scenes: [
            {
              humanReadableDescription: "Open the app.",
              durationSeconds: 4,
              expectedVisibleOutcome: "The app is visible.",
              id: "scene-001",
            },
          ],
          scriptId: "script-001",
          title: "Demo Script",
          version: 1,
          format: "16:9",
        },
        tempRoot,
      }),
    ).rejects.toThrow("scenes[0].durationSeconds is not allowed");

    expect(recordSceneWasCalled).toBe(false);
  });

  it("rejects malformed Demo Scripts before recording starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const scriptPath = join(workspace, "script.json");
    const tempRoot = join(workspace, "runs");
    let recordSceneWasCalled = false;

    await writeFile(
      scriptPath,
      JSON.stringify({
        scriptId: "script-001",
        title: "Demo Script",
        version: 1,
        format: "16:9",
        scenes: [],
      }),
    );

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        recorder: {
          async recordScenes() {
            recordSceneWasCalled = true;
            return [];
          },
        },
        scriptPath,
        tempRoot,
      }),
    ).rejects.toThrow("demoPlaywrightScript must be a non-empty string");

    expect(recordSceneWasCalled).toBe(false);
  });
});

function validDemoScript() {
  return {
    demoPlaywrightScript: [
      "import { scene, setup } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });",
      "await scene('scene-001', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
    ].join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        humanReadableDescription: "Open the app.",
        expectedVisibleOutcome: "The prepared app shell is visible.",
        id: "scene-001",
      },
    ],
    scriptId: "script-001",
    title: "Demo Script",
    version: 1,
  };
}
