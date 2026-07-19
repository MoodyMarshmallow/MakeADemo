import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAgentSession } from "../../test-support/create-agent-session";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "../07-compositing/composite-video";
import {
  type DraftCompositeReviewLoopInput,
  runDraftCompositeReviewLoop,
} from "./draft-composite-review-loop";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

describe("runDraftCompositeReviewLoop", () => {
  it("accepts a clean draft without rerunning capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const calls: string[] = [];
    try {
      const result = await runDraftCompositeReviewLoop(
        loopInput(root, {
          reviewDraftComposite: async () => ({ decision: "accept" }),
          captureScenes: async () => {
            calls.push("capture");
            return captureManifest(root, "capture-1");
          },
          compositeVideo: async () => {
            calls.push("composite");
            return compositeManifest(root, "composite-1");
          },
        }),
      );

      expect(result.reviewSummary).toEqual({
        attempts: 1,
        findings: [],
        status: "accepted",
        warnings: [],
      });
      expect(calls).toEqual(["capture", "composite"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("repairs a Demo Script, revalidates it, and persists only the valid candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const calls: string[] = [];
    let persisted = 0;
    try {
      const dependencies = loopDependencies([], () => {});
      dependencies.repairCapturePathFailure = async (input) => ({
        preparationManifest: input.preparationManifest,
        demoScriptPackage: { ...input.demoScriptPackage, scriptId: "repaired" },
      });
      const result = await runDraftCompositeReviewLoop(
        loopInput(root, {
          dependencies,
          captureScenes: async (input) => {
            calls.push(`capture:${input.runId}`);
            return captureManifest(root, input.runId ?? "capture");
          },
          compositeVideo: async (input) => {
            calls.push(`composite:${input.runId}`);
            return compositeManifest(root, input.runId ?? "composite");
          },
          persistScript: async () => {
            persisted += 1;
            return { scriptPath: join(root, "demo-script.json") };
          },
          reviewDraftComposite: async ({ attempt }) =>
            attempt === 1
              ? {
                  decision: "repair",
                  reason: "Fix the flow.",
                  repairScope: "demo-script",
                }
              : { decision: "accept" },
        }),
      );
      expect(result.reviewSummary.status).toBe("accepted");
      expect(calls).toEqual([
        "capture:capture-1",
        "composite:composite-1",
        "capture:capture-2",
        "composite:composite-2",
      ]);
      expect(result.preparedDemo.demoScriptPackage.scriptId).toBe("repaired");
      expect(persisted).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reruns pipeline preparation for workspace repair and persists the repaired script after compositing", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const calls: string[] = [];
    let stageRuns = 0;
    let persisted = 0;
    try {
      const dependencies = loopDependencies(calls, () => {
        stageRuns += 1;
      });
      const result = await runDraftCompositeReviewLoop(
        loopInput(root, {
          dependencies,
          captureScenes: async (input) => {
            calls.push(`capture:${input.runId}`);
            return captureManifest(root, input.runId ?? "capture");
          },
          compositeVideo: async (input) =>
            compositeManifest(root, input.runId ?? "composite"),
          persistScript: async () => {
            persisted += 1;
            return { scriptPath: join(root, "demo-script.json") };
          },
          reviewDraftComposite: async ({ attempt }) =>
            attempt === 1
              ? {
                  decision: "repair",
                  reason: "Workspace needs repair.",
                  repairScope: "workspace",
                }
              : { decision: "accept" },
        }),
      );
      expect(result.reviewSummary.status).toBe("accepted");
      expect(stageRuns).toBe(1);
      expect(persisted).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns the latest valid draft with warnings when repairs are exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const previous = process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
    process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = "1";
    const logEntries: Array<Record<string, unknown>> = [];
    try {
      const result = await runDraftCompositeReviewLoop(
        loopInput(root, {
          log: async (entry) => {
            logEntries.push(entry);
          },
          reviewDraftComposite: async () => ({
            decision: "repair",
            reason: "Still unclear.",
            repairScope: "demo-script",
          }),
        }),
      );
      expect(result.reviewSummary).toEqual({
        attempts: 2,
        findings: [],
        status: "exhausted",
        warnings: [
          "Draft Composite review retry limit exceeded; using latest draft.",
          "Draft Composite review requested repair: Still unclear.",
        ],
      });
      expect(
        logEntries
          .filter(
            (entry) =>
              entry.event === "draft-composite-review-completed" ||
              entry.event === "draft-composite-review-exhausted",
          )
          .map((entry) => entry.severity),
      ).toEqual(["warn", "warn", "warn"]);
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS",
        );
      else process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = previous;
      await rm(root, { force: true, recursive: true });
    }
  });
});

function loopInput(
  root: string,
  overrides: Partial<DraftCompositeReviewLoopInput> & {
    captureScenes?: NonNullable<
      DraftCompositeReviewLoopInput["options"]["captureScenes"]
    >;
    compositeVideo?: NonNullable<
      DraftCompositeReviewLoopInput["options"]["compositeVideo"]
    >;
    reviewDraftComposite?: NonNullable<
      DraftCompositeReviewLoopInput["options"]["reviewDraftComposite"]
    >;
    persistScript?: DraftCompositeReviewLoopInput["persistScript"];
  } = {},
): DraftCompositeReviewLoopInput {
  const options = {
    captureScenes:
      overrides.captureScenes ??
      (async () => captureManifest(root, "capture-1")),
    compositeVideo:
      overrides.compositeVideo ??
      (async () => compositeManifest(root, "composite-1")),
    inspectDraftCompositeEvidence: async () => ({
      audioPresent: true,
      contactSheetPaths: [],
      ffmpegFindings: [],
      sampledFramePaths: [],
      staticProbeFailedSceneIds: [],
      staticSceneIds: [],
    }),
    reviewDraftComposite:
      overrides.reviewDraftComposite ??
      (async () => ({ decision: "accept" as const })),
    ...(overrides.dependencies === undefined
      ? {}
      : { dependencies: overrides.dependencies }),
  };
  return {
    browserUrl: "https://preview.example.test/",
    dependencies:
      overrides.dependencies ??
      loopDependencies([], () => succeededPreparedDemo()),
    input: {
      demoBrief: { keyProductFeatures: ["article feed"] },
      normalizedSupportingDocuments: [],
      repoSecurity: {
        files: [{ path: "package.json", text: "{}" }],
        repoStats: { fileCount: 1, sizeBytes: 1 },
      },
      repoUrl: "https://github.com/example/app",
      workspaceId: "workspace_123",
    },
    log: overrides.log ?? (async () => {}),
    options,
    persistScript:
      overrides.persistScript ??
      (async () => ({ scriptPath: join(root, "demo-script.json") })),
    runDirectory: root,
    scriptPersistence: { scriptPath: join(root, "demo-script.json") },
    preparedDemo: succeededPreparedDemo(),
  };
}

function loopDependencies(
  calls: string[],
  onPrepare: () => void,
): PipelineOrchestratorDependencies {
  return {
    generateScriptPackage: async () =>
      succeededPreparedDemo().demoScriptPackage,
    prepareRepo: async () => {
      onPrepare();
      return {
        manifest: succeededPreparedDemo().preparationManifest,
        agentSession: createAgentSession(),
        workspace: preparationWorkspaceHandle(),
        status: "succeeded",
      };
    },
    screenRepoSecurity: () => ({
      rejections: [],
      status: "passed",
      warnings: [],
    }),
    validateCapturePath: async () => ({
      browserUrl: "https://preview.example.test/",
      status: "succeeded",
      blockedNetworkAttempts: [],
      logs: [],
      warnings: [],
    }),
    repairCapturePathFailure: async () => ({
      preparationManifest: succeededPreparedDemo().preparationManifest,
      demoScriptPackage: succeededPreparedDemo().demoScriptPackage,
    }),
  };
}

function succeededPreparedDemo(): DraftCompositeReviewLoopInput["preparedDemo"] {
  return {
    acceptedDemoScript: {
      assumptions: [],
      demoPlan: {
        featureOrder: ["article feed"],
        narrative: "Show the feed.",
        risks: [],
      },
      demoPlaywrightScript: "",
      exploration: {
        assumptions: [],
        productSurfaces: ["article feed"],
        summary: "Prepared app.",
      },
      format: "16:9",
      presentation: {
        music: { enabled: false },
        textOverlays: [],
        transitions: [],
      },
      scenes: [
        {
          expectedVisibleOutcome: "Feed visible.",
          humanReadableDescription: "Show feed.",
          id: "scene_article_feed",
        },
      ],
      scriptId: "script_test",
      title: "Demo",
      version: 1,
    },
    capturePathValidation: {
      browserUrl: "https://preview.example.test/",
      status: "succeeded",
      blockedNetworkAttempts: [],
      logs: [],
      warnings: [],
    },
    demoScriptPackage: {
      assumptions: [],
      demoPlan: {
        featureOrder: ["article feed"],
        narrative: "Show the feed.",
        risks: [],
      },
      demoPlaywrightScript: "",
      exploration: {
        assumptions: [],
        productSurfaces: ["article feed"],
        summary: "Prepared app.",
      },
      format: "16:9",
      presentation: {
        music: { enabled: false },
        textOverlays: [],
        transitions: [],
      },
      scenes: [
        {
          expectedVisibleOutcome: "Feed visible.",
          humanReadableDescription: "Show feed.",
          id: "scene_article_feed",
        },
      ],
      scriptId: "script_test",
      title: "Demo",
      version: 1,
    },
    agentSession: createAgentSession(),
    preparationManifest: {
      assumptions: [],
      createdFiles: [],
      demoCommand: "npm run demo",
      diffArtifactId: "diff",
      existingDemoEvidence: [],
      mockedServices: [],
      modifiedFiles: [],
      repoUrl: "https://github.com/example/app",
      risks: [],
      scriptGenerationContext: [],
      setupSummary: "Prepared app.",
      status: "adapted-existing-demo",
      url: "http://localhost:3000/",
      workspaceId: "workspace_123",
    },
    preparationWorkspace: preparationWorkspaceHandle(),
    status: "succeeded",
  };
}

function preparationWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

function captureManifest(root: string, runId: string): CaptureManifest {
  return {
    baseUrl: "https://preview.example.test/",
    createdAt: "2026-01-01T00:00:00.000Z",
    keepTemp: true,
    manifestPath: join(root, `${runId}.json`),
    qualityFindings: [],
    runDirectory: root,
    runId,
    scenes: [],
    scriptId: "script_test",
    temporary: true,
    title: "Demo",
  };
}

function compositeManifest(
  root: string,
  runId: string,
): CompositedVideoManifest {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    durationInFrames: 30,
    fps: 30,
    manifestPath: join(root, `${runId}.json`),
    outputVideoPath: join(root, `${runId}.mp4`),
    renderPlanPath: join(root, `${runId}-plan.json`),
    runDirectory: root,
    runId,
    scriptId: "script_test",
    title: "Demo",
    viewUrl: `file://${runId}.mp4`,
  };
}
