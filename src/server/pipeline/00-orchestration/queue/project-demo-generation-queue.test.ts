import { describe, expect, it } from "vitest";

import { createRecordingPipelineObserver } from "../job/pipeline-observer";
import { processNextProjectDemoGenerationJob } from "./project-demo-generation-queue";

describe("processNextProjectDemoGenerationJob", () => {
  it("claims one queued Project and completes it only after the reviewed full pipeline stores the video", async () => {
    const calls: string[] = [];
    const store = {
      async claimNextQueuedProject() {
        calls.push("claim");
        return queuedProjectJob();
      },
      async markProjectCompleted(input: {
        generatedDemoUrl: string;
        projectId: string;
      }) {
        calls.push("complete");
        expect(input).toEqual({
          generatedDemoUrl: "r2://owlet/demo-videos/demo-request-1/final.mp4",
          projectId: "project-1",
        });
      },
      async markProjectFailed() {
        throw new Error("project should not fail");
      },
    };

    const result = await processNextProjectDemoGenerationJob(store, {
      async runFullPipeline(input) {
        calls.push("full-pipeline");
        expect(input.demoRequestId).toBe("demo-request-1");
        expect(input.repoUrl).toBe("https://github.com/example/app");
        expect(input.demoBrief.keyProductFeatures).toEqual([
          "script generation",
        ]);
        return {
          generatedDemoUrl: "r2://owlet/demo-videos/demo-request-1/final.mp4",
        };
      },
    });

    expect(result).toEqual({
      projectId: "project-1",
      status: "completed",
    });
    expect(calls).toEqual(["claim", "full-pipeline", "complete"]);
  });

  it("claims one queued Project and completes it after the full pipeline stores the generated video", async () => {
    const calls: string[] = [];
    const store = {
      async claimNextQueuedProject() {
        calls.push("claim");
        return queuedProjectJob();
      },
      async markProjectCompleted(input: {
        generatedDemoUrl: string;
        projectId: string;
      }) {
        calls.push("complete");
        expect(input).toEqual({
          generatedDemoUrl:
            "r2://owlet/demo-videos/demo-request-1/full/final.mp4",
          projectId: "project-1",
        });
      },
      async markProjectFailed() {
        throw new Error("project should not fail");
      },
    };

    const result = await processNextProjectDemoGenerationJob(store, {
      async runFullPipeline(input) {
        calls.push("full-pipeline");
        expect(input.demoRequestId).toBe("demo-request-1");
        expect(input.repoUrl).toBe("https://github.com/example/app");
        return {
          generatedDemoUrl:
            "r2://owlet/demo-videos/demo-request-1/full/final.mp4",
        };
      },
    });

    expect(result).toEqual({
      projectId: "project-1",
      status: "completed",
    });
    expect(calls).toEqual(["claim", "full-pipeline", "complete"]);
  });

  it("reports structured job observability events when a Project is claimed and completed", async () => {
    const observer = createRecordingPipelineObserver();
    let now = 2_000;

    const result = await processNextProjectDemoGenerationJob(
      {
        async claimNextQueuedProject() {
          return queuedProjectJob();
        },
        async markProjectCompleted() {},
        async markProjectFailed() {
          throw new Error("project should not fail");
        },
      },
      {
        async runFullPipeline() {
          now += 200;
          return {
            generatedDemoUrl: "r2://owlet/demo-videos/demo-request-1/final.mp4",
          };
        },
      },
      {
        now: () => now,
        observer,
      },
    );

    expect(result).toEqual({
      projectId: "project-1",
      status: "completed",
    });
    expect(observer.events).toEqual([
      {
        demoRequestId: "demo-request-1",
        event: "job.claimed",
        projectId: "project-1",
        status: "claimed",
        workspaceId: "project-1",
      },
      {
        demoRequestId: "demo-request-1",
        durationMs: 200,
        event: "job.completed",
        projectId: "project-1",
        status: "completed",
        workspaceId: "project-1",
      },
    ]);
  });

  it("marks the claimed Project failed when downstream generation fails", async () => {
    const calls: string[] = [];
    const store = {
      async claimNextQueuedProject() {
        calls.push("claim");
        return queuedProjectJob();
      },
      async markProjectCompleted() {
        throw new Error("project should not complete");
      },
      async markProjectFailed(input: { error: string; projectId: string }) {
        calls.push("fail");
        expect(input).toEqual({
          error: "renderer failed",
          projectId: "project-1",
        });
      },
    };

    const result = await processNextProjectDemoGenerationJob(store, {
      async runFullPipeline() {
        calls.push("full-pipeline");
        throw new Error("renderer failed");
      },
    });

    expect(result).toEqual({
      projectId: "project-1",
      status: "failed",
    });
    expect(calls).toEqual(["claim", "full-pipeline", "fail"]);
  });

  it("stays idle when no Project is queued", async () => {
    const result = await processNextProjectDemoGenerationJob(
      {
        async claimNextQueuedProject() {
          return undefined;
        },
        async markProjectCompleted() {
          throw new Error("project should not complete");
        },
        async markProjectFailed() {
          throw new Error("project should not fail");
        },
      },
      {
        async runFullPipeline() {
          throw new Error("pipeline should not run");
        },
      },
    );

    expect(result).toEqual({ status: "idle" });
  });
});

function queuedProjectJob() {
  return {
    demoBrief: {
      audience: "Founders",
      keyProductFeatures: ["script generation"],
    },
    demoRequestId: "demo-request-1",
    normalizedSupportingDocuments: [],
    projectId: "project-1",
    repoUrl: "https://github.com/example/app",
    workspaceId: "project-1",
  };
}
