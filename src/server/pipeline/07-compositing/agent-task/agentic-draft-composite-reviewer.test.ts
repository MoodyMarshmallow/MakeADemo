import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  AgentTaskRunInput,
  AgentTaskRunResult,
  AgentTaskRunner,
} from "../../../agent-harness/agent-session-runner.interface";
import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createPipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createAgentSession } from "../../../test-support/create-agent-session";
import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";
import type { DraftCompositeReviewerInput } from "../draft-composite-reviewer.interface";
import { AgenticDraftCompositeReviewer } from "./agentic-draft-composite-reviewer";

type DraftCompositeReviewAgentOptions = {
  draftReviewEvidenceUploadAttemptTimeoutMs?: number;
  draftReviewEvidenceUploadRetryDelaysMs?: readonly number[];
  draftReviewEvidenceUploadTimeoutMs?: number;
  hardTimeoutMs?: number;
  logger?: PipelineEventLogger;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  timeoutMs?: number;
};

/** Recording provider-neutral runner for Draft Composite review stage tests. */
class RecordingAgentSessionRunner implements AgentTaskRunner {
  readonly calls: Array<
    Pick<AgentTaskRunInput, "session" | "stage" | "taskPrompt">
  > = [];

  async run<T>(input: AgentTaskRunInput<T>): Promise<AgentTaskRunResult<T>> {
    this.calls.push({
      stage: input.stage,
      taskPrompt: input.taskPrompt,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
    const result = await input.workspace.execute("recording-agent-turn", {
      env: {},
      timeoutMs: Math.max(1, input.hardDeadlineAt - Date.now()),
    });
    return {
      exitCode: result.exitCode,
      ...(result.exitCode === 0
        ? {}
        : {
            failure: {
              category: "execution" as const,
              message: [result.stderr, result.stdout]
                .filter((line) => line.length > 0)
                .join("\n"),
            },
          }),
      session: input.session ?? createAgentSession(),
    };
  }
}

class DraftCompositeReviewAgentFixture {
  private readonly reviewer: AgenticDraftCompositeReviewer;
  readonly runner: RecordingAgentSessionRunner;

  constructor(options: DraftCompositeReviewAgentOptions) {
    const logger = options.logger ?? createPipelineEventLogger({ sinks: [] });
    const runner = new RecordingAgentSessionRunner();
    this.runner = runner;
    this.reviewer = new AgenticDraftCompositeReviewer({
      draftReviewEvidenceUploadAttemptTimeoutMs:
        options.draftReviewEvidenceUploadAttemptTimeoutMs ?? 30_000,
      draftReviewEvidenceUploadRetryDelaysMs:
        options.draftReviewEvidenceUploadRetryDelaysMs ?? [250],
      draftReviewEvidenceUploadTimeoutMs:
        options.draftReviewEvidenceUploadTimeoutMs ?? 60_250,
      hardTimeoutMs: options.hardTimeoutMs ?? 1_800_000,
      logger,
      onStatus: options.onStdout ?? (() => {}),
      runner,
      timeoutMs: options.timeoutMs ?? 600_000,
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
      preparationWorkspace: workspaceHandle(events, [
        {
          decision: "repair",
          reason: "Missing payoff.",
          repairScope: "demo-script",
        },
      ]),
      scriptPackage: {
        ...interactivePackage(),
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Conduit article feed demo",
          risks: [],
        },
        exploration: {
          assumptions: [],
          productSurfaces: [],
          summary: "Prepared Conduit with local articles.",
        },
      },
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
      logger: testLogger(logs),
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [],
        }),
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          { transientSocketClosureUploadFiles: 1 },
        ),
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
    const events: unknown[] = [];
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const logger = testLogger(fallbackLogs);
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
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          {
            neverSettleUploadFiles: true,
          },
        ),
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
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          { neverSettleUploadFileAttempts: 1 },
        ),
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
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          { abortableUploadFileAttempts: 1 },
        ),
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
    scriptPackage: {
      ...interactivePackage(),
      assumptions: [],
      demoPlan: {
        featureOrder: ["article feed"],
        narrative: "Conduit article feed demo",
        risks: [],
      },
      exploration: {
        assumptions: [],
        productSurfaces: [],
        summary: "Prepared Conduit with local articles.",
      },
    },
  };
}

