import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  pipelineCancellationFromSignal,
  throwIfPipelineDeadlineReached,
} from "../00-orchestration/job/pipeline-cancellation";
import type { DemoScript } from "../04-script-generation/demo-script/demo-script.schema";
import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "./composite-video";

export const DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export type DraftCompositeEvidence = {
  audioProbeFailed?: boolean;
  audioPresent?: boolean;
  contactSheetPaths: string[];
  ffmpegFindings: string[];
  sampledFramePaths: string[];
  evidenceManifestPath?: string;
  staticProbeFailedSceneIds?: string[];
  staticSceneIds: string[];
};

export function collectDraftCompositeQualityFindings(input: {
  captureManifest: Pick<CaptureManifest, "qualityFindings" | "scenes">;
  draftEvidence: DraftCompositeEvidence;
  finalVideo: Pick<CompositedVideoManifest, "durationInFrames" | "fps">;
  demoScript: Pick<DemoScript, "presentation">;
}) {
  const findings: string[] = [...input.captureManifest.qualityFindings];
  const maxDraftDurationSeconds = readPositiveNumberEnv(
    "MAKEADEMO_MAX_DRAFT_COMPOSITE_SECONDS",
    120,
  );
  const maxSceneDurationSeconds = readPositiveNumberEnv(
    "MAKEADEMO_MAX_SCENE_CLIP_SECONDS",
    30,
  );
  const draftDurationSeconds =
    input.finalVideo.durationInFrames / input.finalVideo.fps;

  if (draftDurationSeconds > maxDraftDurationSeconds) {
    findings.push(
      `Draft Composite duration ${draftDurationSeconds.toFixed(2)}s exceeds ${maxDraftDurationSeconds}s`,
    );
  }

  for (const scene of input.captureManifest.scenes) {
    if (scene.durationSeconds > maxSceneDurationSeconds) {
      findings.push(
        `Scene ${scene.sceneId} duration ${scene.durationSeconds.toFixed(2)}s exceeds ${maxSceneDurationSeconds}s`,
      );
    }
  }

  if (
    input.demoScript.presentation.music.enabled &&
    input.draftEvidence.audioPresent === false
  ) {
    findings.push("Draft Composite is missing audio while music is enabled");
  }
  if (
    input.demoScript.presentation.music.enabled &&
    input.draftEvidence.audioPresent === undefined
  ) {
    findings.push(
      "Draft Composite audio presence could not be verified while music is enabled",
    );
  }

  for (const sceneId of input.draftEvidence.staticSceneIds) {
    findings.push(`Scene ${sceneId} contains fully static footage`);
  }
  for (const sceneId of input.draftEvidence.staticProbeFailedSceneIds ?? []) {
    findings.push(`Scene ${sceneId} static-footage gate could not be verified`);
  }

  return findings;
}

