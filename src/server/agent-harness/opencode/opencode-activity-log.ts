import type { AgentSessionWorkspace } from "../agent-session-runner.interface";

export function writeOpenCodeActivityLog(
  sink: Pick<AgentSessionWorkspace, "writeSandboxLog"> | undefined,
  entry: Record<string, unknown> & { stage: string },
): Promise<void> {
  const payload = createOpenCodeActivityLogEntry(entry);
  if (payload === undefined) {
    return Promise.resolve();
  }

  try {
    void sink?.writeSandboxLog?.(payload)?.catch(() => {
      // Streamed OpenCode activity mirroring is best-effort; sandbox log sink
      // failures must not fail the pipeline after the agent command succeeds.
    });
  } catch {
    // Preserve agent progress if the sandbox log sink throws synchronously.
  }

  return Promise.resolve();
}

function createOpenCodeActivityLogEntry(
  entry: Record<string, unknown> & { stage: string },
) {
  const raw = typeof entry.raw === "string" ? entry.raw : undefined;
  if (raw !== undefined && isTerminalControlOnly(raw)) {
    return undefined;
  }

  const parsed = raw === undefined ? undefined : parseOpenCodeEvent(raw);
  if (parsed === undefined) {
    if (entry.channel !== "stderr" || raw === undefined) {
      return undefined;
    }
    const compactEntry = omitRawActivityPayload(entry);
    return {
      ...compactEntry,
      event: "opencode.stderr",
      message: removeAnsiSequences(raw).trim().slice(0, 2_000),
      source: entry.source ?? "opencode",
    };
  }

  const compactEntry = omitRawActivityPayload(entry);
  const part = readRecordField(parsed, "part");
  const toolState = readRecordField(part, "state");
  const parsedType = readStringField(parsed, "type");
  const sessionID = readStringField(parsed, "sessionID");
  const message = readStringField(part, "text")?.slice(0, 2_000);
  const tool = readStringField(part, "tool") ?? readStringField(parsed, "tool");
  const state =
    readStringField(toolState, "status") ?? readStringField(parsed, "state");
  const title =
    readStringField(toolState, "title") ?? readStringField(parsed, "title");

  return {
    ...compactEntry,
    ...(parsedType === undefined ? {} : { eventType: parsedType }),
    ...(message === undefined ? {} : { message }),
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(tool === undefined ? {} : { tool }),
    ...(state === undefined ? {} : { toolState: state }),
    ...(title === undefined ? {} : { toolTitle: title }),
    event:
      parsedType === undefined ? "opencode.output" : `opencode.${parsedType}`,
    source: entry.source ?? "opencode",
  };
}

function readRecordField(
  value: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "object" && fieldValue !== null
    ? (fieldValue as Record<string, unknown>)
    : undefined;
}

function omitRawActivityPayload(entry: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(entry).filter(([field]) => field !== "raw"),
  );
}

function isTerminalControlOnly(raw: string): boolean {
  const visible = removeAnsiSequences(raw)
    .split("")
    .filter((character) => !isAsciiControl(character))
    .join("")
    .trim();
  return visible.length === 0 || visible === ">";
}

function removeAnsiSequences(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
      continue;
    }

    index += 1;
    if (value[index] !== "[") {
      continue;
    }

    while (index + 1 < value.length) {
      index += 1;
      const code = value.charCodeAt(index);
      if (code >= 64 && code <= 126) {
        break;
      }
    }
  }
  return result;
}

function isAsciiControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}

function parseOpenCodeEvent(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.length > 0
    ? fieldValue
    : undefined;
}
