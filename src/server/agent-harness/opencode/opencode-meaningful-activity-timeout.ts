import {
  type AgentMeaningfulActivity,
  AgentSessionTimeoutError,
} from "../agent-session-timeout";

type MeaningfulActivityKind =
  | "text"
  | "editor-tool"
  | "inspection-tool"
  | "stage-tool";

type MeaningfulActivity = AgentMeaningfulActivity & {
  kind: MeaningfulActivityKind;
};

export type MeaningfulActivityTracker = {
  read: () => MeaningfulActivity | undefined;
  write: (channel: "stdout" | "stderr", chunk: string) => void;
};

export type MeaningfulActivityTrackerOptions = {
  completedStageToolNames?: readonly string[];
  countCompletedInspectionTools?: boolean;
};

export type MeaningfulActivityTimeoutOptions = {
  activity: MeaningfulActivityTracker;
  hardDeadlineAt: number;
  hardTimeoutMs: number;
  inactivityTimeoutMs: number;
  inactivityLabel?: string;
  label: string;
  onTimeout?: () => Promise<void> | void;
};

/**
 * Tracks only agent work that can make progress, then bounds a provider call
 * by inactivity and one absolute hard deadline. Heartbeats never reset the
 * inactivity timer; inspection tools may be enabled for stages where active
 * repository exploration is meaningful progress.
 */
export function runWithMeaningfulActivityTimeout<T>(
  start: () => Promise<T>,
  input: MeaningfulActivityTimeoutOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const hardCapTimer = setTimeout(
      () => timeout("hard-cap"),
      Math.max(1, input.hardDeadlineAt - Date.now()),
    );
    const cleanup = () => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      if (hardCapTimer !== undefined) clearTimeout(hardCapTimer);
    };
    const timeout = (kind: "inactivity" | "hard-cap") => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new AgentSessionTimeoutError(input, kind);
      try {
        void Promise.resolve(input.onTimeout?.()).catch(() => undefined);
      } catch {
        // Cancellation is best effort; preserve the timeout as the cause.
      }
      reject(error);
    };
    const armInactivityTimer = () => {
      if (settled) return;
      const remainingHardMs = input.hardDeadlineAt - Date.now();
      if (remainingHardMs <= 0) {
        timeout("hard-cap");
        return;
      }
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => {
          if (Date.now() >= input.hardDeadlineAt) timeout("hard-cap");
          else timeout("inactivity");
        },
        Math.max(1, Math.min(input.inactivityTimeoutMs, remainingHardMs)),
      );
    };

    const originalWrite = input.activity.write;
    input.activity.write = (channel, chunk) => {
      const previous = input.activity.read();
      originalWrite(channel, chunk);
      if (input.activity.read() !== previous) armInactivityTimer();
    };
    armInactivityTimer();

    let promise: Promise<T>;
    try {
      promise = start();
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function createMeaningfulActivityTracker(
  options: MeaningfulActivityTrackerOptions = {},
): MeaningfulActivityTracker {
  const carries: Record<"stdout" | "stderr", string> = {
    stderr: "",
    stdout: "",
  };
  let latest: MeaningfulActivity | undefined;
  const inspect = (line: string) => {
    const event = parseJson(line);
    if (event === undefined) return;
    const text = readStructuredText(event);
    if (text !== undefined && text.trim().length > 0) {
      latest = { at: Date.now(), kind: "text" };
    }
    const tool = readCompletedActivityTool(event, options);
    if (tool !== undefined) {
      latest = { at: Date.now(), kind: tool.kind, tool: tool.tool };
    }
  };
  return {
    read: () => latest,
    write(channel, chunk) {
      const output = carries[channel] + chunk;
      const lines = output.split("\n");
      carries[channel] = lines.pop() ?? "";
      for (const line of lines) inspect(line);
      if (carries[channel].length > 65_536)
        carries[channel] = carries[channel].slice(-65_536);
    },
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readStructuredText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "text") {
    const part = record.part;
    if (typeof part === "object" && part !== null) {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
    return typeof record.text === "string" ? record.text : undefined;
  }
  for (const child of Object.values(record)) {
    const text = readStructuredText(child);
    if (text !== undefined) return text;
  }
  return undefined;
}

function readCompletedActivityTool(
  value: unknown,
  options: MeaningfulActivityTrackerOptions,
): { kind: MeaningfulActivityKind; tool: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const status =
    record.status === "completed" ||
    (typeof record.state === "object" &&
      record.state !== null &&
      (record.state as Record<string, unknown>).status === "completed");
  if (status) {
    const tool = findTool(value, options);
    if (
      tool !== undefined &&
      options.completedStageToolNames?.includes(tool) === true
    ) {
      return { kind: "stage-tool", tool };
    }
    if (tool !== undefined && ["apply_patch", "write", "edit"].includes(tool)) {
      return { kind: "editor-tool", tool };
    }
    if (
      options.countCompletedInspectionTools === true &&
      tool !== undefined &&
      ["read", "grep", "glob", "list"].includes(tool)
    ) {
      return { kind: "inspection-tool", tool };
    }
  }
  for (const child of Object.values(record)) {
    const nested = readCompletedActivityTool(child, options);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findTool(
  value: unknown,
  options: MeaningfulActivityTrackerOptions,
): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["toolName", "tool", "name"]) {
    const candidate = record[key];
    if (
      typeof candidate === "string" &&
      (options.completedStageToolNames?.includes(candidate) === true ||
        ["apply_patch", "write", "edit"].includes(candidate) ||
        (options.countCompletedInspectionTools === true &&
          ["read", "grep", "glob", "list"].includes(candidate)))
    )
      return candidate;
  }
  for (const child of Object.values(record)) {
    const nested = findTool(child, options);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
