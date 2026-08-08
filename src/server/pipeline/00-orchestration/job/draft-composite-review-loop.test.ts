import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAgentSession } from "../../../test-support/create-agent-session";
import { createApplicationIdentityBaseline } from "../../03-repo-preparation/application-identity-evidence";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { CaptureManifest } from "../../06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "../../07-compositing/composite-video";
import {
  type DraftCompositeReviewLoopInput,
  runDraftCompositeReviewLoop,
} from "./draft-composite-review-loop";
import { PipelineCancellationError } from "./pipeline-cancellation";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

describe("runDraftCompositeReviewLoop", () => {
  it("does not start Compositing after the Pipeline deadline cancels Footage Capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const calls: string[] = [];
    const controller = new AbortController();
    try {
      const input = loopInput(root, {
        captureScenes: async () => {
          calls.push("capture");
          controller.abort(new PipelineCancellationError("deadline-exceeded"));
          return captureManifest(root, "capture-1");
        },
        compositeVideo: async () => {
          calls.push("composite");
          return compositeManifest(root, "composite-1");
        },
        reviewDraftComposite: async () => {
          calls.push("review");
          return { decision: "accept" };
        },
      });
      input.options.signal = controller.signal;

      await expect(runDraftCompositeReviewLoop(input)).rejects.toMatchObject({
        reason: "deadline-exceeded",
      });
      expect(calls).toEqual(["capture"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("settles an active submitted-code capture command before propagating Pipeline cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const events: string[] = [];
    const controller = new AbortController();
    let settleCapture: (() => void) | undefined;
    try {
      const input = loopInput(root, {
        captureScenes: async () => {
          events.push("capture-started");
          controller.abort(new PipelineCancellationError("deadline-exceeded"));
          await new Promise<void>((resolve) => {
            settleCapture = resolve;
          });
          events.push("capture-settled");
          return captureManifest(root, "capture-1");
        },
        compositeVideo: async () => {
          events.push("composite-started");
          return compositeManifest(root, "composite-1");
        },
      });
      input.options.signal = controller.signal;
      const workspace = input.preparedDemo.preparationWorkspace?.workspace;
      if (workspace === undefined) throw new Error("Expected test workspace.");
      workspace.cancelActiveCommands = async () => {
        events.push("capture-cancelled");
        settleCapture?.();
      };

      await expect(runDraftCompositeReviewLoop(input)).rejects.toMatchObject({
        reason: "deadline-exceeded",
      });
      expect(events).toEqual([
        "capture-started",
        "capture-cancelled",
        "capture-settled",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("settles active Compositing before propagating Pipeline cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const events: string[] = [];
    const controller = new AbortController();
    let compositingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      compositingStarted = resolve;
    });
    try {
      const input = loopInput(root, {
        compositeVideo: async (compositeInput) => {
          events.push("compositing-started");
          compositingStarted?.();
          await new Promise<void>((_resolve, reject) => {
            compositeInput.signal?.addEventListener(
              "abort",
              () => {
                events.push("compositing-settled");
                reject(compositeInput.signal?.reason);
              },
              { once: true },
            );
          });
          return compositeManifest(root, "composite-1");
        },
      });
      input.options.signal = controller.signal;
      const review = runDraftCompositeReviewLoop(input);

      await started;
      controller.abort(new PipelineCancellationError("deadline-exceeded"));

      await expect(review).rejects.toMatchObject({
        reason: "deadline-exceeded",
      });
      expect(events).toEqual(["compositing-started", "compositing-settled"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("settles active evidence generation before propagating Pipeline cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const events: string[] = [];
    const controller = new AbortController();
    let evidenceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      evidenceStarted = resolve;
    });
    try {
      const input = loopInput(root);
      input.options.signal = controller.signal;
      input.options.inspectDraftCompositeEvidence = async (evidenceInput) => {
        const signal = (
          evidenceInput as typeof evidenceInput & { signal?: AbortSignal }
        ).signal;
        events.push("evidence-started");
        evidenceStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              events.push("evidence-settled");
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return {
          audioPresent: true,
          contactSheetPaths: [],
          ffmpegFindings: [],
          sampledFramePaths: [],
          staticSceneIds: [],
        };
      };
      const review = runDraftCompositeReviewLoop(input);

      await started;
      controller.abort(new PipelineCancellationError("deadline-exceeded"));

      await expect(review).rejects.toMatchObject({
        reason: "deadline-exceeded",
      });
      expect(events).toEqual(["evidence-started", "evidence-settled"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

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

  it("keeps the private Draft Composite and sampled evidence available through review", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const draftPath = join(root, "composite-1.mp4");
    const sampledFramePath = join(root, "sample-001.jpg");
    try {
      const input = loopInput(root, {
        compositeVideo: async () => {
          await writeFile(draftPath, "private draft");
          return {
            ...compositeManifest(root, "composite-1"),
            outputVideoPath: draftPath,
            viewUrl: `file://${draftPath}`,
          };
        },
        reviewDraftComposite: async ({ derivedEvidence }) => {
          expect(derivedEvidence).toMatchObject({
            rawDraftCompositePath: draftPath,
            sampledFramePaths: [sampledFramePath],
          });
          await expect(stat(draftPath)).resolves.toBeTruthy();
          return { decision: "accept" };
        },
      });
      input.options.inspectDraftCompositeEvidence = async ({
        draftComposite,
      }) => {
        expect(draftComposite.outputVideoPath).toBe(draftPath);
        await expect(stat(draftPath)).resolves.toBeTruthy();
        return {
          audioPresent: true,
          contactSheetPaths: [],
          ffmpegFindings: [],
          sampledFramePaths: [sampledFramePath],
          staticProbeFailedSceneIds: [],
          staticSceneIds: [],
        };
      };

      await expect(runDraftCompositeReviewLoop(input)).resolves.toMatchObject({
        finalVideo: { outputVideoPath: draftPath },
        reviewSummary: { status: "accepted" },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports Footage Capture, Compositing, and Draft Composite review chronologically", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const progress: Array<{ stage: string; status: string }> = [];
    try {
      const input = loopInput(root);
      input.options.onProgress = (event) => {
        progress.push(event);
      };

      await runDraftCompositeReviewLoop(input);

      expect(progress).toEqual([
        { stage: "footage-capture", status: "started" },
        { stage: "footage-capture", status: "succeeded" },
        { stage: "compositing", status: "started" },
        { stage: "compositing", status: "succeeded" },
        { stage: "draft-composite-review", status: "started" },
        { stage: "draft-composite-review", status: "succeeded" },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("repairs a Demo Script, revalidates it, and persists only the valid candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const calls: string[] = [];
    let persisted = 0;
    try {
      const dependencies = loopDependencies(() => {});
      dependencies.repairCapturePathFailure = async (input) => ({
        preparationManifest: input.preparationManifest,
        demoScript: { ...input.demoScript, scriptId: "repaired" },
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
      expect(result.preparedDemo.demoScript.scriptId).toBe("repaired");
      expect(persisted).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails identity review when Draft Composite Demo Script repair changes reviewed source", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    let repairChangedSource = false;
    let captureCalls = 0;
    try {
      const dependencies = loopDependencies(() => {});
      dependencies.repairCapturePathFailure = async (input) => {
        repairChangedSource = true;
        return {
          preparationManifest: input.preparationManifest,
          demoScript: { ...input.demoScript, scriptId: "repaired" },
        };
      };
      const input = loopInput(root, {
        dependencies,
        captureScenes: async (captureInput) => {
          captureCalls += 1;
          return captureManifest(root, captureInput.runId ?? "capture");
        },
        reviewDraftComposite: async ({ attempt }) =>
          attempt === 1
            ? {
                decision: "repair",
                reason: "Fix the flow.",
                repairScope: "demo-script",
              }
            : { decision: "accept" },
      });
      input.preparedDemo.preparationWorkspace.workspace.capturePreparedWorkspaceDiff =
        async () =>
          repairChangedSource
            ? reviewedPreparedWorkspaceDiff({
                artifactId: "workspace-diff:sha256:changed-after-draft",
                createdPaths: ["src/replacement-dashboard.tsx"],
                patch:
                  "diff --git a/src/replacement-dashboard.tsx b/src/replacement-dashboard.tsx\n+replacement\n",
              })
            : reviewedPreparedWorkspaceDiff();

      await expect(runDraftCompositeReviewLoop(input)).rejects.toMatchObject({
        identityReview: {
          failureKind: "identity-not-proven",
          verdict: "fail",
        },
      });
      expect(captureCalls).toBe(1);
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
      const dependencies = loopDependencies(() => {
        stageRuns += 1;
      });
      const prepareRepo = dependencies.prepareRepo;
      dependencies.prepareRepo = async (input) => {
        const result = await prepareRepo(input);
        if (result.status !== "succeeded" || result.workspace === undefined) {
          return result;
        }
        const repairedDiff = reviewedPreparedWorkspaceDiff({
          artifactId: "repair-diff",
          modifiedPaths: ["src/App.tsx"],
          patch: "diff --git a/src/App.tsx b/src/App.tsx\n+repair\n",
        });
        result.workspace.workspace.capturePreparedWorkspaceDiff = async () =>
          repairedDiff;
        return {
          ...result,
          manifest: {
            ...result.manifest,
            diffArtifactId: repairedDiff.artifactId,
          },
          preparedWorkspaceDiff: repairedDiff,
        };
      };
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
      expect(
        result.preparedDemo.identityEvidenceSource.preparedWorkspaceDiff,
      ).toMatchObject({
        artifactId: "repair-diff",
        patchSha256: sha256(
          "diff --git a/src/App.tsx b/src/App.tsx\n+repair\n",
        ),
      });
      expect(stageRuns).toBe(1);
      expect(persisted).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("propagates a workspace repair identity rejection instead of restoring the previous draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    let captureCalls = 0;
    try {
      const dependencies = loopDependencies(() => {});
      dependencies.reviewPreparedApplicationIdentity = async () => ({
        explanation:
          "The repaired workspace replaced the submitted application.",
        failureKind: "replacement-detected",
        mockedBoundaries: [],
        nativeSurfacesRendered: [],
        replacementEvidence: ["prepared-workspace-diff:sha256:replacement"],
        sourceCitations: [{ endLine: 20, path: "src/App.tsx", startLine: 1 }],
        status: "succeeded",
        verdict: "fail",
      });

      await expect(
        runDraftCompositeReviewLoop(
          loopInput(root, {
            dependencies,
            captureScenes: async (input) => {
              captureCalls += 1;
              return captureManifest(root, input.runId ?? "capture");
            },
            reviewDraftComposite: async () => ({
              decision: "repair",
              reason: "Workspace needs repair.",
              repairScope: "workspace",
            }),
          }),
        ),
      ).rejects.toMatchObject({
        identityReview: {
          failureKind: "replacement-detected",
          verdict: "fail",
        },
        name: "PreparedWorkspaceIdentitySealError",
      });
      expect(captureCalls).toBe(1);
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
      overrides.dependencies ?? loopDependencies(() => succeededPreparedDemo()),
    input: {
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      demoBrief: { keyProductFeatures: ["article feed"] },
      normalizedSupportingDocuments: [],
      preparationWorkspace: preparationWorkspaceHandle(),
      repoSecurity: { scannerReports: [] },
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
  onPrepare: () => void,
): PipelineOrchestratorDependencies {
  return {
    generateDemoScript: async () => succeededPreparedDemo().demoScript,
    prepareRepo: async () => {
      onPrepare();
      const accessibilityText = "main: Native article feed";
      return {
        applicationIdentityBaseline: createApplicationIdentityBaseline({
          pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
          repoUrl: "https://github.com/example/app",
          sourceControlledPaths: ["src/App.tsx"],
          sourceTreeObjectId: "1111111111111111111111111111111111111111",
        }),
        manifest: succeededPreparedDemo().preparationManifest,
        preparedWorkspaceDiff: {
          artifactId: "diff",
          createdPaths: [],
          deletedPaths: [],
          modifiedPaths: [],
          patch: "",
          patchSha256: sha256(""),
          sizeBytes: 0,
        },
        agentSession: createAgentSession(),
        runtimePreflight: {
          accessibilitySnapshot: {
            sha256: sha256(accessibilityText),
            sizeBytes: Buffer.byteLength(accessibilityText),
            text: accessibilityText,
          },
          blockedNetworkAttempts: [],
          logs: [],
          screenshot: {
            mimeType: "image/png" as const,
            path: "/tmp/prepared-app.png",
            sha256: sha256("prepared-app-screenshot"),
          },
          status: "succeeded" as const,
          warnings: [],
        },
        workspace: preparationWorkspaceHandle(),
        status: "succeeded",
      };
    },
    reviewPreparedApplicationIdentity: async () => ({
      explanation: "The prepared runtime renders the submitted native UI.",
      mockedBoundaries: [],
      nativeSurfacesRendered: ["src/App.tsx"],
      replacementEvidence: [],
      sourceCitations: [{ endLine: 12, path: "src/App.tsx", startLine: 1 }],
      status: "succeeded",
      verdict: "pass",
    }),
    reviewRepoSecurity: async () => ({
      concerns: [],
      rationale: "Test fixture approval.",
      status: "succeeded",
      verdict: "approved",
    }),
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
      demoScript: succeededPreparedDemo().demoScript,
    }),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function succeededPreparedDemo(): DraftCompositeReviewLoopInput["preparedDemo"] {
  const accessibilityText = "main: Native article feed";
  const preparationManifest = {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo",
    diffArtifactId: "diff",
    existingDemoEvidence: [],
    mockingPlan: {
      boundaries: [],
      fixturePaths: [],
      loadedPlaybooks: [],
      nativeUiRoots: ["src/App.tsx"],
      plannedPresentationChanges: [],
    },
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared app.",
    status: "adapted-existing-demo" as const,
    url: "http://localhost:3000/",
    workspaceId: "workspace_123",
  };
  const preparedWorkspaceDiff = reviewedPreparedWorkspaceDiff();
  return {
    capturePathValidation: {
      browserUrl: "https://preview.example.test/",
      status: "succeeded",
      blockedNetworkAttempts: [],
      logs: [],
      warnings: [],
    },
    demoScript: {
      demoPlaywrightScript: "",
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
    identityEvidenceSource: {
      applicationIdentityBaseline: createApplicationIdentityBaseline({
        pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
        repoUrl: "https://github.com/example/app",
        sourceControlledPaths: ["src/App.tsx"],
        sourceTreeObjectId: "1111111111111111111111111111111111111111",
      }),
      manifest: preparationManifest,
      preparedWorkspaceDiff,
      runtimePreflight: {
        accessibilitySnapshot: {
          sha256: sha256(accessibilityText),
          sizeBytes: Buffer.byteLength(accessibilityText),
          text: accessibilityText,
        },
        blockedNetworkAttempts: [],
        logs: [],
        screenshot: {
          mimeType: "image/png",
          path: "/tmp/prepared-app.png",
          sha256: sha256("prepared-app-screenshot"),
        },
        status: "succeeded",
        warnings: [],
      },
    },
    preparationManifest,
    preparationWorkspace: preparationWorkspaceHandle(),
    reviewedPreparedWorkspaceDiff: preparedWorkspaceDiff,
    status: "succeeded",
  };
}

function reviewedPreparedWorkspaceDiff(
  input: {
    artifactId?: string;
    createdPaths?: string[];
    deletedPaths?: string[];
    modifiedPaths?: string[];
    patch?: string;
  } = {},
) {
  const patch = input.patch ?? "";
  return {
    artifactId: input.artifactId ?? "diff",
    createdPaths: input.createdPaths ?? [],
    deletedPaths: input.deletedPaths ?? [],
    modifiedPaths: input.modifiedPaths ?? [],
    patch,
    patchSha256: sha256(patch),
    sizeBytes: Buffer.byteLength(patch),
  };
}

function preparationWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async capturePreparedWorkspaceDiff() {
        return reviewedPreparedWorkspaceDiff();
      },
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
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
