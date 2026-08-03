export type CompositingTextStyle = {
  color: string;
  content: string;
  fontFamily: string;
  position: "bottom-left" | "center" | "top-left";
  size: "large" | "medium" | "small";
};

export type CompositingTransition = {
  durationFrames: number;
  in: "cut" | "fade";
  out: "cut" | "fade";
};

export type CompositingScene = {
  alt?: string;
  backgroundColor?: string;
  durationFrames: number;
  sceneId: string;
  sourcePublicPath?: string;
  text?: CompositingTextStyle;
  transition?: CompositingTransition;
  type: "full-screen-text" | "playwright-recording" | "static-image";
};

export type CompositingFontAsset = {
  family: string;
  publicPath: string;
};

export type CompositingMusicAsset = {
  id: string;
  publicPath: string;
};

export type CompositingRenderPlan = {
  compositionId: "MakeADemoVideo";
  durationInFrames: number;
  fontAssets: Record<string, CompositingFontAsset>;
  fps: number;
  height: number;
  music?: CompositingMusicAsset;
  outputPath: string;
  publicDir: string;
  scenes: CompositingScene[];
  scriptId: string;
  title: string;
  width: number;
};

export type VideoRenderOptions = {
  signal?: AbortSignal;
};

/**
 * Renders a prepared Compositing plan into one private Draft Composite file.
 * Implementations must write exactly to outputPath and treat publicDir paths as
 * stable Remotion public assets for the duration of the render.
 */
export interface VideoRenderer {
  renderVideo(
    input: CompositingRenderPlan,
    options?: VideoRenderOptions,
  ): Promise<void>;
}
