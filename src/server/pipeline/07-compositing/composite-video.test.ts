import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PipelineCancellationError } from "../00-orchestration/job/pipeline-cancellation";
import type { DemoScript } from "../04-script-generation/demo-script/demo-script.schema";
import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import {
  type CompositedVideoManifest,
  compositeVideoFromScript,
} from "./composite-video";
import type {
  CompositingRenderPlan,
  VideoRenderer,
} from "./video-renderer.interface";

describe("compositeVideoFromScript", () => {
  it("settles an in-flight renderer before propagating cooperative cancellation", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const capturedScenePath = join(workspace, "scene-feed.webm");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    await writeFile(capturedScenePath, "captured scene");
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 1.25,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );
    let renderStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      renderStarted = resolve;
    });
    const renderer: VideoRenderer = {
      renderVideo(_input, ...args: unknown[]) {
        const signal = (args[0] as { signal?: AbortSignal } | undefined)
          ?.signal;
        renderStarted?.();
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };
    const controller = new AbortController();
    const compositing = compositeVideoFromScript({
      captureManifestPath,
      demoScript: makeDemoScript(),
      outputRoot: join(workspace, "renders"),
      renderer,
      signal: controller.signal,
    } as Parameters<typeof compositeVideoFromScript>[0]);

    await started;
    controller.abort(new PipelineCancellationError("signal"));

    const outcome = await Promise.race([
      compositing.catch((error: unknown) => error),
      new Promise<"still-running">((resolve) =>
        setTimeout(() => resolve("still-running"), 50),
      ),
    ]);
    expect(outcome).toMatchObject({ reason: "signal" });
  });

  it("stages Demo Script scenes using captured clip durations and presentation metadata", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const capturedFeedPath = join(workspace, "scene-feed.webm");
    const capturedEditorPath = join(workspace, "scene-editor.webm");
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");

    await writeFile(capturedFeedPath, "captured feed");
    await writeFile(capturedEditorPath, "captured editor");
    await writeFile(
      scriptPath,
      JSON.stringify(
        makeDemoScript({ sceneIds: ["scene-feed", "scene-editor"] }),
      ),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 1.25,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedFeedPath,
            },
            {
              durationSeconds: 2.75,
              sceneId: "scene-editor",
              sectionId: "demo-script",
              videoPath: capturedEditorPath,
            },
          ],
        }),
      ),
    );

    let renderPlan: CompositingRenderPlan | undefined;
    const renderer: VideoRenderer = {
      async renderVideo(input) {
        renderPlan = input;
        await writeFile(input.outputPath, "rendered mp4");
      },
    };

    const manifest = await compositeVideoFromScript({
      captureManifestPath,
      outputRoot,
      renderer,
      runId: "composite-001",
      scriptPath,
    });

    expect(renderPlan).toMatchObject({
      compositionId: "MakeADemoVideo",
      durationInFrames: 121,
      fps: 30,
      height: 720,
      outputPath: join(outputRoot, "composite-001", "draft-composite.mp4"),
      scriptId: "script-001",
      title: "Generated Demo",
      width: 1280,
    });
    expect(renderPlan?.scenes).toMatchObject([
      {
        durationFrames: 38,
        sceneId: "scene-feed",
        sourcePublicPath: "scenes/scene-feed.webm",
        text: {
          content: "Browse the live feed",
          fontFamily: "Inter",
          position: "top-left",
          size: "medium",
        },
        type: "playwright-recording",
      },
      {
        durationFrames: 83,
        sceneId: "scene-editor",
        sourcePublicPath: "scenes/scene-editor.webm",
        transition: { durationFrames: 9, in: "fade", out: "fade" },
        type: "playwright-recording",
      },
    ]);
    expect(renderPlan?.fontAssets).toMatchObject({
      Inter: { publicPath: "fonts/Inter-VariableFont_opsz,wght.ttf" },
    });
    expect(renderPlan?.music).toMatchObject({
      id: "focus",
      publicPath: "music/focus.mp3",
    });
    await expect(
      stat(join(renderPlan?.publicDir ?? "", "scenes/scene-feed.webm")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(renderPlan?.publicDir ?? "", "scenes/scene-editor.webm")),
    ).resolves.toBeTruthy();

    expect(manifest).toMatchObject({
      manifestPath: join(
        outputRoot,
        "composite-001",
        "composite-manifest.json",
      ),
      outputVideoPath: join(outputRoot, "composite-001", "draft-composite.mp4"),
      runDirectory: join(outputRoot, "composite-001"),
      runId: "composite-001",
      scriptId: "script-001",
      title: "Generated Demo",
      viewUrl: expect.stringContaining("draft-composite.mp4"),
    } satisfies Partial<CompositedVideoManifest>);
    expect(JSON.parse(await readFile(manifest.manifestPath, "utf8"))).toEqual(
      manifest,
    );
  });

  it("rejects a Demo Script when captured footage is missing for a declared Scene", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    let renderWasCalled = false;

    await writeFile(scriptPath, JSON.stringify(makeDemoScript()));
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            renderWasCalled = true;
          },
        },
        scriptPath,
      }),
    ).rejects.toThrow(
      "missing captured Scene for Demo Script Scene scene-feed",
    );

    expect(renderWasCalled).toBe(false);
  });

  it("rejects agent-authored recorded Scene durations instead of using them for Compositing", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    let renderWasCalled = false;

    await writeFile(capturedScenePath, "captured scene");
    await writeFile(
      scriptPath,
      JSON.stringify({
        ...makeDemoScript(),
        scenes: [{ ...makeDemoScript().scenes[0], durationSeconds: 99 }],
      }),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 1.25,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            renderWasCalled = true;
          },
        },
        scriptPath,
      }),
    ).rejects.toThrow("scenes[0].durationSeconds is not allowed");

    expect(renderWasCalled).toBe(false);
  });
});

function makeDemoScript(input: { sceneIds?: string[] } = {}): DemoScript {
  const sceneIds = input.sceneIds ?? ["scene-feed"];

  return {
    demoPlaywrightScript: sceneIds
      .map((sceneId) => `await scene('${sceneId}', async () => {});`)
      .join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "focus" },
      textOverlays: [
        {
          content: "Browse the live feed",
          font: "Inter",
          position: "top-left",
          sceneId: sceneIds[0] ?? "scene-feed",
          size: "medium",
        },
      ],
      transitions:
        sceneIds.length > 1
          ? [
              {
                durationSeconds: 0.3,
                fromSceneId: sceneIds[0] as string,
                style: "fade",
                toSceneId: sceneIds[1] as string,
              },
            ]
          : [],
    },
    scenes: sceneIds.map((sceneId) => ({
      expectedVisibleOutcome: `${sceneId} is visible`,
      humanReadableDescription: `Show ${sceneId}`,
      id: sceneId,
    })),
    scriptId: "script-001",
    title: "Generated Demo",
    version: 1,
  };
}

function makeCaptureManifest(input: {
  manifestPath: string;
  runDirectory: string;
  scenes: CaptureManifest["scenes"];
}): CaptureManifest {
  return {
    baseUrl: "http://localhost:3000",
    createdAt: "2026-06-06T12:00:00.000Z",
    keepTemp: true,
    manifestPath: input.manifestPath,
    qualityFindings: [],
    runDirectory: input.runDirectory,
    runId: "capture-001",
    scenes: input.scenes,
    scriptId: "script-001",
    temporary: true,
    title: "Generated Demo",
  };
}
