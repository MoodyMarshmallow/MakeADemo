import {
  type PipelineEventLogger,
  type PipelineEventLoggerOptions,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";

type WorkerPipelineProgress = {
  stage: string;
  status: "failed" | "retrying" | "started" | "succeeded";
};

type WorkerJobProcessed = {
  projectId: string;
  status: "completed" | "failed";
};

type ProjectDemoGenerationWorkerLoggerOptions = {
  sinks?: PipelineLogSink[];
  timestamp?: PipelineEventLoggerOptions["timestamp"];
};

/**
 * Logs Project demo generation worker events through the pipeline Pino seam.
 * Implementations must keep worker lifecycle, pipeline progress, and job status
 * entries structured so runtime workers do not write ad-hoc stdout/stderr lines.
 */
export type ProjectDemoGenerationWorkerLogger = {
  child(bindings: Record<string, unknown>): PipelineEventLogger;
  flush(): Promise<void>;
  jobProcessed(event: WorkerJobProcessed): Promise<void>;
  pipelineProgress(event: WorkerPipelineProgress): Promise<void>;
  workerStarted(): Promise<void>;
};

export function createProjectDemoGenerationWorkerLogger(
  options: ProjectDemoGenerationWorkerLoggerOptions = {},
): ProjectDemoGenerationWorkerLogger {
  const logger = createPipelineEventLogger({
    base: { component: "project-demo-generation-worker" },
    sinks: options.sinks ?? [createWorkerStdoutLogSink()],
    ...(options.timestamp === undefined
      ? {}
      : { timestamp: options.timestamp }),
  });

  return {
    child(bindings) {
      return logger.child(bindings);
    },
    flush() {
      return logger.flush();
    },
    jobProcessed(event) {
      const level = event.status === "failed" ? "error" : "info";

      return logger[level](
        {
          event: "job-processed",
          projectId: event.projectId,
          status: event.status,
        },
        `Project ${event.projectId} demo generation ${event.status}.`,
      );
    },
    pipelineProgress(event) {
      return logger[workerProgressSeverity(event.status)](
        {
          event: "stage-progress",
          stage: event.stage,
          status: event.status,
        },
        `${event.stage} ${event.status}.`,
      );
    },
    workerStarted() {
      return logger.info(
        { event: "worker-started" },
        "MakeADemo demo generation worker started.",
      );
    },
  };
}

function workerProgressSeverity(
  status: WorkerPipelineProgress["status"],
): "error" | "info" | "warn" {
  if (status === "failed") {
    return "error";
  }
  if (status === "retrying") {
    return "warn";
  }
  return "info";
}

function createWorkerStdoutLogSink(): PipelineLogSink {
  return {
    write(line) {
      process.stdout.write(line);
    },
  };
}
