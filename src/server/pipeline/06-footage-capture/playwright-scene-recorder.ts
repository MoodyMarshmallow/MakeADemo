import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import { uploadSubmittedCodeWorkspaceFiles } from "../03-repo-preparation/preparation-workspace-upload";
import type { PreparationWorkspace } from "../03-repo-preparation/preparation-workspace.interface";
import { executeSubmittedCode } from "../03-repo-preparation/submitted-code-execution";
import {
  type CaptureSdkSceneEvent,
  parseCaptureSdkBlockedNetworkEvents,
  parseCaptureSdkSceneEvents,
  reduceCaptureSdkSceneEvents,
} from "./capture-sdk-event.schema";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "./capture-sdk-harness";
import {
  type SceneClipTrimLogger,
  type SceneClipTrimmer,
  createSceneClipTrimmer,
} from "./scene-clip-trimmer";
import type {
  RecordSceneInput,
  RecordedScene,
  SceneRecorder,
} from "./scene-recorder.interface";
import { prepareStylizedPlaywrightScript } from "./stylized-playwright-script";

type SceneMarker = CaptureSdkSceneEvent;
type SceneScriptResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export class PreparedWorkspacePlaywrightSceneRecorder implements SceneRecorder {
  private readonly headed: boolean;
  private readonly pauseAfterSceneMs: number;
  private readonly postRollMs: number;
  private readonly preRollMs: number;
  private readonly sceneTimeoutMs: number;
  private readonly clipTrimmer: SceneClipTrimmer;

  constructor(
    private readonly options: {
      headed?: boolean;
      pauseAfterSceneMs?: number;
      postRollMs?: number;
      preRollMs?: number;
      preparationWorkspace: PreparationWorkspaceHandle;
      log?: SceneClipTrimLogger;
      sceneTimeoutMs?: number;
    },
  ) {
    this.headed = options.headed ?? false;
    this.pauseAfterSceneMs = options.pauseAfterSceneMs ?? 0;
    this.postRollMs = options.postRollMs ?? 350;
    this.preRollMs = options.preRollMs ?? 250;
    this.sceneTimeoutMs = options.sceneTimeoutMs ?? 120_000;
    this.clipTrimmer = createSubmittedCodeSceneClipTrimmer({
      ...(options.log === undefined ? {} : { log: options.log }),
      workspace: options.preparationWorkspace.workspace,
    });
  }

  async recordScenes(input: RecordSceneInput): Promise<RecordedScene[]> {
    const workspace = this.options.preparationWorkspace.workspace;
    if (workspace.downloadFiles === undefined) {
      throw new Error(
        "Prepared workspace Footage Capture requires artifact download support.",
      );
    }

    const runId = basename(input.runDirectory);
    const remoteRunDirectory = `/workspace/.makeademo/footage-capture-runs/${runId}`;
    const remoteSceneWorkspace = `${remoteRunDirectory}/work/continuous-take`;
    const remoteVideoScratchDirectory = `${remoteSceneWorkspace}/playwright-videos`;
    const remoteRawScenesDirectory = `${remoteRunDirectory}/raw-scenes`;
    const remoteSceneClipsDirectory = `${remoteRunDirectory}/scene-clips`;
    const remoteScenePath = `${remoteSceneWorkspace}/demo-script.ts`;
    const remoteRawTakePath = `${remoteRawScenesDirectory}/continuous-take.webm`;
    const localSceneWorkspace = join(
      input.runDirectory,
      "work",
      "continuous-take",
    );
    const localRawScenesDirectory = join(input.runDirectory, "raw-scenes");
    const localSceneClipsDirectory = join(input.runDirectory, "scene-clips");
    const localScenePath = join(localSceneWorkspace, "demo-script.ts");
    const markerLogPath = join(input.runDirectory, "scene-markers.jsonl");
    const localRawTakePath = join(
      localRawScenesDirectory,
      "continuous-take.webm",
    );

    await mkdir(localSceneWorkspace, { recursive: true });
    await mkdir(localRawScenesDirectory, { recursive: true });
    await mkdir(localSceneClipsDirectory, { recursive: true });
    await writeGeneratedCaptureSdkHarness(localSceneWorkspace);
    await validateDemoScriptCaptureSdkTypes({
      demoPlaywrightScript: input.demoPlaywrightScript,
      directory: localSceneWorkspace,
    });
    await writeFile(
      localScenePath,
      prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
        baseUrl: input.baseUrl,
        headed: this.headed,
        pauseAfterSceneMs: this.pauseAfterSceneMs,
        videoDirectory: remoteVideoScratchDirectory,
      }),
    );

    await executeSubmittedCode(
      workspace,
      `mkdir -p ${shellQuote(remoteSceneWorkspace)} ${shellQuote(remoteVideoScratchDirectory)} ${shellQuote(remoteRawScenesDirectory)} ${shellQuote(remoteSceneClipsDirectory)}`,
    );
    await uploadSubmittedCodeWorkspaceFiles({
      files: [
        {
          destinationPath: `${remoteSceneWorkspace}/makeademo-capture-sdk.js`,
          sourcePath: join(localSceneWorkspace, "makeademo-capture-sdk.js"),
        },
        {
          destinationPath: `${remoteSceneWorkspace}/makeademo-capture-sdk.d.ts`,
          sourcePath: join(localSceneWorkspace, "makeademo-capture-sdk.d.ts"),
        },
        {
          destinationPath: `${remoteSceneWorkspace}/makeademo-capture-sdk.instructions.md`,
          sourcePath: join(
            localSceneWorkspace,
            "makeademo-capture-sdk.instructions.md",
          ),
        },
        {
          destinationPath: `${remoteSceneWorkspace}/demo-script.contract.ts`,
          sourcePath: join(localSceneWorkspace, "demo-script.contract.ts"),
        },
        { destinationPath: remoteScenePath, sourcePath: localScenePath },
      ],
      workspace,
    });

    const result = await executeSubmittedCode(
      workspace,
      `cd ${shellQuote(remoteSceneWorkspace)} && ${createExposeGlobalPlaywrightCommand()} && timeout -s TERM ${Math.ceil(this.sceneTimeoutMs / 1000)} bun ${shellQuote(remoteScenePath)}`,
    );
    await writeFile(markerLogPath, extractMarkerLog(result.stdout));
    const blockedNetworkAttempts = readBlockedNetworkAttempts(result.stderr);
    if (blockedNetworkAttempts.length > 0) {
      throw new Error(
        `Footage Capture blocked runtime network access from the generated Demo Script: ${blockedNetworkAttempts.map((attempt) => attempt.host).join(", ")}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        formatSceneFailure("continuous-take", {
          ...result,
          timedOut: result.exitCode === 124,
        }),
      );
    }

    const remoteRecordedVideoPath = await findSingleRemoteVideo({
      directory: remoteVideoScratchDirectory,
      workspace,
    });
    await executeSubmittedCode(
      workspace,
      `rm -f ${shellQuote(remoteRawTakePath)} && mv ${shellQuote(remoteRecordedVideoPath)} ${shellQuote(remoteRawTakePath)}`,
    );

    const markers = parseSceneMarkers(result.stdout);
    const markerRanges = readMarkerRanges(
      markers,
      input.scenes.map((scene) => scene.id),
    );
    const recordedScenes: RecordedScene[] = [];
    const downloads = [
      { destinationPath: localRawTakePath, sourcePath: remoteRawTakePath },
    ];

    for (const scene of input.scenes) {
      const range = markerRanges.get(scene.id);
      if (range === undefined) {
        throw new Error(`Scene ${scene.id} did not emit complete markers.`);
      }

      const startMs = Math.max(0, range.startedAtMs - this.preRollMs);
      const endMs = Math.max(startMs + 1, range.endedAtMs + this.postRollMs);
      const remoteOutputVideoPath = `${remoteSceneClipsDirectory}/${scene.id}.webm`;
      const localOutputVideoPath = join(
        localSceneClipsDirectory,
        `${scene.id}.webm`,
      );
      const trimResult = await this.clipTrimmer.trimClip({
        durationMs: endMs - startMs,
        outputVideoPath: remoteOutputVideoPath,
        rawTakePath: remoteRawTakePath,
        sceneId: scene.id,
        startMs,
      });

      downloads.push({
        destinationPath: localOutputVideoPath,
        sourcePath: remoteOutputVideoPath,
      });
      recordedScenes.push({
        durationSeconds: trimResult.durationSeconds,
        markerEndMs: range.endedAtMs,
        markerStartMs: range.startedAtMs,
        sceneId: scene.id,
        sectionId: input.sectionId,
        videoPath: localOutputVideoPath,
      });
    }

    const download =
      workspace.downloadSubmittedCodeFiles ?? workspace.downloadFiles;
    await download.call(workspace, downloads);

    return recordedScenes;
  }
}

function createSubmittedCodeSceneClipTrimmer(input: {
  log?: SceneClipTrimLogger;
  workspace: PreparationWorkspace;
}) {
  return createSceneClipTrimmer({
    ...(input.log === undefined ? {} : { log: input.log }),
    async runCommand(command, args) {
      return await executeSubmittedCode(
        input.workspace,
        [command, ...args.map(shellQuote)].join(" "),
      );
    },
  });
}

function formatSceneFailure(sceneId: string, result: SceneScriptResult) {
  const details = [result.stdout.trim(), result.stderr.trim()]
    .filter((output) => output.length > 0)
    .join("\n");

  if (result.timedOut) {
    return `Scene ${sceneId} timed out.${details.length > 0 ? `\n${details}` : ""}`;
  }

  return `Scene ${sceneId} failed with exit code ${result.exitCode}.${
    details.length > 0 ? `\n${details}` : ""
  }`;
}

function extractMarkerLog(stdout: string) {
  // scene-markers.jsonl is a derived capture protocol artifact, not a server audit log.
  return parseSceneMarkers(stdout)
    .map((marker) => `${JSON.stringify(marker)}\n`)
    .join("");
}

function parseSceneMarkers(stdout: string): SceneMarker[] {
  return parseCaptureSdkSceneEvents(stdout);
}

function readMarkerRanges(markers: SceneMarker[], sceneIds: string[]) {
  const result = reduceCaptureSdkSceneEvents(markers, sceneIds);
  if (result.status === "succeeded") {
    return result.ranges;
  }

  switch (result.code) {
    case "undeclared":
      throw new Error(
        `Capture script emitted undeclared Scene marker ${result.sceneId}.`,
      );
    case "nested":
      throw new Error("Capture script emitted nested Scene markers.");
    case "duplicate":
      throw new Error(
        `Capture script emitted duplicate markers for Scene ${result.sceneId}.`,
      );
    case "not-started":
      throw new Error(
        `Capture script emitted ${result.event?.event ?? "end"} marker before start for Scene ${result.sceneId}.`,
      );
    case "failed":
      throw new Error(
        `Scene ${result.sceneId} failed during Footage Capture.${result.message === undefined ? "" : ` ${result.message}`}`,
      );
    case "unclosed":
      throw new Error(
        `Capture script emitted Scene start marker without an end marker${result.sceneId === undefined ? "" : ` for Scene ${result.sceneId}`}.`,
      );
    case "missing":
      throw new Error(`Scene ${result.sceneId} did not emit complete markers.`);
  }
}

function readBlockedNetworkAttempts(stderr: string) {
  return parseCaptureSdkBlockedNetworkEvents(stderr).map((attempt) => ({
    host: attempt.host,
  }));
}

async function findSingleRemoteVideo(input: {
  directory: string;
  workspace: PreparationWorkspace;
}) {
  const result = await executeSubmittedCode(
    input.workspace,
    `find ${shellQuote(input.directory)} -type f -name '*.webm' | sort`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to find Playwright video in ${input.directory}.\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  }

  const videos = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (videos.length === 0) {
    throw new Error(`No Playwright video was created in ${input.directory}`);
  }
  if (videos.length > 1) {
    throw new Error(
      `Expected one Playwright video in ${input.directory}, found ${videos.length}`,
    );
  }

  const video = videos[0];
  if (video === undefined) {
    throw new Error(`No Playwright video was created in ${input.directory}`);
  }

  return video;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createExposeGlobalPlaywrightCommand() {
  return [
    "global_node_modules=$(npm root -g 2>/dev/null || true)",
    'if [ -n "$global_node_modules" ]; then mkdir -p node_modules; fi',
    'if [ -e "$global_node_modules/@playwright" ]; then ln -sfn "$global_node_modules/@playwright" node_modules/@playwright; fi',
    'if [ -e "$global_node_modules/playwright" ]; then ln -sfn "$global_node_modules/playwright" node_modules/playwright; fi',
    'if [ -e "$global_node_modules/playwright-core" ]; then ln -sfn "$global_node_modules/playwright-core" node_modules/playwright-core; fi',
  ].join("; ");
}
