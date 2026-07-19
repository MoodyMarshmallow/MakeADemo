import {
  createFilePipelineLogSink,
  createPipelineEventLogger,
} from "../../shared/logging/pipeline-event-logger";

type OpenCodeRawOutputChannel = "stderr" | "stdout";

export type OpenCodeRawOutputLog = {
  close: () => Promise<void>;
  logPath: string;
  write: (channel: OpenCodeRawOutputChannel, chunk: string) => void;
};

type OpenCodeRawOutputLogOptions = {
  logPath: string;
};

export function createOpenCodeRawOutputLog(
  options: OpenCodeRawOutputLogOptions,
): OpenCodeRawOutputLog {
  const logger = createPipelineEventLogger({
    base: { component: "opencode-raw-output" },
    sinks: [createFilePipelineLogSink(options.logPath)],
  });
  const buffers: Record<OpenCodeRawOutputChannel, string> = {
    stderr: "",
    stdout: "",
  };

  const appendEntry = (entry: Record<string, unknown>) => {
    void logger
      .info(entry, `OpenCode ${entry.channel ?? "output"}.`)
      .catch(() => undefined);
  };
  appendEntry({
    raw: "OpenCode raw log initialized.",
    source: "makeademo",
  });

  return {
    async close() {
      for (const channel of ["stdout", "stderr"] as const) {
        if (buffers[channel].length > 0) {
          appendEntry(createLogEntry(channel, buffers[channel]));
          buffers[channel] = "";
        }
      }
      await logger.flush().catch(() => undefined);
    },
    logPath: options.logPath,
    write(channel, chunk) {
      if (chunk.length === 0) {
        return;
      }

      buffers[channel] += chunk;
      const lines = buffers[channel].split("\n");
      buffers[channel] = lines.pop() ?? "";

      for (const line of lines) {
        appendEntry(createLogEntry(channel, line));
      }
    },
  };
}

function createLogEntry(channel: OpenCodeRawOutputChannel, raw: string) {
  const parsed = parseJson(raw);
  const tool = readToolUse(parsed);

  return {
    channel,
    ...(parsed === undefined
      ? {}
      : {
          eventType: readEventType(parsed),
          parsed,
        }),
    raw,
    source: "opencode",
    ...(tool === undefined ? {} : tool),
  };
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
}

function readEventType(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const type = (parsed as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}

function readToolUse(parsed: unknown) {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "tool_use") {
    return undefined;
  }

  const part = record.part;
  if (typeof part !== "object" || part === null) {
    return undefined;
  }

  const partRecord = part as Record<string, unknown>;
  const state = partRecord.state;
  const stateRecord =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>)
      : undefined;

  return {
    tool: typeof partRecord.tool === "string" ? partRecord.tool : undefined,
    toolState:
      typeof stateRecord?.status === "string" ? stateRecord.status : undefined,
    toolTitle:
      typeof stateRecord?.title === "string" ? stateRecord.title : undefined,
  };
}
