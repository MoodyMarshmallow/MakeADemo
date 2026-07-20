import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import { assertDemoScriptCaptureSdkContract } from "./capture-sdk-contract";
import { parseDemoScript } from "./demo-script.schema";
import { PreparedWorkspacePlaywrightSceneRecorder } from "./playwright-scene-recorder";
import type { SceneClipTrimLogger } from "./scene-clip-trimmer";
import type { SceneRecorder } from "./scene-recorder.interface";

type CapturedSceneManifestEntry = {
  durationSeconds: number;
  sceneId: string;
  sectionId: string;
  videoPath: string;
};

export type CaptureManifest = {
  baseUrl: string;
  createdAt: string;
  keepTemp: boolean;
  qualityFindings: string[];
  manifestPath: string;
  runDirectory: string;
  runId: string;
  scenes: CapturedSceneManifestEntry[];
  scriptId: string;
  markerLogPath?: string;
  rawTakePath?: string;
  temporary: true;
  title: string;
};

export type CaptureScenesFromScriptInput = {
  baseUrl: string;
  keepTemp?: boolean;
  log?: SceneClipTrimLogger;
  preparationWorkspace?: PreparationWorkspaceHandle;
  recorder?: SceneRecorder;
  runId?: string;
  scriptPackage?: unknown;
  scriptPath?: string;
  tempRoot?: string;
};

export async function captureScenesFromScript(
  input: CaptureScenesFromScriptInput,
): Promise<CaptureManifest> {
  const tempRoot = input.tempRoot ?? ".demo-capture-runs";
  const keepTemp = input.keepTemp ?? false;
  const runId = input.runId ?? createRunId();
  const runDirectory = await createRunDirectory(tempRoot, runId);
  const rawScenesDirectory = join(runDirectory, "raw-scenes");
  await mkdir(rawScenesDirectory, { recursive: true });

  const scriptPackage = await readScriptPackage(input);
  assertDemoScriptCaptureSdkContract(scriptPackage);
  const recorder = input.recorder ?? createPreparedWorkspaceRecorder(input);
  const scenes: CapturedSceneManifestEntry[] = [];

  try {
    const recordedScenes = await recorder.recordScenes({
      baseUrl: input.baseUrl,
      demoPlaywrightScript: scriptPackage.demoPlaywrightScript,
      runDirectory,
      scenes: scriptPackage.scenes,
      sectionId: "demo-script",
    });

    scenes.push(...recordedScenes);

    const manifestPath = join(runDirectory, "capture-manifest.json");
    const manifest: CaptureManifest = {
      baseUrl: input.baseUrl,
      createdAt: new Date().toISOString(),
      keepTemp,
      manifestPath,
      runDirectory,
      runId,
      scenes,
      scriptId: scriptPackage.scriptId,
      markerLogPath: join(runDirectory, "scene-markers.jsonl"),
      ...(keepTemp
        ? {
            rawTakePath: join(
              runDirectory,
              "raw-scenes",
              "continuous-take.webm",
            ),
          }
        : {}),
      qualityFindings: [],
      temporary: true,
      title: scriptPackage.title,
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    if (!keepTemp) {
      await rm(runDirectory, { force: true, recursive: true });
    }
    throw error;
  }
}

function createPreparedWorkspaceRecorder(input: CaptureScenesFromScriptInput) {
  if (input.preparationWorkspace === undefined) {
    throw new Error(
      "Footage Capture requires a prepared workspace; local capture is not allowed.",
    );
  }

  return new PreparedWorkspacePlaywrightSceneRecorder({
    ...(input.log === undefined ? {} : { log: input.log }),
    preparationWorkspace: input.preparationWorkspace,
  });
}

async function readScriptPackage(input: CaptureScenesFromScriptInput) {
  if (input.scriptPackage !== undefined) {
    return parseDemoScript(input.scriptPackage);
  }

  if (input.scriptPath === undefined) {
    throw new Error("scriptPath or scriptPackage is required");
  }

  return parseDemoScript(JSON.parse(await readFile(input.scriptPath, "utf8")));
}

async function createRunDirectory(tempRoot: string, runId: string) {
  await mkdir(tempRoot, { recursive: true });

  if (runId.length > 0) {
    const runDirectory = join(tempRoot, runId);
    await mkdir(runDirectory, { recursive: false });
    return runDirectory;
  }

  return mkdtemp(join(tempRoot, "capture-"));
}

function createRunId() {
  return `capture-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}
