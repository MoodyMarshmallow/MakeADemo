import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PipelineCancellationError } from "../00-orchestration/job/pipeline-cancellation";
import type { CompositedVideoManifest } from "./composite-video";
import { createFinalVideoPublisher } from "./final-video-publisher";

describe("createFinalVideoPublisher", () => {
  it("uploads, links, and then removes only the selected Draft Composite", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-publish-test-"));
    const outputVideoPath = join(root, "draft.mp4");
    const manifestPath = join(root, "composite-manifest.json");
    const events: string[] = [];
    try {
      await writeFile(outputVideoPath, "reviewed draft");
      const draftComposite: CompositedVideoManifest = {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 90,
        fps: 30,
        manifestPath,
        outputVideoPath,
        renderPlanPath: join(root, "render-plan.json"),
        runDirectory: root,
        runId: "composite-2",
        scriptId: "script-2",
        title: "Reviewed Demo",
        viewUrl: `file://${outputVideoPath}`,
      };
      await writeFile(manifestPath, JSON.stringify(draftComposite));
      const publisher = createFinalVideoPublisher({
        demoRequestId: "request-1",
        demoRequestStore: {
          async linkFinalVideo(input) {
            events.push(`link:${input.generatedDemoUrl}`);
            return {
              finalVideoEmailSentAt: null,
              makerEmail: "maker@example.test",
            };
          },
          async markFinalVideoEmailSent() {
            throw new Error("email must not be marked without a notifier");
          },
        },
        finalVideoStorage: {
          async storeFinalVideo(input) {
            events.push(`upload:${new TextDecoder().decode(input.body)}`);
            expect(input).toMatchObject({
              demoRequestId: "request-1",
              scriptId: "script-2",
            });
            return {
              key: "videos/request-1/composite-2.mp4",
              r2Url: "r2://videos/request-1/composite-2.mp4",
            };
          },
        },
      });

      const publication = await publisher.publishFinalVideo({ draftComposite });

      expect(events).toEqual([
        "upload:reviewed draft",
        "link:r2://videos/request-1/composite-2.mp4",
      ]);
      expect(publication).toMatchObject({
        warnings: [],
      });
      expect(publication.finalVideo).toMatchObject({
        finalVideo: {
          key: "videos/request-1/composite-2.mp4",
          r2Url: "r2://videos/request-1/composite-2.mp4",
        },
        viewUrl: "r2://videos/request-1/composite-2.mp4",
      });
      expect(publication.finalVideo.outputVideoPath).toBeUndefined();
      await expect(stat(outputVideoPath)).rejects.toThrow();
      await expect(
        readFile(manifestPath, "utf8").then((text) => JSON.parse(text)),
      ).resolves.toEqual(publication.finalVideo);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("notifies the maker after linking and can retain the reviewed local output", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-publish-test-"));
    const outputVideoPath = join(root, "draft.mp4");
    const manifestPath = join(root, "composite-manifest.json");
    const events: string[] = [];
    try {
      await writeFile(outputVideoPath, "reviewed draft");
      const draftComposite: CompositedVideoManifest = {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 90,
        fps: 30,
        manifestPath,
        outputVideoPath,
        renderPlanPath: join(root, "render-plan.json"),
        runDirectory: root,
        runId: "composite-1",
        scriptId: "script-1",
        title: "Reviewed Demo",
        viewUrl: `file://${outputVideoPath}`,
      };
      await writeFile(manifestPath, JSON.stringify(draftComposite));
      const publisher = createFinalVideoPublisher({
        demoRequestId: "request-1",
        demoRequestStore: {
          async linkFinalVideo() {
            events.push("link");
            return {
              finalVideoEmailSentAt: null,
              makerEmail: "maker@example.test",
            };
          },
          async markFinalVideoEmailSent(input) {
            events.push(`mark-email:${input.demoRequestId}`);
          },
        },
        finalVideoEmailNotifier: {
          async sendFinalVideoReadyEmail(input) {
            events.push(`email:${input.videoUrl}`);
            expect(input).toMatchObject({
              title: "Reviewed Demo",
              to: "maker@example.test",
            });
          },
        },
        finalVideoStorage: {
          async storeFinalVideo() {
            events.push("upload");
            return { key: "final.mp4", r2Url: "r2://videos/final.mp4" };
          },
        },
        publicAppBaseUrl: "https://makeademo.example/",
        retainLocalOutput: true,
      });

      const publication = await publisher.publishFinalVideo({ draftComposite });

      expect(events).toEqual([
        "upload",
        "link",
        "email:https://makeademo.example/api/demo-requests/request-1/video",
        "mark-email:request-1",
      ]);
      expect(publication).toMatchObject({ warnings: [] });
      expect(publication.finalVideo.outputVideoPath).toBe(outputVideoPath);
      await expect(stat(outputVideoPath)).resolves.toBeTruthy();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops after an in-flight upload settles when publication is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-publish-test-"));
    const outputVideoPath = join(root, "draft.mp4");
    const events: string[] = [];
    let finishUpload: (() => void) | undefined;
    let reportUploadStarted: (() => void) | undefined;
    const uploadStarted = new Promise<void>((resolve) => {
      reportUploadStarted = resolve;
    });
    const uploadCanFinish = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    try {
      await writeFile(outputVideoPath, "reviewed draft");
      const draftComposite: CompositedVideoManifest = {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 90,
        fps: 30,
        manifestPath: join(root, "composite-manifest.json"),
        outputVideoPath,
        renderPlanPath: join(root, "render-plan.json"),
        runDirectory: root,
        runId: "composite-1",
        scriptId: "script-1",
        title: "Reviewed Demo",
        viewUrl: `file://${outputVideoPath}`,
      };
      const publisher = createFinalVideoPublisher({
        demoRequestId: "request-1",
        demoRequestStore: {
          async linkFinalVideo() {
            events.push("link");
            return {
              finalVideoEmailSentAt: null,
              makerEmail: "maker@example.test",
            };
          },
          async markFinalVideoEmailSent() {},
        },
        finalVideoStorage: {
          async storeFinalVideo() {
            events.push("upload");
            reportUploadStarted?.();
            await uploadCanFinish;
            return { key: "final.mp4", r2Url: "r2://videos/final.mp4" };
          },
        },
      });
      const controller = new AbortController();
      const publication = publisher.publishFinalVideo({
        draftComposite,
        signal: controller.signal,
      });
      await uploadStarted;
      controller.abort(new PipelineCancellationError("signal"));
      finishUpload?.();

      await expect(publication).rejects.toMatchObject({ reason: "signal" });
      expect(events).toEqual(["upload"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("finishes notification bookkeeping when cancellation arrives while the durable link commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-publish-test-"));
    const outputVideoPath = join(root, "draft.mp4");
    const events: string[] = [];
    let finishLink: (() => void) | undefined;
    let reportLinkStarted: (() => void) | undefined;
    const linkStarted = new Promise<void>((resolve) => {
      reportLinkStarted = resolve;
    });
    const linkCanFinish = new Promise<void>((resolve) => {
      finishLink = resolve;
    });
    try {
      await writeFile(outputVideoPath, "reviewed draft");
      const draftComposite: CompositedVideoManifest = {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 90,
        fps: 30,
        manifestPath: join(root, "composite-manifest.json"),
        outputVideoPath,
        renderPlanPath: join(root, "render-plan.json"),
        runDirectory: root,
        runId: "composite-1",
        scriptId: "script-1",
        title: "Reviewed Demo",
        viewUrl: `file://${outputVideoPath}`,
      };
      const publisher = createFinalVideoPublisher({
        demoRequestId: "request-1",
        demoRequestStore: {
          async linkFinalVideo() {
            events.push("link-started");
            reportLinkStarted?.();
            await linkCanFinish;
            events.push("link-committed");
            return {
              finalVideoEmailSentAt: null,
              makerEmail: "maker@example.test",
            };
          },
          async markFinalVideoEmailSent() {
            events.push("marked");
          },
        },
        finalVideoEmailNotifier: {
          async sendFinalVideoReadyEmail() {
            events.push("emailed");
          },
        },
        finalVideoStorage: {
          async storeFinalVideo() {
            events.push("uploaded");
            return { key: "final.mp4", r2Url: "r2://videos/final.mp4" };
          },
        },
        publicAppBaseUrl: "https://makeademo.example",
        retainLocalOutput: true,
      });
      const controller = new AbortController();
      const publication = publisher.publishFinalVideo({
        draftComposite,
        onPublicationCommitted() {
          events.push("commit-reported");
        },
        signal: controller.signal,
      });
      await linkStarted;
      controller.abort(new PipelineCancellationError("signal"));
      finishLink?.();

      await expect(publication).resolves.toMatchObject({
        finalVideo: { finalVideo: { key: "final.mp4" } },
        warnings: [],
      });
      expect(events).toEqual([
        "uploaded",
        "link-started",
        "link-committed",
        "commit-reported",
        "emailed",
        "marked",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("finishes the sent marker when cancellation arrives during email delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-publish-test-"));
    const outputVideoPath = join(root, "draft.mp4");
    let finishEmail: (() => void) | undefined;
    let reportEmailStarted: (() => void) | undefined;
    const events: string[] = [];
    const emailStarted = new Promise<void>((resolve) => {
      reportEmailStarted = resolve;
    });
    const emailCanFinish = new Promise<void>((resolve) => {
      finishEmail = resolve;
    });
    try {
      await writeFile(outputVideoPath, "reviewed draft");
      const draftComposite: CompositedVideoManifest = {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 90,
        fps: 30,
        manifestPath: join(root, "composite-manifest.json"),
        outputVideoPath,
        renderPlanPath: join(root, "render-plan.json"),
        runDirectory: root,
        runId: "composite-1",
        scriptId: "script-1",
        title: "Reviewed Demo",
        viewUrl: `file://${outputVideoPath}`,
      };
      const publisher = createFinalVideoPublisher({
        demoRequestId: "request-1",
        demoRequestStore: {
          async linkFinalVideo() {
            events.push("linked");
            return {
              finalVideoEmailSentAt: null,
              makerEmail: "maker@example.test",
            };
          },
          async markFinalVideoEmailSent() {
            events.push("marked");
          },
        },
        finalVideoEmailNotifier: {
          async sendFinalVideoReadyEmail() {
            events.push("email-started");
            reportEmailStarted?.();
            await emailCanFinish;
            events.push("email-sent");
          },
        },
        finalVideoStorage: {
          async storeFinalVideo() {
            return { key: "final.mp4", r2Url: "r2://videos/final.mp4" };
          },
        },
        publicAppBaseUrl: "https://makeademo.example",
        retainLocalOutput: true,
      });
      const controller = new AbortController();
      const publication = publisher.publishFinalVideo({
        draftComposite,
        signal: controller.signal,
      });
      await emailStarted;
      controller.abort(new PipelineCancellationError("signal"));
      finishEmail?.();

      await expect(publication).resolves.toMatchObject({ warnings: [] });
      expect(events).toEqual([
        "linked",
        "email-started",
        "email-sent",
        "marked",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not send a duplicate email when retrying after the sent marker fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-publish-test-"));
    const outputVideoPath = join(root, "draft.mp4");
    const manifestPath = join(root, "composite-manifest.json");
    let markAttempts = 0;
    let sendAttempts = 0;
    try {
      await writeFile(outputVideoPath, "reviewed draft");
      const draftComposite: CompositedVideoManifest = {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 90,
        fps: 30,
        manifestPath,
        outputVideoPath,
        renderPlanPath: join(root, "render-plan.json"),
        runDirectory: root,
        runId: "composite-retry",
        scriptId: "script-1",
        title: "Reviewed Demo",
        viewUrl: `file://${outputVideoPath}`,
      };
      await writeFile(manifestPath, JSON.stringify(draftComposite));
      const publisher = createFinalVideoPublisher({
        demoRequestId: "request-1",
        demoRequestStore: {
          async linkFinalVideo() {
            return {
              finalVideoEmailSentAt: null,
              makerEmail: "maker@example.test",
            };
          },
          async markFinalVideoEmailSent() {
            markAttempts += 1;
            if (markAttempts === 1) throw new Error("marker unavailable");
          },
        },
        finalVideoEmailNotifier: {
          async sendFinalVideoReadyEmail() {
            sendAttempts += 1;
          },
        },
        finalVideoStorage: {
          async storeFinalVideo() {
            return { key: "final.mp4", r2Url: "r2://videos/final.mp4" };
          },
        },
        publicAppBaseUrl: "https://makeademo.example",
        retainLocalOutput: true,
      });

      await expect(
        publisher.publishFinalVideo({ draftComposite }),
      ).resolves.toMatchObject({
        warnings: [
          {
            code: "email-sent-marker-failed",
            message: "marker unavailable",
          },
        ],
      });
      await expect(
        publisher.publishFinalVideo({ draftComposite }),
      ).resolves.toMatchObject({
        finalVideo: { finalVideo: { key: "final.mp4" } },
        warnings: [],
      });

      expect(sendAttempts).toBe(1);
      expect(markAttempts).toBe(2);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
