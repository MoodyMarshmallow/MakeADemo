import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createPipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import {
  RecordingAgentTaskRunner,
  canonicalDemoScript,
  createAgentWorkspaceFixture,
  createTestPipelineLogger,
} from "../../../test-support/agent-workspace-fixture";
import { createAgentSession } from "../../../test-support/create-agent-session";
import type { DraftCompositeReviewerInput } from "../draft-composite-reviewer.interface";
import { AgenticDraftCompositeReviewer } from "./agentic-draft-composite-reviewer";

type DraftCompositeReviewAgentOptions = {
  draftReviewEvidenceUploadAttemptTimeoutMs?: number;
  draftReviewEvidenceUploadTimeoutMs?: number;
  logger?: PipelineEventLogger;
};

class DraftCompositeReviewAgentFixture {
  private readonly reviewer: AgenticDraftCompositeReviewer;
  readonly runner: RecordingAgentTaskRunner;

  constructor(options: DraftCompositeReviewAgentOptions) {
    const logger = options.logger ?? createPipelineEventLogger({ sinks: [] });
    const runner = new RecordingAgentTaskRunner();
    this.runner = runner;
    this.reviewer = new AgenticDraftCompositeReviewer({
      draftReviewEvidenceUploadAttemptTimeoutMs:
        options.draftReviewEvidenceUploadAttemptTimeoutMs ?? 30_000,
      draftReviewEvidenceUploadRetryDelaysMs: [250],
      draftReviewEvidenceUploadTimeoutMs:
        options.draftReviewEvidenceUploadTimeoutMs ?? 60_250,
      hardTimeoutMs: 1_800_000,
      logger,
      onStatus: () => {},
      runner,
      timeoutMs: 600_000,
    });
  }

  reviewDraftComposite(
    ...input: Parameters<AgenticDraftCompositeReviewer["review"]>
  ) {
    return this.reviewer.review(...input);
  }
}

