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
 * Routes provider-neutral semantic agent output to the CLI and bounded audit
 * events to task logs. The harness owns provider event decoding; Composition
 * never persists assistant text, reasoning, tool arguments, or diagnostics.
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
      await Promise.all([
        primaryAuditLog.close(),
        scriptGenerationAuditLog.close(),
      ]);
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
  const appendEntry = (entry: Record<string, unknown>) => {
    void logger.info(entry, "Agent harness output.").catch(() => undefined);
  };

  appendEntry({
    source: "agent-harness",
    eventType: "agent-output.initialized",
  });

  return {
    close: async () => {
      await logger.flush().catch(() => undefined);
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
      eventType: "agent-output.chunk",
      kind: event.kind,
      length: event.length,
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
