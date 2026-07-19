import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalSceneClipTrimmer,
  createSceneClipTrimmer,
} from "./scene-clip-trimmer";

describe("SceneClipTrimmer", () => {
  it("trims a non-keyframe-aligned Scene within one frame of its marker window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-trimmer-test-"));
    const rawTakePath = join(directory, "raw-take.webm");
    const outputVideoPath = join(directory, "scene.webm");

    try {
      await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90:r=25:d=7",
        "-vf",
        "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,5.5)'",
        "-c:v",
        "libvpx-vp9",
        "-g",
        "128",
        "-keyint_min",
        "128",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        rawTakePath,
      ]);

      const result = await createLocalSceneClipTrimmer().trimClip({
        durationMs: 1_000,
        outputVideoPath,
        rawTakePath,
        sceneId: "scene-non-keyframe",
        startMs: 5_500,
      });

      expect(result.durationDriftMs).toBeLessThanOrEqual(
        result.sourceFrameDurationMs,
      );
      expect(result.firstFrameSsim).toBeGreaterThanOrEqual(0.99);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("rejects a clip whose duration drifts beyond one source frame", async () => {
    const commands: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const trimmer = createSceneClipTrimmerForTest(
      commands,
      {
        durationSeconds: 1.1,
        firstFrameSsim: 1,
      },
      logs,
    );

    await expect(
      trimmer.trimClip({
        durationMs: 1_000,
        outputVideoPath: "/tmp/scene.webm",
        rawTakePath: "/tmp/raw.webm",
        sceneId: "duration-drift",
        startMs: 500,
      }),
    ).rejects.toThrow(/duration drifted .* exceeding one source frame/);
    expect(commands[0]).toBe("ffmpeg");
    expect(commands).toEqual(["ffmpeg", "ffprobe", "ffprobe"]);
    expect(logs.at(-1)).toMatchObject({
      event: "scene-clip-trim-failed",
      severity: "error",
    });
  });

  it("rejects a clip whose first frame does not match its marker frame", async () => {
    const trimmer = createSceneClipTrimmerForTest([], {
      durationSeconds: 1,
      firstFrameSsim: 0.98,
    });

    await expect(
      trimmer.trimClip({
        durationMs: 1_000,
        outputVideoPath: "/tmp/scene.webm",
        rawTakePath: "/tmp/raw.webm",
        sceneId: "first-frame-drift",
        startMs: 500,
      }),
    ).rejects.toThrow(/first frame did not match/);
  });
});

function createSceneClipTrimmerForTest(
  commands: string[],
  output: { durationSeconds: number; firstFrameSsim: number },
  logs: Array<Record<string, unknown>> = [],
) {
  return createSceneClipTrimmer({
    log: async (entry) => {
      logs.push(entry);
    },
    async runCommand(command, args) {
      commands.push(command);
      if (args.some((arg) => arg.includes("ssim"))) {
        return {
          exitCode: 0,
          stderr: `SSIM All:${output.firstFrameSsim.toFixed(6)}`,
          stdout: "",
        };
      }
      if (command === "ffmpeg") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (args.some((arg) => arg.includes("avg_frame_rate"))) {
        return { exitCode: 0, stderr: "", stdout: "25/1\n" };
      }
      if (args.some((arg) => arg.includes("format=duration"))) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${output.durationSeconds.toFixed(3)}\n`,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });
}

async function run(command: string, args: string[]) {
  const result = await new Promise<{
    exitCode: number | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stderr }));
  });

  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
}