describe("AgenticDraftCompositeReviewer", () => {
  it("reviews Draft Composites in the same Agent Session with uploaded evidence", async () => {
    const events: unknown[] = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const draftPath = join(reviewDirectory, "draft.mp4");
    const rawTakePath = join(reviewDirectory, "raw.webm");
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    const sampledFramePath = join(reviewDirectory, "sample-001.jpg");
    await writeFile(draftPath, "draft video");
    await writeFile(rawTakePath, "raw take");
    await writeFile(contactSheetPath, "contact sheet");
    await writeFile(sampledFramePath, "sampled frame");
    const agent = new DraftCompositeReviewAgentFixture({});

    const decision = await agent.reviewDraftComposite({
      attempt: 1,
      captureManifest: {
        baseUrl: "https://preview.example.test/",
        createdAt: "2026-01-01T00:00:00.000Z",
        keepTemp: true,
        manifestPath: join(reviewDirectory, "capture-manifest.json"),
        qualityFindings: [],
        rawTakePath,
        runDirectory: reviewDirectory,
        runId: "capture-1",
        scenes: [
          {
            durationSeconds: 5,
            sceneId: "scene_feed",
            sectionId: "demo-script",
            videoPath: join(reviewDirectory, "scene-feed.webm"),
          },
        ],
        scriptId: "script_conduit",
        temporary: true,
        title: "Conduit article feed demo",
      },
      derivedEvidence: {
        contactSheetPaths: [contactSheetPath],
        draftDurationSeconds: 5,
        ffmpegFindings: ["ffprobe audio probe found no audio stream"],
        markerSummary: [{ durationSeconds: 5, sceneId: "scene_feed" }],
        qualityFindings: [],
        rawDraftCompositePath: draftPath,
        rawTakePath,
        sampledFramePaths: [sampledFramePath],
      },
      draftComposite: {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 150,
        fps: 30,
        manifestPath: join(reviewDirectory, "composite-manifest.json"),
        outputVideoPath: draftPath,
        renderPlanPath: join(reviewDirectory, "render-plan.json"),
        runDirectory: reviewDirectory,
        runId: "composite-1",
        scriptId: "script_conduit",
        title: "Conduit article feed demo",
        viewUrl: "file:///tmp/draft.mp4",
      },
      agentSession: createAgentSession(),
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [
          {
            decision: "repair",
            reason: "Missing payoff.",
            repairScope: "demo-script",
          },
        ],
        events,
      }).preparationWorkspace,
      demoScript: canonicalDemoScript(),
    });

    expect(decision).toEqual({
      decision: "repair",
      reason: "Missing payoff.",
      repairScope: "demo-script",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          uploadFiles: [
            {
              destinationPath:
                "/workspace/.makeademo/draft-review/contact-sheet.jpg",
              sourcePath: contactSheetPath,
            },
            {
              destinationPath:
                "/workspace/.makeademo/draft-review/sample-001.jpg",
              sourcePath: sampledFramePath,
            },
            {
              destinationPath: "/workspace/.makeademo/draft-review/draft.mp4",
              sourcePath: draftPath,
            },
          ],
        },
      ]),
    );
    const uploadEventIndex = events.findIndex(
      (event) =>
        typeof event === "object" && event !== null && "uploadFiles" in event,
    );
    expect(uploadEventIndex).toBeGreaterThanOrEqual(0);
    const uploadedFiles = (
      events[uploadEventIndex] as { uploadFiles: Array<{ sourcePath: string }> }
    ).uploadFiles;
    expect(uploadedFiles).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: rawTakePath }),
      ]),
    );
    expect(uploadedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: draftPath }),
      ]),
    );
    expect(agent.runner.calls[0]).toMatchObject({
      stage: "draft-composite-review",
    });
    expect(agent.runner.calls[0]?.taskPrompt.length).toBeLessThan(35_000);
  });

  it("retries a transient Daytona socket closure while uploading Draft Composite evidence", async () => {
    const events: unknown[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    const agent = new DraftCompositeReviewAgentFixture({
      logger: createTestPipelineLogger({
        component: "draft-composite-review-agent",
        logs,
      }),
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [],
        }),
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [{ decision: "accept", reason: "Looks good." }],
          events,
          faults: { transientSocketClosureUploadFiles: 1 },
        }).preparationWorkspace,
      }),
    ).resolves.toEqual({ decision: "accept", reason: "Looks good." });

    expect(
      events.filter(
        (event) =>
          typeof event === "object" && event !== null && "uploadFiles" in event,
      ),
    ).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "draft-composite-review.evidence-upload.retrying",
          level: "warn",
          uploadAttempt: 1,
          nextAttempt: 2,
          delayMs: 250,
          reason: expect.stringContaining("Transient Daytona socket closure"),
          stage: "draft-composite-review",
        }),
      ]),
    );
  });

  it("times out hanging Draft Composite review evidence uploads before agent review", async () => {
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const logger = createTestPipelineLogger({
      component: "draft-composite-review-agent",
      logs: fallbackLogs,
    });
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    const sampledFramePath = join(reviewDirectory, "sample-001.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    await writeFile(sampledFramePath, "sampled frame");
    const agent = new DraftCompositeReviewAgentFixture({
      draftReviewEvidenceUploadTimeoutMs: 5,
      logger,
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [sampledFramePath],
        }),
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [{ decision: "accept", reason: "Looks good." }],
          faults: { neverSettleUploadFiles: true },
        }).preparationWorkspace,
      }),
    ).rejects.toThrow(
      "Draft Composite review evidence upload timed out after 5ms.",
    );

    await logger.flush();
    expect(fallbackLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bytes: 26,
          event: "draft-composite-review.evidence-upload.failed",
          fileCount: 2,
          level: "error",
          reason: "Draft Composite review evidence upload timed out after 5ms.",
          stage: "draft-composite-review",
        }),
      ]),
    );
  });

  it("retries a timed-out Draft Composite evidence upload once", async () => {
    const events: unknown[] = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    const agent = new DraftCompositeReviewAgentFixture({
      draftReviewEvidenceUploadAttemptTimeoutMs: 5,
      draftReviewEvidenceUploadTimeoutMs: 300,
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [],
        }),
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [{ decision: "accept", reason: "Looks good." }],
          events,
          faults: { neverSettleUploadFileAttempts: 1 },
        }).preparationWorkspace,
      }),
    ).resolves.toEqual({ decision: "accept", reason: "Looks good." });

    expect(
      events.filter(
        (event) =>
          typeof event === "object" && event !== null && "uploadFiles" in event,
      ),
    ).toHaveLength(2);
  });

  it("aborts and settles a timed-out evidence upload before retrying", async () => {
    const events: unknown[] = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    const agent = new DraftCompositeReviewAgentFixture({
      draftReviewEvidenceUploadAttemptTimeoutMs: 5,
      draftReviewEvidenceUploadTimeoutMs: 300,
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [],
        }),
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [{ decision: "accept", reason: "Looks good." }],
          events,
          faults: { abortableUploadFileAttempts: 1 },
        }).preparationWorkspace,
      }),
    ).resolves.toEqual({ decision: "accept", reason: "Looks good." });

    expect(events).toEqual(
      expect.arrayContaining([
        { uploadAborted: true },
        { uploadSettled: true, activeUploads: 0 },
      ]),
    );
    const uploadEvents = events.filter(
      (event): event is { uploadFiles: unknown[] } =>
        typeof event === "object" && event !== null && "uploadFiles" in event,
    );
    expect(uploadEvents).toHaveLength(2);
    const firstRetryUploadIndex = events.findIndex(
      (event, index) =>
        index >
          events.findIndex(
            (candidate) =>
              typeof candidate === "object" &&
              candidate !== null &&
              "uploadFiles" in candidate,
          ) &&
        typeof event === "object" &&
        event !== null &&
        "uploadFiles" in event,
    );
    const uploadSettledIndex = events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "uploadSettled" in event &&
        (event as { activeUploads?: number }).activeUploads === 0,
    );
    expect(uploadSettledIndex).toBeGreaterThanOrEqual(0);
    expect(uploadSettledIndex).toBeLessThan(firstRetryUploadIndex);
  });
});

