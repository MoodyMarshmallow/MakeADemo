import { spawn } from "node:child_process";

const MINIMUM_FIRST_FRAME_SSIM = 0.99;

type SceneClipTrimInput = {
  durationMs: number;
  outputVideoPath: string;
  rawTakePath: string;
  sceneId: string;
  startMs: number;
};

type SceneClipTrimResult = {
  durationDriftMs: number;
  durationSeconds: number;
  firstFrameSsim: number;
  sourceFrameDurationMs: number;
};

type SceneClipCommandResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

export type SceneClipCommandRunner = (
  command: string,
  args: string[],
) => Promise<SceneClipCommandResult>;

export type SceneClipTrimLogger = (
  entry: {
    event: string;
    message: string;
    severity?: "debug" | "error" | "info" | "warn";
  } & Record<string, unknown>,
) => Promise<void>;

/**
 * Produces a frame-accurate Scene clip from a marker-derived raw-take window.
 * Implementations must reject output whose duration differs by more than one
 * source frame or whose first frame does not match the requested raw-take frame.
 */
export type SceneClipTrimmer = {
  trimClip(input: SceneClipTrimInput): Promise<SceneClipTrimResult>;
};

export function createSceneClipTrimmer(options: {
  log?: SceneClipTrimLogger;
  runCommand: SceneClipCommandRunner;
}): SceneClipTrimmer {
  return {
    async trimClip(input) {
      await options.log?.({
        artifacts: {
          outputVideoPath: input.outputVideoPath,
          rawTakePath: input.rawTakePath,
        },
        event: "scene-clip-trim-started",
        message: `Frame-accurate trim started for Scene ${input.sceneId}.`,
        requestedDurationMs: input.durationMs,
        requestedStartMs: input.startMs,
        sceneId: input.sceneId,
        severity: "info",
        stage: "footage-capture",
      });

      try {
        await trimFrameAccurately({ input, runCommand: options.runCommand });
        const sourceFrameDurationMs = await probeSourceFrameDurationMs({
          input,
          runCommand: options.runCommand,
        });
        const durationSeconds = await probeVideoDurationSeconds({
          input,
          runCommand: options.runCommand,
        });
        const durationDriftMs = Math.abs(
          durationSeconds * 1000 - input.durationMs,
        );
        if (durationDriftMs > sourceFrameDurationMs) {
          throw new Error(
            `Trimmed Scene ${input.sceneId} duration drifted ${durationDriftMs.toFixed(3)}ms from its marker window, exceeding one source frame (${sourceFrameDurationMs.toFixed(3)}ms).`,
          );
        }

        const firstFrameSsim = await probeFirstFrameSsim({
          input,
          runCommand: options.runCommand,
          sourceFrameDurationMs,
        });
        if (firstFrameSsim < MINIMUM_FIRST_FRAME_SSIM) {
          throw new Error(
            `Trimmed Scene ${input.sceneId} first frame did not match its requested raw-take frame (SSIM ${firstFrameSsim.toFixed(6)}).`,
          );
        }

        const result = {
          durationDriftMs,
          durationSeconds,
          firstFrameSsim,
          sourceFrameDurationMs,
        };
        await options.log?.({
          ...result,
          event: "scene-clip-trim-succeeded",
          message: `Frame-accurate trim succeeded for Scene ${input.sceneId}.`,
          probedDurationMs: durationSeconds * 1000,
          requestedDurationMs: input.durationMs,
          requestedStartMs: input.startMs,
          sceneId: input.sceneId,
          severity: "info",
          stage: "footage-capture",
        });
        return result;
      } catch (error) {
        await options.log?.({
          error: readErrorMessage(error),
          event: "scene-clip-trim-failed",
          message: `Frame-accurate trim failed for Scene ${input.sceneId}.`,
          requestedDurationMs: input.durationMs,
          requestedStartMs: input.startMs,
          sceneId: input.sceneId,
          severity: "error",
          stage: "footage-capture",
        });
        throw error;
      }
    },
  };
}

export function createLocalSceneClipTrimmer(
  options: {
    log?: SceneClipTrimLogger;
  } = {},
): SceneClipTrimmer {
  return createSceneClipTrimmer({
    ...options,
    runCommand,
  });
}

async function trimFrameAccurately(input: {
  input: SceneClipTrimInput;
  runCommand: SceneClipCommandRunner;
}) {
  const result = await input.runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input.input.rawTakePath,
    "-ss",
    (input.input.startMs / 1000).toFixed(3),
    "-t",
    (input.input.durationMs / 1000).toFixed(3),
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "18",
    "-b:v",
    "0",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-an",
    input.input.outputVideoPath,
  ]);
  assertCommandSucceeded(
    result,
    `Failed to trim Scene ${input.input.sceneId} with ffmpeg`,
  );
}

async function probeVideoDurationSeconds(input: {
  input: SceneClipTrimInput;
  runCommand: SceneClipCommandRunner;
}) {
  const result = await input.runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    input.input.outputVideoPath,
  ]);
  assertCommandSucceeded(result, "Failed to probe trimmed Scene clip duration");

  const durationSeconds = Number(result.stdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      `ffprobe returned invalid duration for ${input.input.outputVideoPath}`,
    );
  }
  return durationSeconds;
}

async function probeSourceFrameDurationMs(input: {
  input: SceneClipTrimInput;
  runCommand: SceneClipCommandRunner;
}) {
  const result = await input.runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=avg_frame_rate",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    input.input.rawTakePath,
  ]);
  assertCommandSucceeded(result, "Failed to probe raw-take frame rate");

  const frameRate = parseFrameRate(result.stdout.trim());
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error(
      `ffprobe returned invalid frame rate for ${input.input.rawTakePath}`,
    );
  }
  return 1000 / frameRate;
}

async function probeFirstFrameSsim(input: {
  input: SceneClipTrimInput;
  runCommand: SceneClipCommandRunner;
  sourceFrameDurationMs: number;
}) {
  const result = await input.runCommand("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    input.input.rawTakePath,
    "-i",
    input.input.outputVideoPath,
    "-filter_complex",
    `[0:v]trim=start=${(input.input.startMs / 1000).toFixed(3)}:duration=${(input.sourceFrameDurationMs / 1000).toFixed(6)},setpts=PTS-STARTPTS[raw];[1:v]trim=end_frame=1,setpts=PTS-STARTPTS[clip];[raw][clip]ssim`,
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  assertCommandSucceeded(result, "Failed to compare Scene clip first frame");

  const match = /\bAll:([0-9.]+)/.exec(`${result.stdout}\n${result.stderr}`);
  const similarity = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(similarity)) {
    throw new Error(
      `ffmpeg returned no first-frame similarity for Scene ${input.input.sceneId}`,
    );
  }
  return similarity;
}

function parseFrameRate(value: string) {
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? "1");
  return numerator / denominator;
}

function assertCommandSucceeded(
  result: SceneClipCommandResult,
  message: string,
) {
  if (result.exitCode !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${message}.${details.length === 0 ? "" : `\n${details}`}`);
  }
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runCommand(command: string, args: string[]) {
  return await new Promise<SceneClipCommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}
