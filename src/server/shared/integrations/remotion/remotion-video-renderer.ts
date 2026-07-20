import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import {
  makeCancelSignal,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import type {
  CompositingRenderPlan,
  VideoRenderOptions,
  VideoRenderer,
} from "../../../pipeline/07-compositing/video-renderer.interface";

export type RemotionVideoRendererInput = {
  bundleRoot: string;
  entryPoint: string;
  tempRoot: string;
};

export class RemotionVideoRenderer implements VideoRenderer {
  private readonly bundleRoot: string;
  private readonly entryPoint: string;
  private readonly tempRoot: string;

  constructor(input: RemotionVideoRendererInput) {
    this.bundleRoot = input.bundleRoot;
    this.entryPoint = input.entryPoint;
    this.tempRoot = input.tempRoot;
  }

  async renderVideo(
    input: CompositingRenderPlan,
    options: VideoRenderOptions = {},
  ): Promise<void> {
    throwIfRenderCancelled(options.signal);
    await mkdir(this.tempRoot, { recursive: true });

    const serveUrl = await bundle({
      entryPoint: this.entryPoint,
      outDir: join(this.tempRoot, `${input.scriptId}-${Date.now()}`),
      publicDir: input.publicDir,
      rootDir: this.bundleRoot,
    });
    throwIfRenderCancelled(options.signal);
    const composition = await selectComposition({
      id: input.compositionId,
      inputProps: input,
      logLevel: "warn",
      serveUrl,
    });
    throwIfRenderCancelled(options.signal);

    const { cancel, cancelSignal } = makeCancelSignal();
    const abort = () => cancel();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      throwIfRenderCancelled(options.signal);
      await renderMedia({
        cancelSignal,
        codec: "h264",
        composition,
        concurrency: 1,
        inputProps: input,
        logLevel: "info",
        outputLocation: input.outputPath,
        overwrite: true,
        serveUrl,
      });
      throwIfRenderCancelled(options.signal);
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw readAbortReason(options.signal);
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

function throwIfRenderCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw readAbortReason(signal);
}

function readAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Video render cancelled.");
}
