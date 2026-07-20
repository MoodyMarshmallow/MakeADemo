/**
 * Runtime schema and reduction helpers for the generated Capture SDK's
 * cross-process event protocol. These events are emitted as marker lines by
 * the generated browser script and are the only source of capture timing and
 * action diagnostics trusted by the parent stages.
 */

export type CaptureSdkSceneEvent = {
  elapsedMs: number;
  event: "failed" | "started" | "succeeded";
  message?: string;
  sceneId: string;
};

export type CaptureSdkBrowserActionEvent = {
  elapsedMs?: number;
  event: "failed" | "started" | "succeeded";
  label: string;
  message?: string;
  sceneId?: string;
  timeoutMs?: number;
};

export type CaptureSdkBlockedNetworkEvent = {
  direction: "outbound";
  host: string;
  phase: "runtime";
  url?: string;
};

type CaptureSdkSceneEventSequenceFailure = {
  code:
    | "duplicate"
    | "failed"
    | "missing"
    | "nested"
    | "not-started"
    | "undeclared"
    | "unclosed";
  event?: CaptureSdkSceneEvent;
  message?: string;
  sceneId?: string;
  status: "failed";
};

export type CaptureSdkSceneEventSequence =
  | {
      ranges: Map<string, { endedAtMs: number; startedAtMs: number }>;
      status: "succeeded";
    }
  | CaptureSdkSceneEventSequenceFailure;

type ParsedEvent<T> =
  | { event: T; status: "valid" }
  | { line: string; status: "malformed" };

const scenePrefix = "[makeademo:scene] ";
const actionPrefix = "[makeademo:action] ";
const blockedNetworkPrefix = "[makeademo:network-blocked] ";

/** Parses valid Scene marker lines and rejects malformed matching lines. */
export function parseCaptureSdkSceneEvents(
  input: string | readonly string[],
): CaptureSdkSceneEvent[] {
  return readLines(input, scenePrefix).map((line) => {
    const value = parseJsonMarker(line, scenePrefix, "scene");
    return parseSceneEvent(value, line);
  });
}

/** Parses valid Browser Action marker lines and rejects malformed matching lines. */
/** Parses valid Runtime Network Lockdown marker lines. */
export function parseCaptureSdkBlockedNetworkEvents(
  input: string | readonly string[],
): CaptureSdkBlockedNetworkEvent[] {
  return readLines(input, blockedNetworkPrefix).map((line) =>
    parseBlockedNetworkEvent(
      parseJsonMarker(line, blockedNetworkPrefix, "network-blocked"),
      line,
    ),
  );
}

/**
 * Reads matching marker lines while retaining malformed lines for stages that
 * need to report their own protocol-specific failure wording.
 */
export function readCaptureSdkSceneEvents(
  input: string | readonly string[],
): Array<ParsedEvent<CaptureSdkSceneEvent>> {
  return readParsedEvents(input, scenePrefix, (value, line) =>
    parseSceneEvent(value, line),
  );
}

export function readCaptureSdkBrowserActionEvents(
  input: string | readonly string[],
): Array<ParsedEvent<CaptureSdkBrowserActionEvent>> {
  return readParsedEvents(input, actionPrefix, (value, line) =>
    parseBrowserActionEvent(value, line),
  );
}

/**
 * Reduces the ordered Scene event sequence to marker ranges. A failure is
 * returned as data so Capture Path Validation and Footage Capture can keep
 * their stage-specific errors while sharing all protocol invariants.
 */
