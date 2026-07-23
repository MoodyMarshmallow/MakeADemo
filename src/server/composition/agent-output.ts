import { join } from "node:path";

import type { AgentTaskEvent } from "../agent-harness/agent-session-runner.interface";
import {
  createFilePipelineLogSink,
  createPipelineEventLogger,
} from "../shared/logging/pipeline-event-logger";

export type AgentOutputRouter = {
  close: () => Promise<void>;
  primaryAuditLogPath: string;
  repoPreparation: AgentOutputRoute;
  agentTasks: AgentOutputRoute;
  scriptGenerationAuditLogPath: string;
};

type AgentOutputRoute = {
  onEvent: (event: AgentTaskEvent) => void;
  onDiagnostic: (chunk: string) => void;
  onStandard: (chunk: string) => void;
};

/**
 * Routes provider-neutral semantic agent output to the CLI and durable audit
 * events to task logs. The harness owns provider event decoding; Composition
 * records the exact output content exposed by that contract without adding a
 * sanitization or redaction layer.
 */
export function createAgentOutputRouter(options: {
  runDirectory: string;
  writeDiagnostic: (chunk: string) => void;
  writeStandard: (text: string) => void;
}): AgentOutputRouter {
  const primaryAuditLog = createAgentOutputLog(
    join(options.runDirectory, "agent-audit-log.jsonl"),
  );
  const scriptGenerationAuditLog = createAgentOutputLog(
    join(options.runDirectory, "script-generation-agent-audit-log.jsonl"),
  );

  const route = (includeScriptGenerationLog: boolean): AgentOutputRoute => ({
    onDiagnostic(chunk) {
      options.writeDiagnostic(chunk);
    },
    onEvent(event) {
      primaryAuditLog.writeEvent(event);
      if (includeScriptGenerationLog) {
        scriptGenerationAuditLog.writeEvent(event);
      }
    },
    onStandard(chunk) {
      options.writeStandard(chunk);
    },
  });

  return {
    close: async () => {
      const results = await Promise.allSettled([
        primaryAuditLog.close(),
        scriptGenerationAuditLog.close(),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    },
    primaryAuditLogPath: primaryAuditLog.logPath,
    repoPreparation: route(false),
    agentTasks: route(true),
    scriptGenerationAuditLogPath: scriptGenerationAuditLog.logPath,
  };
}

function createAgentOutputLog(logPath: string) {
  const logger = createPipelineEventLogger({
    base: { component: "agent-output" },
    sinks: [createFilePipelineLogSink(logPath)],
  });
  let firstWriteError: unknown;
  let hasWriteError = false;
  let pendingWrites = Promise.resolve();
  const rememberWriteError = (error: unknown) => {
    if (hasWriteError) return;
    hasWriteError = true;
    firstWriteError = error;
  };
  const appendEntry = (entry: Record<string, unknown>) => {
    pendingWrites = pendingWrites
      .then(() => logger.info(entry, "Agent harness output."))
      .catch(rememberWriteError);
  };

  appendEntry({
    source: "agent-harness",
    eventType: "agent-output.initialized",
  });

  return {
    close: async () => {
      await pendingWrites;
      try {
        await logger.flush();
      } catch (error) {
        rememberWriteError(error);
      }
      if (hasWriteError) throw firstWriteError;
    },
    logPath,
    writeEvent(event: AgentTaskEvent) {
      appendEntry(createAuditEntry(event));
    },
  };
}

function createAuditEntry(event: AgentTaskEvent) {
  if (event.kind === "audit") {
    return {
      eventType: event.event,
      kind: event.kind,
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      source: "agent-harness",
    };
  }
  if (event.kind === "output") {
    return {
      channel: event.channel,
      content: event.content,
      eventType: "agent-output.chunk",
      kind: event.kind,
      length: event.length,
      outputType: event.outputType,
      source: "agent-harness",
    };
  }
  return {
    activityKind: event.activity.kind,
    ...(event.activity.tool === undefined
      ? {}
      : { activityTool: event.activity.tool }),
    eventType: "agent-task.activity",
    kind: event.kind,
    source: "agent-harness",
  };
}
