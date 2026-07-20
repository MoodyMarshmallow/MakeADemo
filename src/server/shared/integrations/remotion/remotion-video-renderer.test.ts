import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompositingRenderPlan } from "../../../pipeline/07-compositing/video-renderer.interface";

const remotion = vi.hoisted(() => ({
  bundle: vi.fn(async () => "serve-url"),
  makeCancelSignal: vi.fn(() => {
    let cancelRender: (() => void) | undefined;
    return {
      cancel: () => cancelRender?.(),
      cancelSignal: (callback: () => void) => {
        cancelRender = callback;
      },
    };
  }),
  renderMedia: vi.fn(async () => undefined),
  selectComposition: vi.fn(async () => ({ id: "MakeADemoVideo" })),
}));

vi.mock("@remotion/bundler", () => ({ bundle: remotion.bundle }));
vi.mock("@remotion/renderer", () => ({
  makeCancelSignal: remotion.makeCancelSignal,
  renderMedia: remotion.renderMedia,
  selectComposition: remotion.selectComposition,
}));

import { RemotionVideoRenderer } from "./remotion-video-renderer";

const tempRoots: string[] = [];

afterEach(async () => {
  remotion.bundle.mockClear();
  remotion.makeCancelSignal.mockClear();
  remotion.renderMedia.mockClear();
  remotion.selectComposition.mockClear();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("RemotionVideoRenderer", () => {
  it("cancels and settles an active Remotion render before rejecting", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "makeademo-remotion-"));
    tempRoots.push(tempRoot);
    const renderer = new RemotionVideoRenderer({
      bundleRoot: "/workspace",
      entryPoint: "/workspace/index.ts",
      tempRoot,
    });
    remotion.renderMedia.mockImplementationOnce(
      (({
        cancelSignal,
      }: {
        cancelSignal?: (callback: () => void) => void;
      }) => new Promise<void>((resolve) => cancelSignal?.(resolve))) as never,
    );
    const controller = new AbortController();
    const cancellation = new Error("benchmark cancelled");
    const rendering = renderer.renderVideo(renderPlan(tempRoot), {
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(remotion.renderMedia).toHaveBeenCalled());
    controller.abort(cancellation);

    await expect(rendering).rejects.toBe(cancellation);
    expect(remotion.makeCancelSignal).toHaveBeenCalledOnce();
  });

  it("uses one browser tab for stable parallel-batch rendering", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "makeademo-remotion-"));
    tempRoots.push(tempRoot);
    const renderer = new RemotionVideoRenderer({
      bundleRoot: "/workspace",
      entryPoint: "/workspace/index.ts",
      tempRoot,
    });

    await renderer.renderVideo(renderPlan(tempRoot));

    expect(remotion.renderMedia).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 1 }),
    );
  });
});

function renderPlan(tempRoot: string): CompositingRenderPlan {
  return {
    compositionId: "MakeADemoVideo",
    durationInFrames: 30,
    fontAssets: {},
    fps: 30,
    height: 720,
    outputPath: join(tempRoot, "final-video.mp4"),
    publicDir: "/workspace/public",
    scenes: [
      {
        backgroundColor: "#000000",
        durationFrames: 30,
        sceneId: "scene-001",
        type: "full-screen-text",
      },
    ],
    scriptId: "script-001",
    title: "Demo",
    width: 1280,
  };
}