export function reduceCaptureSdkSceneEvents(
  events: readonly CaptureSdkSceneEvent[],
  declaredSceneIds: readonly string[],
): CaptureSdkSceneEventSequence {
  const declared = new Set(declaredSceneIds);
  const ranges = new Map<string, { endedAtMs: number; startedAtMs: number }>();
  const open = new Map<string, CaptureSdkSceneEvent>();

  for (const event of events) {
    if (!declared.has(event.sceneId)) {
      return {
        code: "undeclared",
        event,
        sceneId: event.sceneId,
        status: "failed",
      };
    }

    if (event.event === "started") {
      if (open.size > 0) {
        return {
          code: "nested",
          event,
          sceneId: event.sceneId,
          status: "failed",
        };
      }
      if (ranges.has(event.sceneId) || open.has(event.sceneId)) {
        return {
          code: "duplicate",
          event,
          sceneId: event.sceneId,
          status: "failed",
        };
      }
      open.set(event.sceneId, event);
      continue;
    }

    const started = open.get(event.sceneId);
    if (started === undefined) {
      return {
        code: "not-started",
        event,
        sceneId: event.sceneId,
        status: "failed",
      };
    }
    open.delete(event.sceneId);

    if (event.event === "failed") {
      return {
        code: "failed",
        event,
        ...(event.message === undefined ? {} : { message: event.message }),
        sceneId: event.sceneId,
        status: "failed",
      };
    }

    ranges.set(event.sceneId, {
      endedAtMs: event.elapsedMs,
      startedAtMs: started.elapsedMs,
    });
  }

  if (open.size > 0) {
    const sceneId = open.keys().next().value as string | undefined;
    return {
      code: "unclosed",
      ...(sceneId === undefined ? {} : { sceneId }),
      status: "failed",
    };
  }

  for (const sceneId of declaredSceneIds) {
    if (!ranges.has(sceneId)) {
      return { code: "missing", sceneId, status: "failed" };
    }
  }

  return { ranges, status: "succeeded" };
}

function readLines(
  input: string | readonly string[],
  prefix: string,
): string[] {
  const lines = typeof input === "string" ? [input] : [...input];
  return lines
    .flatMap((line) => line.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
}

function readParsedEvents<T>(
  input: string | readonly string[],
  prefix: string,
  parse: (value: unknown, line: string) => T,
): Array<ParsedEvent<T>> {
  return readLines(input, prefix).map((line) => {
    try {
      return {
        event: parse(JSON.parse(line.slice(prefix.length)), line),
        status: "valid",
      };
    } catch {
      return { line, status: "malformed" };
    }
  });
}

function parseJsonMarker(line: string, prefix: string, label: string): unknown {
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    throw new Error(
      `Malformed MakeADemo ${label} marker emitted by capture script: ${line}`,
    );
  }
}

function parseSceneEvent(value: unknown, line: string): CaptureSdkSceneEvent {
  if (
    !isRecord(value) ||
    typeof value.sceneId !== "string" ||
    value.sceneId.length === 0
  ) {
    throw new Error(
      `Malformed MakeADemo scene marker emitted by capture script: ${line}`,
    );
  }
  if (!isEvent(value.event) || !isFiniteNumber(value.elapsedMs)) {
    throw new Error(
      `Malformed MakeADemo scene marker emitted by capture script: ${line}`,
    );
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    throw new Error(
      `Malformed MakeADemo scene marker emitted by capture script: ${line}`,
    );
  }
  return {
    elapsedMs: value.elapsedMs,
    event: value.event,
    ...(value.message === undefined ? {} : { message: value.message }),
    sceneId: value.sceneId,
  };
}

function parseBrowserActionEvent(
  value: unknown,
  line: string,
): CaptureSdkBrowserActionEvent {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    !isEvent(value.event)
  ) {
    throw new Error(
      `Malformed MakeADemo action marker emitted by capture script: ${line}`,
    );
  }
  const elapsedMs = value.elapsedMs;
  const timeoutMs = value.timeoutMs;
  if (
    (elapsedMs !== undefined && !isFiniteNumber(elapsedMs)) ||
    (timeoutMs !== undefined && !isFiniteNumber(timeoutMs))
  ) {
    throw new Error(
      `Malformed MakeADemo action marker emitted by capture script: ${line}`,
    );
  }
  if (
    (value.sceneId !== undefined && typeof value.sceneId !== "string") ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    throw new Error(
      `Malformed MakeADemo action marker emitted by capture script: ${line}`,
    );
  }
  return {
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    event: value.event,
    label: value.label,
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.sceneId === undefined ? {} : { sceneId: value.sceneId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseBlockedNetworkEvent(
  value: unknown,
  line: string,
): CaptureSdkBlockedNetworkEvent {
  if (
    !isRecord(value) ||
    value.direction !== "outbound" ||
    value.phase !== "runtime" ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    (value.url !== undefined && typeof value.url !== "string")
  ) {
    throw new Error(`Malformed MakeADemo network-blocked marker: ${line}`);
  }
  return {
    direction: "outbound",
    host: value.host,
    phase: "runtime",
    ...(value.url === undefined ? {} : { url: value.url }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvent(value: unknown): value is CaptureSdkSceneEvent["event"] {
  return value === "started" || value === "succeeded" || value === "failed";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
