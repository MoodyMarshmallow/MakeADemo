export type OpenCodeToolCall = {
  input: unknown;
  name: string;
  status?: string;
};

/** Tracks OpenCode's streaming JSON protocol for caller-selected tool names. */
export function createOpenCodeProtocolTracker(input: {
  trackedToolNames: readonly string[];
}) {
  const trackedToolNames = new Set(input.trackedToolNames);
  let carry = "";
  let latestCall: OpenCodeToolCall | undefined;
  let latestCompletedCall: OpenCodeToolCall | undefined;
  let latestError: string | undefined;
  let providerError: string | undefined;
  let sessionID: string | undefined;
  let toolCarry = "";
  let latestToolName: string | undefined;
  let observedProtocolData = false;

  const consume = (text: string) => {
    for (const event of parseEvents(text)) {
      observedProtocolData = true;
      sessionID ??= readSessionID(event);
      providerError ??= readProviderError(event);
      for (const observation of readTrackedToolObservations(
        event,
        trackedToolNames,
      )) {
        if (observation.call !== undefined) {
          latestCall = observation.call;
          latestError = undefined;
          if (observation.call.status === "completed")
            latestCompletedCall = observation.call;
        } else {
          latestCall = undefined;
          latestCompletedCall = undefined;
          latestError = observation.error;
        }
      }
    }
  };

  return {
    readCompletedCall: () => latestCompletedCall,
    readError: () => latestError,
    readHasProtocolData: () => observedProtocolData,
    readProviderError: () => providerError,
    readSessionID: () => sessionID,
    readToolCall: () => latestCall,
    readToolName: () => latestToolName,
    write(chunk: string) {
      const toolOutput = `${toolCarry}${chunk}`;
      latestToolName =
        readLatestTrackedToolName(toolOutput, trackedToolNames) ??
        latestToolName;
      toolCarry = toolOutput.slice(-65_536);
      const output = `${carry}${chunk}`;
      const lines = output.split("\n");
      carry = lines.pop() ?? "";
      consume(lines.join("\n"));
      if (carry.length > 65_536) carry = carry.slice(-65_536);
      consume(carry);
    },
  };
}

export function readOpenCodeProtocolResult(
  output: string,
  trackedToolNames: readonly string[],
): {
  error?: string;
  providerError?: string;
  sessionID?: string;
  toolCall?: OpenCodeToolCall;
  toolName?: string;
} {
  const tracker = createOpenCodeProtocolTracker({ trackedToolNames });
  tracker.write(`${output}\n`);
  const toolCall = tracker.readToolCall();
  const error = tracker.readError();
  const providerError = tracker.readProviderError();
  const sessionID = tracker.readSessionID();
  const toolName = tracker.readToolName();
  return {
    ...(error === undefined ? {} : { error }),
    ...(providerError === undefined ? {} : { providerError }),
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(toolCall === undefined ? {} : { toolCall }),
    ...(toolName === undefined ? {} : { toolName }),
  };
}

export function parseOpenCodeJsonPayload(stdout: string): unknown | undefined {
  const direct = tryParseJson(stdout);
  if (direct !== undefined) return direct;
  const text = parseEvents(stdout)
    .filter((event) => event.type === "text")
    .map((event) => readText(event.part))
    .filter((value): value is string => value !== undefined)
    .join("\n");
  return tryParseJson(text);
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseEvents(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .map(tryParseJson)
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null,
    );
}

function readTrackedToolObservations(
  value: unknown,
  trackedToolNames: ReadonlySet<string>,
): (
  | { call: OpenCodeToolCall; error?: never }
  | { call?: never; error: string }
)[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const name = readToolName(record);
  const input = readToolInput(record);
  const status = readStatus(record);
  const observations: (
    | { call: OpenCodeToolCall; error?: never }
    | {
        call?: never;
        error: string;
      }
  )[] =
    name !== undefined && trackedToolNames.has(name)
      ? input === undefined
        ? [{ error: `${name} input is missing or malformed` }]
        : [
            {
              call: {
                input,
                name,
                ...(status === undefined ? {} : { status }),
              },
            },
          ]
      : [];
  for (const child of Object.values(record)) {
    observations.push(...readTrackedToolObservations(child, trackedToolNames));
  }
  return observations;
}

function readProviderError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "error") {
    const error = record.error;
    if (typeof error === "string" && error.length > 0) return error;
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    if (typeof record.message === "string" && record.message.length > 0)
      return record.message;
  }
  for (const child of Object.values(record)) {
    const error = readProviderError(child);
    if (error !== undefined) return error;
  }
  return undefined;
}

function readLatestTrackedToolName(
  output: string,
  trackedToolNames: ReadonlySet<string>,
): string | undefined {
  let latest: string | undefined;
  let latestIndex = -1;
  for (const name of trackedToolNames) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    for (const match of output.matchAll(pattern)) {
      if ((match.index ?? -1) > latestIndex) {
        latest = name;
        latestIndex = match.index ?? -1;
      }
    }
  }
  return latest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readToolName(record: Record<string, unknown>): string | undefined {
  for (const key of ["toolName", "tool", "name"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function readToolInput(record: Record<string, unknown>): unknown | undefined {
  const direct = record.input ?? record.args ?? record.arguments;
  if (typeof direct === "string") return tryParseJson(direct);
  if (direct !== undefined) return direct;
  const state = record.state;
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>).input
    : undefined;
}

function readStatus(record: Record<string, unknown>): string | undefined {
  if (typeof record.status === "string") return record.status;
  const state = record.state;
  return typeof state === "object" &&
    state !== null &&
    typeof (state as Record<string, unknown>).status === "string"
    ? ((state as Record<string, unknown>).status as string)
    : undefined;
}

function readSessionID(record: Record<string, unknown>): string | undefined {
  if (typeof record.sessionID === "string" && record.sessionID.length > 0)
    return record.sessionID;
  const session = record.session;
  if (typeof session === "object" && session !== null) {
    const id = (session as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return record.type === "session" && typeof record.id === "string"
    ? record.id
    : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).text === "string"
    ? ((value as Record<string, unknown>).text as string)
    : undefined;
}
