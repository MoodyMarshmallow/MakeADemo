import { createPipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";

export type PipelineStage =
  | "compositing"
  | "capture-path-validation"
  | "demo-runtime-preflight"
  | "repo-preparation"
  | "repo-security-screen"
  | "script-generation";

type PipelineStageEventName =
  | "stage.failed"
  | "stage.retrying"
  | "stage.started"
  | "stage.succeeded";

type PipelineJobEventName = "job.claimed" | "job.completed" | "job.failed";

type ExternalCallEventName =
  | "external_call.failed"
  | "external_call.started"
  | "external_call.succeeded";

export type PipelineObservationContext = Pick<
  PipelineObservabilityEvent,
  "demoRequestId" | "projectId" | "runId" | "workspaceId"
>;

export type PipelineObservabilityEvent = {
  blockedNetworkAttemptCount?: number;
  createdFileCount?: number;
  demoRequestId?: string;
  diffArtifactId?: string;
  durationMs?: number;
  errorMessage?: string;
  errorType?: string;
  event: ExternalCallEventName | PipelineJobEventName | PipelineStageEventName;
  externalCall?: string;
  mockedServiceCount?: number;
  nextAttempt?: number;
  projectId?: string;
  reason?: string;
  riskCount?: number;
  runId?: string;
  sceneCount?: number;
  stage?: PipelineStage;
  status?:
    | "claimed"
    | "completed"
    | "failed"
    | "retrying"
    | "started"
    | "succeeded";
  warningCount?: number;
  workspaceId?: string;
};

/**
 * Receives sanitized MakeADemo Pipeline observability events.
 * Implementations must not throw, must not record secrets or raw user/project
 * content, and should keep identifiers stable enough to correlate one Pipeline
 * Job across workers, stages, external seams, and durable artifacts.
 */
export interface PipelineObserver {
  record(event: PipelineObservabilityEvent): void;
}

export const noopPipelineObserver: PipelineObserver = {
  record() {},
};

export function createRecordingPipelineObserver() {
  const events: PipelineObservabilityEvent[] = [];

  return {
    events,
    record(event: PipelineObservabilityEvent) {
      events.push(event);
    },
  } satisfies PipelineObserver & { events: PipelineObservabilityEvent[] };
}

export type JsonPipelineObserverOptions = {
  now?: () => string;
  service?: string;
  write: (line: string) => Promise<void> | void;
};

export function createJsonPipelineObserver(
  options: JsonPipelineObserverOptions,
): PipelineObserver {
  const logger = createPipelineEventLogger({
    ...(options.service === undefined ? {} : { service: options.service }),
    sinks: [{ write: options.write }],
    ...(options.now === undefined ? {} : { timestamp: options.now }),
  });

  return {
    record(event) {
      try {
        void logger[severityForPipelineObservation(event.status)](
          toJsonLogEvent(event),
        ).catch(() => {
          // Observability must never interrupt Pipeline Job execution.
        });
      } catch {
        // Observability must never interrupt Pipeline Job execution.
      }
    },
  };
}

function severityForPipelineObservation(
  status: PipelineObservabilityEvent["status"],
): "error" | "info" | "warn" {
  if (status === "failed") {
    return "error";
  }
  if (status === "retrying") {
    return "warn";
  }
  return "info";
}

export function sanitizeObservabilityError(error: unknown) {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorType: error.name,
    };
  }

  return {
    errorMessage: "Unknown error",
    errorType: "UnknownError",
  };
}

function toJsonLogEvent(event: PipelineObservabilityEvent) {
  return omitUndefined({
    blockedNetworkAttemptCount: event.blockedNetworkAttemptCount,
    createdFileCount: event.createdFileCount,
    demoRequestId: event.demoRequestId,
    diffArtifactId: event.diffArtifactId,
    durationMs: event.durationMs,
    errorMessage: event.errorMessage,
    errorType: event.errorType,
    event: event.event,
    externalCall: event.externalCall,
    mockedServiceCount: event.mockedServiceCount,
    nextAttempt: event.nextAttempt,
    projectId: event.projectId,
    reason: event.reason,
    riskCount: event.riskCount,
    runId: event.runId,
    sceneCount: event.sceneCount,
    stage: event.stage,
    status: event.status,
    warningCount: event.warningCount,
    workspaceId: event.workspaceId,
  });
}

function omitUndefined(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}
