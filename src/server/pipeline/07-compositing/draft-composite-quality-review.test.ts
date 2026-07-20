import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PipelineCancellationError } from "../00-orchestration/job/pipeline-cancellation";
import type { DemoScript } from "../04-script-generation/demo-script/demo-script.schema";
import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "./composite-video";
import {
  type DraftCompositeEvidence,
  collectDraftCompositeQualityFindings,
  inspectDraftCompositeEvidence,
} from "./draft-composite-quality-review";

describe("collectDraftCompositeQualityFindings", () => {
  it("reports deterministic Draft Composite quality gates without needing a reviewer", () => {
    const findings = collectDraftCompositeQualityFindings({
      captureManifest: {
        ...({} as CaptureManifest),
        qualityFindings: ["capture reported a clipped scene"],
        scenes: [
          {
            durationSeconds: 31,
            sceneId: "scene-feed",
            sectionId: "demo-script",
            videoPath: "/tmp/scene-feed.webm",
          },
        ],
      },
      draftEvidence: {
        audioPresent: false,
        contactSheetPaths: [],
        ffmpegFindings: [],
        sampledFramePaths: [],
        staticSceneIds: ["scene-feed"],
      } satisfies DraftCompositeEvidence,
      finalVideo: {
        ...({} as CompositedVideoManifest),
        durationInFrames: 121 * 30,
        fps: 30,
      },
      demoScript: {
        ...({} as DemoScript),
        presentation: {
          ...({} as DemoScript["presentation"]),
          music: { enabled: true, trackId: "focus" },
        },
      },
    });

    expect(findings).toEqual([
      "capture reported a clipped scene",
      "Draft Composite duration 121.00s exceeds 120s",
      "Scene scene-feed duration 31.00s exceeds 30s",
      "Draft Composite is missing audio while music is enabled",
      "Scene scene-feed contains fully static footage",
    ]);
  });

  it("reports unverified audio as a review gate when music is enabled", () => {
    const findings = collectDraftCompositeQualityFindings({
      captureManifest: { qualityFindings: [], scenes: [] },
      draftEvidence: {
        contactSheetPaths: [],
        ffmpegFindings: ["ffprobe audio probe failed"],
        sampledFramePaths: [],
        staticSceneIds: [],
      },
      finalVideo: { durationInFrames: 30, fps: 30 },
      demoScript: {
        presentation: { music: { enabled: true, trackId: "focus" } },
      } as DemoScript,
    });

    expect(findings).toEqual([
      "Draft Composite audio presence could not be verified while music is enabled",
    ]);
  });
});