function preparationManifest() {
  return {
    assumptions: ["auth accepts demo credentials"],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: ["local article API"],
    modifiedFiles: [],
    nativeVisibleInterface: {
      nativeStartupAttempts: ["npm run dev"],
      sourceControlledUiPaths: ["src/App.tsx"],
    },
    repoUrl: "https://github.com/example/conduit",
    risks: [],
    scriptGenerationContext: ["Use hash routes and demo@example.com."],
    setupSummary: "Prepared Conduit with local articles.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId: "workspace_123",
  };
}

function workspaceHandle(
  events: unknown[],
  artifacts: unknown[],
  helperOptions: {
    commandOutputScheduleByRun?: Array<
      Array<{
        afterMs: number;
        channel: "stderr" | "stdout";
        chunk: string;
      }>
    >;
    firstAgentFailure?: { stderr: string; stdout: string };
    neverSettleArtifactReads?: string[];
    neverSettleSandboxLogEvents?: string[];
    neverSettleUploadFiles?: boolean;
    neverSettleUploadFileAttempts?: number;
    abortableUploadFileAttempts?: number;
    transientSocketClosureUploadFiles?: number;
    rejectArtifactReads?: string[];
    rejectSandboxLogEvents?: string[];
    transientSocketClosureArtifactReads?: Record<string, number>;
  } = {},
) {
  let latestArtifact: unknown;
  let agentAttempt = 0;
  let activeUploads = 0;
  const commandOutputScheduleByRun = [
    ...(helperOptions.commandOutputScheduleByRun ?? []),
  ];
  const workspace: PreparationWorkspace = {
    async executeAgentCommand(command, commandOptions) {
      expect(command).toBe("recording-agent-turn");
      agentAttempt += 1;
      if (agentAttempt === 1 && helperOptions.firstAgentFailure) {
        return {
          exitCode: 1,
          stderr: helperOptions.firstAgentFailure.stderr,
          stdout: helperOptions.firstAgentFailure.stdout,
        };
      }
      latestArtifact = artifacts.shift();
      const schedule = commandOutputScheduleByRun.shift();
      if (schedule !== undefined) {
        for (const output of schedule) {
          await new Promise((resolve) => setTimeout(resolve, output.afterMs));
          if (output.channel === "stdout") {
            commandOptions?.onStdout?.(output.chunk);
          } else {
            commandOptions?.onStderr?.(output.chunk);
          }
        }
      } else {
        commandOptions?.onStdout?.("script generation output");
        commandOptions?.onStderr?.("script generation warning");
      }
      return { exitCode: 0, stderr: "", stdout: "generated" };
    },
    async execute(command) {
      if (command.includes("preparation-manifest.json")) {
        const transientSocketClosures =
          helperOptions.transientSocketClosureArtifactReads;
        const remainingSocketClosures =
          transientSocketClosures?.["preparation-manifest.json"];
        if (
          transientSocketClosures !== undefined &&
          remainingSocketClosures !== undefined &&
          remainingSocketClosures > 0
        ) {
          transientSocketClosures["preparation-manifest.json"] =
            remainingSocketClosures - 1;
          throw new Error("The socket connection was closed unexpectedly");
        }
        if (
          helperOptions.rejectArtifactReads?.includes(
            "preparation-manifest.json",
          )
        ) {
          throw new Error("Daytona command did not finish within 600000ms");
        }
        if (
          helperOptions.neverSettleArtifactReads?.includes(
            "preparation-manifest.json",
          )
        ) {
          await new Promise(() => {});
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(preparationManifest()),
        };
      }

      if (command.includes("draft-composite-review.json")) {
        return latestArtifact === undefined
          ? { exitCode: 1, stderr: "missing review", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(latestArtifact) };
      }

      if (command.startsWith("if test -f")) {
        const artifactName = command.includes("demo-script.json")
          ? "demo-script.json"
          : undefined;
        const transientSocketClosures =
          helperOptions.transientSocketClosureArtifactReads;
        const remainingSocketClosures =
          artifactName === undefined
            ? undefined
            : transientSocketClosures?.[artifactName];
        if (
          artifactName !== undefined &&
          transientSocketClosures !== undefined &&
          remainingSocketClosures !== undefined &&
          remainingSocketClosures > 0
        ) {
          transientSocketClosures[artifactName] = remainingSocketClosures - 1;
          throw new Error("The socket connection was closed unexpectedly");
        }
        if (
          command.includes("demo-script.json") &&
          helperOptions.rejectArtifactReads?.includes("demo-script.json")
        ) {
          throw new Error("Daytona command did not finish within 600000ms");
        }
        if (
          command.includes("demo-script.json") &&
          helperOptions.neverSettleArtifactReads?.includes("demo-script.json")
        ) {
          await new Promise(() => {});
        }
        return latestArtifact === undefined
          ? { exitCode: 1, stderr: "", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(latestArtifact) };
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles(files, uploadOptions?: { signal?: AbortSignal }) {
      events.push({ uploadFiles: files });
      activeUploads += 1;
      const settleUpload = () => {
        activeUploads -= 1;
        events.push({ uploadSettled: true, activeUploads });
      };
      if ((helperOptions.abortableUploadFileAttempts ?? 0) > 0) {
        helperOptions.abortableUploadFileAttempts =
          (helperOptions.abortableUploadFileAttempts ?? 0) - 1;
        await new Promise<void>((resolve) => {
          const signal = uploadOptions?.signal;
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            events.push({ uploadAborted: true });
            settleUpload();
            resolve();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) onAbort();
        });
        return;
      }
      if (
        helperOptions.neverSettleUploadFiles ||
        (helperOptions.neverSettleUploadFileAttempts ?? 0) > 0
      ) {
        if ((helperOptions.neverSettleUploadFileAttempts ?? 0) > 0) {
          helperOptions.neverSettleUploadFileAttempts =
            (helperOptions.neverSettleUploadFileAttempts ?? 0) - 1;
        }
        await new Promise<void>((resolve) => {
          const signal = uploadOptions?.signal;
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            events.push({ uploadAborted: true });
            resolve();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) onAbort();
        });
      }
      settleUpload();
      if ((helperOptions.transientSocketClosureUploadFiles ?? 0) > 0) {
        helperOptions.transientSocketClosureUploadFiles =
          (helperOptions.transientSocketClosureUploadFiles ?? 0) - 1;
        throw new Error("The socket connection was closed unexpectedly");
      }
    },
    async cancelActiveCommands() {},
    async writeSandboxLog(entry) {
      if (
        typeof entry.event === "string" &&
        helperOptions.neverSettleSandboxLogEvents?.includes(entry.event)
      ) {
        await new Promise(() => {});
      }
      if (
        typeof entry.event === "string" &&
        helperOptions.rejectSandboxLogEvents?.includes(entry.event)
      ) {
        throw new Error("sandbox log mirror failed");
      }
      events.push({ sandboxLog: entry });
    },
  };

  return {
    async release() {},
    id: "daytona_workspace",
    workspace,
  };
}

function testLogger(logs: Array<Record<string, unknown>>) {
  return createPipelineEventLogger({
    base: { component: "script-generation-agent" },
    sinks: [
      {
        write(line) {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ],
    timestamp: () => "2026-01-01T00:00:00.000Z",
  });
}

function interactivePackage() {
  return {
    audio: { enabled: true, music: { id: "clean" as const } },
    demoPlaywrightScript:
      "import { setup, scene } from './makeademo-capture-sdk';\nawait setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });\nawait scene('scene_feed', async ({ page, expect }) => {\n  await page.getByText('Global Feed').click();\n  await page.getByText('demo').click();\n  await expect(page.getByText('demo')).toBeVisible();\n});",
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "clean" as const },
      textOverlays: [
        {
          content: "Filter the global feed",
          font: "Inter" as const,
          position: "bottom-left" as const,
          sceneId: "scene_feed",
          size: "medium" as const,
        },
      ],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Filtered demo articles are visible.",
        humanReadableDescription: "Filter the global feed by a popular tag.",
        id: "scene_feed",
      },
    ],
    scriptId: "script_conduit",
    title: "Conduit article feed demo",
    version: 1,
  };
}
