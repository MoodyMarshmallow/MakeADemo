import type { SceneDescription } from "../04-script-generation/demo-script/demo-script.schema";

export type RecordSceneInput = {
  baseUrl: string;
  demoPlaywrightScript: string;
  runDirectory: string;
  scenes: SceneDescription[];
  sectionId: string;
};

export type RecordedScene = {
  durationSeconds: number;
  markerEndMs: number;
  markerStartMs: number;
  videoPath: string;
  sceneId: string;
  sectionId: string;
};

/**
 * Records one continuous Demo Script take and returns one clip per declared Scene.
 * Implementations must keep setup outside Scene marker ranges, preserve browser
 * state across Scenes, and fail instead of returning when marker coverage or
 * video output is incomplete.
 */
export type SceneRecorder = {
  recordScenes(input: RecordSceneInput): Promise<RecordedScene[]>;
};