function draftCompositeReviewInput(
  reviewDirectory: string,
  evidence: {
    contactSheetPaths: string[];
    sampledFramePaths: string[];
  },
): Omit<DraftCompositeReviewerInput, "preparationWorkspace"> {
  const draftPath = join(reviewDirectory, "draft.mp4");
  const rawTakePath = join(reviewDirectory, "raw.webm");

  return {
    attempt: 1,
    captureManifest: {
      baseUrl: "https://preview.example.test/",
      createdAt: "2026-01-01T00:00:00.000Z",
      keepTemp: true,
      manifestPath: join(reviewDirectory, "capture-manifest.json"),
      qualityFindings: [],
      rawTakePath,
      runDirectory: reviewDirectory,
      runId: "capture-1",
      scenes: [
        {
          durationSeconds: 5,
          sceneId: "scene_feed",
          sectionId: "demo-script",
          videoPath: join(reviewDirectory, "scene-feed.webm"),
        },
      ],
      scriptId: "script_conduit",
      temporary: true,
      title: "Conduit article feed demo",
    },
    derivedEvidence: {
      ...evidence,
      draftDurationSeconds: 5,
      ffmpegFindings: ["ffprobe audio probe found no audio stream"],
      markerSummary: [{ durationSeconds: 5, sceneId: "scene_feed" }],
      qualityFindings: [],
      rawDraftCompositePath: draftPath,
      rawTakePath,
    },
    draftComposite: {
      createdAt: "2026-01-01T00:00:00.000Z",
      durationInFrames: 150,
      fps: 30,
      manifestPath: join(reviewDirectory, "composite-manifest.json"),
      outputVideoPath: draftPath,
      renderPlanPath: join(reviewDirectory, "render-plan.json"),
      runDirectory: reviewDirectory,
      runId: "composite-1",
      scriptId: "script_conduit",
      title: "Conduit article feed demo",
      viewUrl: "file:///tmp/draft.mp4",
    },
    agentSession: createAgentSession(),
    demoScript: canonicalDemoScript(),
  };
}
