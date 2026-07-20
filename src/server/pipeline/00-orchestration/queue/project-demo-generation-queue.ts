import type { DemoBrief } from "../../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../../01-context-gathering/supporting-documents";
import {
  type PipelineObserver,
  noopPipelineObserver,
  sanitizeObservabilityError,
} from "../job/pipeline-observer";

type ProjectDemoGenerationJob = {
  demoBrief: DemoBrief;
  demoRequestId: string;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  projectId: string;
  repoUrl: string;
  workspaceId: string;
};

export type ProjectDemoGenerationResult =
  | {
      projectId?: undefined;
      status: "idle";
    }
  | {
      projectId: string;
      status: "completed";
    }
  | {
      projectId: string;
      status: "failed";
    };

/**
 * Claims and records status for the single Project-backed demo generation queue.
 * Implementations must make `claimNextQueuedProject` move exactly one queued
 * Project to processing before returning it, and must store queue state only on
 * Project records.
 */
export interface ProjectDemoGenerationQueueStore {
  claimNextQueuedProject(): Promise<ProjectDemoGenerationJob | undefined>;
  markProjectCompleted(input: {
    generatedDemoUrl: string;
    projectId: string;
  }): Promise<void>;
  markProjectFailed(input: { error: string; projectId: string }): Promise<void>;
}

type GeneratedFinalVideo = {
  generatedDemoUrl: string;
};

export type ProjectFullPipelineGenerationDependencies = {
  runFullPipeline(
    input: ProjectDemoGenerationJob,
  ): Promise<GeneratedFinalVideo>;
};

export type ProjectDemoGenerationOptions = {
  now?: () => number;
  observer?: PipelineObserver;
};

export async function processNextProjectDemoGenerationJob(
  store: ProjectDemoGenerationQueueStore,
  dependencies: ProjectFullPipelineGenerationDependencies,
  options: ProjectDemoGenerationOptions = {},
): Promise<ProjectDemoGenerationResult> {
  const observer = options.observer ?? noopPipelineObserver;
  const now = options.now ?? Date.now;
  const job = await store.claimNextQueuedProject();
  if (!job) {
    return { status: "idle" };
  }

  const context = {
    demoRequestId: job.demoRequestId,
    projectId: job.projectId,
    workspaceId: job.workspaceId,
  };
  observer.record({
    ...context,
    event: "job.claimed",
    status: "claimed",
  });
  const startedAt = now();

  try {
    const finalVideo = await dependencies.runFullPipeline(job);
    await store.markProjectCompleted({
      generatedDemoUrl: finalVideo.generatedDemoUrl,
      projectId: job.projectId,
    });
    observer.record({
      ...context,
      durationMs: now() - startedAt,
      event: "job.completed",
      status: "completed",
    });

    return { projectId: job.projectId, status: "completed" };
  } catch (error) {
    await store.markProjectFailed({
      error: error instanceof Error ? error.message : "Unknown queue error",
      projectId: job.projectId,
    });
    observer.record({
      ...context,
      ...sanitizeObservabilityError(error),
      durationMs: now() - startedAt,
      event: "job.failed",
      status: "failed",
    });
    return { projectId: job.projectId, status: "failed" };
  }
}