describe("inspectDraftCompositeEvidence", () => {
  it("terminates all active evidence commands before propagating cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-evidence-"));
    const bin = join(root, "bin");
    const processLog = join(root, "processes.log");
    await mkdir(bin, { recursive: true });
    await writeFile(join(root, "draft.mp4"), "draft");
    const hanging = `#!/bin/sh
printf 'started %s\n' "$$" >> '${processLog}'
trap 'printf "terminated %s\\n" "$$" >> "${processLog}"; exit 0' TERM INT
while :; do :; done
`;
    await writeFile(join(bin, "ffmpeg"), hanging, { mode: 0o755 });
    await writeFile(join(bin, "ffprobe"), hanging, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    const controller = new AbortController();
    try {
      const inspection = inspectDraftCompositeEvidence({
        captureManifest: {
          ...({} as CaptureManifest),
          qualityFindings: [],
          scenes: [],
        },
        draftComposite: {
          ...({} as CompositedVideoManifest),
          durationInFrames: 30,
          fps: 30,
          outputVideoPath: join(root, "draft.mp4"),
          runDirectory: root,
        },
        signal: controller.signal,
        timeoutMs: 1_000,
      } as Parameters<typeof inspectDraftCompositeEvidence>[0]);
      await vi.waitFor(async () => {
        const log = await readFile(processLog, "utf8").catch(() => "");
        expect(log.match(/^started /gm)).toHaveLength(3);
      });

      controller.abort(new PipelineCancellationError("signal"));

      await expect(inspection).rejects.toMatchObject({ reason: "signal" });
      const log = await readFile(processLog, "utf8");
      expect(log.match(/^terminated /gm)).toHaveLength(3);
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("probes each captured Scene clip directly for static footage", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-evidence-"));
    const bin = join(root, "bin");
    await writeFile(join(root, "draft.mp4"), "draft");
    await writeFile(join(root, "scene-one.webm"), "scene");
    await writeFile(join(root, "scene-two.webm"), "scene");
    await mkdir(bin, { recursive: true });
    const logPath = join(root, "commands.log");
    const ffmpeg = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nif printf '%s' "$*" | grep -q 'scene-two.webm'; then exit 1; fi\nprintf 'freezedetect freeze_duration: 0.900\\n' >&2\n`;
    const ffprobe = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nprintf '1\\n'\n`;
    await writeFile(join(bin, "ffmpeg"), ffmpeg, { mode: 0o755 });
    await writeFile(join(bin, "ffprobe"), ffprobe, { mode: 0o755 });
    await chmod(join(bin, "ffmpeg"), 0o755);
    await chmod(join(bin, "ffprobe"), 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const evidence = await inspectDraftCompositeEvidence({
        captureManifest: {
          ...({} as CaptureManifest),
          scenes: [
            {
              durationSeconds: 1.2,
              sceneId: "scene-one",
              sectionId: "demo-script",
              videoPath: join(root, "scene-one.webm"),
            },
            {
              durationSeconds: 1.2,
              sceneId: "scene-two",
              sectionId: "demo-script",
              videoPath: join(root, "scene-two.webm"),
            },
          ],
          qualityFindings: [],
        },
        draftComposite: {
          ...({} as CompositedVideoManifest),
          durationInFrames: 72,
          fps: 30,
          outputVideoPath: join(root, "draft.mp4"),
          runDirectory: root,
        },
      });

      const commands = await readFile(logPath, "utf8");
      const evidenceManifestPath = evidence.evidenceManifestPath;
      expect(evidenceManifestPath).toBeDefined();
      const evidenceManifest = JSON.parse(
        await readFile(evidenceManifestPath ?? "", "utf8"),
      );
      expect(commands).toContain(join(root, "scene-one.webm"));
      expect(commands).toContain(join(root, "scene-two.webm"));
      expect(evidence.staticSceneIds).toEqual(["scene-one"]);
      expect(evidence.staticProbeFailedSceneIds).toEqual(["scene-two"]);
      expect(evidence.evidenceManifestPath).toContain("evidence-manifest.json");
      expect(evidenceManifest).toEqual(
        expect.objectContaining({
          sceneProbes: [
            expect.objectContaining({
              sceneId: "scene-one",
              status: "static",
            }),
            expect.objectContaining({
              sceneId: "scene-two",
              status: "failed",
            }),
          ],
          staticSceneIds: ["scene-one"],
          failedSceneIds: ["scene-two"],
        }),
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("preserves generated ffmpeg probe failures as evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-evidence-"));
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(root, "draft.mp4"), "draft");
    await writeFile(join(root, "scene.webm"), "scene");
    const failing = "#!/bin/sh\necho unavailable >&2\nexit 1\n";
    await writeFile(join(bin, "ffmpeg"), failing, { mode: 0o755 });
    await writeFile(join(bin, "ffprobe"), failing, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const evidence = await inspectDraftCompositeEvidence({
        captureManifest: {
          ...({} as CaptureManifest),
          qualityFindings: [],
          scenes: [
            {
              durationSeconds: 1.2,
              sceneId: "scene-one",
              sectionId: "demo-script",
              videoPath: join(root, "scene.webm"),
            },
          ],
        },
        draftComposite: {
          ...({} as CompositedVideoManifest),
          durationInFrames: 30,
          fps: 30,
          outputVideoPath: join(root, "draft.mp4"),
          runDirectory: root,
        },
      });
      expect(evidence.ffmpegFindings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("ffmpeg sampled-frame extraction failed"),
          expect.stringContaining("ffmpeg contact-sheet generation failed"),
          expect.stringContaining("ffprobe audio probe failed"),
          expect.stringContaining("ffmpeg static-footage probe failed"),
        ]),
      );
      expect(evidence.audioPresent).toBeUndefined();
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("treats missing ffmpeg tools as evidence instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-evidence-"));
    await writeFile(join(root, "draft.mp4"), "draft");
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const evidence = await inspectDraftCompositeEvidence({
        captureManifest: {
          ...({} as CaptureManifest),
          qualityFindings: [],
          scenes: [],
        },
        draftComposite: {
          ...({} as CompositedVideoManifest),
          durationInFrames: 30,
          fps: 30,
          outputVideoPath: join(root, "draft.mp4"),
          runDirectory: root,
        },
      });
      expect(evidence.ffmpegFindings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("ffmpeg sampled-frame extraction failed"),
          expect.stringContaining("ffprobe audio probe failed"),
        ]),
      );
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("bounds hanging ffmpeg evidence commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-evidence-"));
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(root, "draft.mp4"), "draft");
    const hanging = `#!${process.execPath}\nsetTimeout(() => {}, 60_000);\n`;
    await writeFile(join(bin, "ffmpeg"), hanging, { mode: 0o755 });
    await writeFile(join(bin, "ffprobe"), hanging, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const startedAt = Date.now();
      const evidence = await inspectDraftCompositeEvidence({
        captureManifest: {
          ...({} as CaptureManifest),
          qualityFindings: [],
          scenes: [],
        },
        draftComposite: {
          ...({} as CompositedVideoManifest),
          durationInFrames: 30,
          fps: 30,
          outputVideoPath: join(root, "draft.mp4"),
          runDirectory: root,
        },
        timeoutMs: 25,
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(evidence.ffmpegFindings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("timed out after 25ms"),
        ]),
      );
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { force: true, recursive: true });
    }
  });
});