export async function inspectDraftCompositeEvidence(input: {
  captureManifest: CaptureManifest;
  deadlineAt?: number;
  draftComposite: CompositedVideoManifest;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DraftCompositeEvidence> {
  throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
  const timeoutMs = input.timeoutMs ?? DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS;
  const { captureManifest, draftComposite } = input;
  if (draftComposite.outputVideoPath === undefined) {
    return {
      audioProbeFailed: true,
      contactSheetPaths: [],
      ffmpegFindings: [
        "Draft Composite video is stored remotely; local sampled-frame evidence was not generated.",
      ],
      sampledFramePaths: [],
      staticProbeFailedSceneIds: captureManifest.scenes.map(
        (scene) => scene.sceneId,
      ),
      staticSceneIds: [],
    };
  }

  if (!(await exists(draftComposite.outputVideoPath))) {
    return {
      audioProbeFailed: true,
      contactSheetPaths: [],
      ffmpegFindings: [
        `Draft Composite video was unavailable for evidence generation: ${draftComposite.outputVideoPath}`,
      ],
      sampledFramePaths: [],
      staticProbeFailedSceneIds: captureManifest.scenes.map(
        (scene) => scene.sceneId,
      ),
      staticSceneIds: [],
    };
  }

  const evidenceDirectory = join(
    draftComposite.runDirectory,
    "review-evidence",
  );
  await mkdir(evidenceDirectory, { recursive: true });
  throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);

  const findings: string[] = [];
  const sampledFramePattern = join(evidenceDirectory, "sample-%03d.jpg");
  const contactSheetPath = join(evidenceDirectory, "contact-sheet.jpg");
  const evidenceCommands = [
    runEvidenceCommand(
      "ffmpeg",
      [
        "-y",
        "-i",
        draftComposite.outputVideoPath,
        "-vf",
        "fps=1/5",
        "-frames:v",
        "4",
        sampledFramePattern,
      ],
      timeoutMs,
      input.signal,
    ),
    runEvidenceCommand(
      "ffmpeg",
      [
        "-y",
        "-i",
        draftComposite.outputVideoPath,
        "-vf",
        "fps=1/5,scale=320:-1,tile=2x2",
        "-frames:v",
        "1",
        contactSheetPath,
      ],
      timeoutMs,
      input.signal,
    ),
    runEvidenceCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        draftComposite.outputVideoPath,
      ],
      timeoutMs,
      input.signal,
    ),
  ] as const;
  let sampledFrames: Awaited<(typeof evidenceCommands)[number]>;
  let contactSheet: Awaited<(typeof evidenceCommands)[number]>;
  let audioProbe: Awaited<(typeof evidenceCommands)[number]>;
  try {
    [sampledFrames, contactSheet, audioProbe] =
      await Promise.all(evidenceCommands);
  } catch (error) {
    await Promise.allSettled(evidenceCommands);
    throw error;
  }
  throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
  if (sampledFrames.exitCode !== 0) {
    findings.push(
      `ffmpeg sampled-frame extraction failed: ${formatCommandOutput(sampledFrames)}`,
    );
  }
  if (contactSheet.exitCode !== 0) {
    findings.push(
      `ffmpeg contact-sheet generation failed: ${formatCommandOutput(contactSheet)}`,
    );
  }
  if (audioProbe.exitCode !== 0) {
    findings.push(
      `ffprobe audio probe failed: ${formatCommandOutput(audioProbe)}`,
    );
  }
  const staticFootageProbe = await detectStaticScenes({
    captureManifest,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    findings,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMs,
  });
  const evidenceManifestPath = join(
    evidenceDirectory,
    "evidence-manifest.json",
  );
  await writeFile(
    evidenceManifestPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sceneProbes: staticFootageProbe.sceneProbes,
        staticSceneIds: staticFootageProbe.staticSceneIds,
        failedSceneIds: staticFootageProbe.failedSceneIds,
      },
      null,
      2,
    )}\n`,
  );

  return {
    ...(audioProbe.exitCode === 0 ? {} : { audioProbeFailed: true }),
    ...(audioProbe.exitCode === 0
      ? { audioPresent: audioProbe.stdout.trim().length > 0 }
      : {}),
    contactSheetPaths: contactSheet.exitCode === 0 ? [contactSheetPath] : [],
    ffmpegFindings: findings,
    sampledFramePaths:
      sampledFrames.exitCode === 0
        ? [1, 2, 3, 4].map((index) =>
            join(
              evidenceDirectory,
              `sample-${String(index).padStart(3, "0")}.jpg`,
            ),
          )
        : [],
    evidenceManifestPath,
    staticProbeFailedSceneIds: staticFootageProbe.failedSceneIds,
    staticSceneIds: staticFootageProbe.staticSceneIds,
  };
}

async function detectStaticScenes(input: {
  captureManifest: CaptureManifest;
  deadlineAt?: number;
  findings: string[];
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  const failedSceneIds: string[] = [];
  const staticSceneIds: string[] = [];
  const sceneProbes: Array<{
    durationSeconds: number;
    sceneId: string;
    status: "failed" | "non-static" | "static" | "skipped";
    videoPath: string;
  }> = [];

  for (const scene of input.captureManifest.scenes) {
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    const durationSeconds = scene.durationSeconds;
    if (durationSeconds < 1) {
      sceneProbes.push({
        durationSeconds,
        sceneId: scene.sceneId,
        status: "skipped",
        videoPath: scene.videoPath,
      });
      continue;
    }

    const freezeDurationSeconds = Math.max(0.5, durationSeconds * 0.75);
    const probe = await runEvidenceCommand(
      "ffmpeg",
      [
        "-v",
        "info",
        "-t",
        durationSeconds.toFixed(3),
        "-i",
        scene.videoPath,
        "-vf",
        `freezedetect=n=-60dB:d=${freezeDurationSeconds.toFixed(3)}`,
        "-an",
        "-f",
        "null",
        "-",
      ],
      input.timeoutMs,
      input.signal,
    );

    if (probe.exitCode !== 0) {
      failedSceneIds.push(scene.sceneId);
      sceneProbes.push({
        durationSeconds,
        sceneId: scene.sceneId,
        status: "failed",
        videoPath: scene.videoPath,
      });
      input.findings.push(
        `ffmpeg static-footage probe failed for Scene ${scene.sceneId}: ${formatCommandOutput(probe)}`,
      );
    } else if (
      isStaticSceneProbe(probe.stderr, freezeDurationSeconds, durationSeconds)
    ) {
      staticSceneIds.push(scene.sceneId);
      sceneProbes.push({
        durationSeconds,
        sceneId: scene.sceneId,
        status: "static",
        videoPath: scene.videoPath,
      });
    } else {
      sceneProbes.push({
        durationSeconds,
        sceneId: scene.sceneId,
        status: "non-static",
        videoPath: scene.videoPath,
      });
    }
  }

  return { failedSceneIds, sceneProbes, staticSceneIds };
}

function isStaticSceneProbe(
  stderr: string,
  minimumFreezeDurationSeconds: number,
  sceneDurationSeconds: number,
) {
  if (
    /freezedetect.*freeze_start/.test(stderr) &&
    !/freezedetect.*freeze_end/.test(stderr)
  ) {
    const freezeStart = stderr.match(/freeze_start:\s*([0-9.]+)/)?.[1];
    const freezeStartSeconds =
      freezeStart === undefined ? Number.NaN : Number(freezeStart);
    return Number.isFinite(freezeStartSeconds)
      ? sceneDurationSeconds - freezeStartSeconds >=
          minimumFreezeDurationSeconds
      : false;
  }

  return [...stderr.matchAll(/freeze_duration:\s*([0-9.]+)/g)].some((match) => {
    const durationSeconds = Number(match[1]);
    return (
      Number.isFinite(durationSeconds) &&
      durationSeconds >= minimumFreezeDurationSeconds
    );
  });
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runEvidenceCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const cancellation = pipelineCancellationFromSignal(signal);
  if (cancellation !== undefined) throw cancellation;
  return new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationStarted = false;
    let cancellationError: unknown;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationSettlementTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: {
      exitCode: number | null;
      stderr: string;
      stdout: string;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (terminationSettlementTimer !== undefined) {
        clearTimeout(terminationSettlementTimer);
      }
      signal?.removeEventListener("abort", abort);
      if (cancellationError !== undefined) {
        reject(cancellationError);
      } else {
        resolve(result);
      }
    };

    const terminate = (reason: "cancelled" | "timed-out") => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      clearTimeout(timeoutTimer);
      if (reason === "cancelled") {
        cancellationError =
          pipelineCancellationFromSignal(signal) ?? signal?.reason;
      } else {
        stderr += `Command timed out after ${timeoutMs}ms.`;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(
        () => child.kill("SIGKILL"),
        Math.min(1000, Math.max(100, timeoutMs)),
      );
      terminationSettlementTimer = setTimeout(
        () => settle({ exitCode: null, stderr, stdout }),
        Math.min(2000, Math.max(500, timeoutMs)),
      );
    };
    const abort = () => terminate("cancelled");

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      settle({ exitCode: 127, stderr: error.message, stdout });
    });
    child.once("close", (exitCode) => {
      settle({ exitCode, stderr, stdout });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();

    const timeoutTimer = setTimeout(
      () => {
        terminate("timed-out");
      },
      Math.max(1, timeoutMs),
    );
  });
}

function formatCommandOutput(result: { stderr: string; stdout: string }) {
  return [result.stdout.trim(), result.stderr.trim()]
    .filter((output) => output.length > 0)
    .join("\n");
}

function readPositiveNumberEnv(name: string, defaultValue: number) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
}
