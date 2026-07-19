export type OpenCodeOutputStreamOptions = {
  write: (text: string) => void;
};

export function createOpenCodeOutputStream(
  options: OpenCodeOutputStreamOptions,
) {
  let buffer = "";

  return {
    write(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        writeOpenCodeLine(line, options.write);
      }
    },
  };
}

function writeOpenCodeLine(line: string, write: (text: string) => void): void {
  const trimmed = stripTerminalControls(line).trim();
  if (trimmed.length === 0) {
    return;
  }

  const event = tryParseJson(trimmed);
  if (event === undefined) {
    const fallback = readDependencyInstallFallback(trimmed);
    if (fallback !== undefined) {
      write(`${fallback}\n`);
    }

    return;
  }

  const text = readTextEvent(event);
  if (text !== undefined && text.length > 0) {
    write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }

  const error = readErrorEvent(event);
  if (error !== undefined) {
    write(`[opencode:error] ${error}\n`);
    return;
  }

  const toolUse = readToolUseEvent(event);
  if (toolUse !== undefined) {
    write(`[opencode:tool] ${toolUse}\n`);
    return;
  }

  const result = readResultEvent(event);
  if (result !== undefined) {
    write(`${result}\n`);
  }
}

function readTextEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  if (record.type !== "text") {
    return undefined;
  }

  if (typeof record.text === "string") {
    return record.text;
  }

  const part = record.part;
  if (typeof part !== "object" || part === null) {
    return undefined;
  }

  const partRecord = part as Record<string, unknown>;
  return typeof partRecord.text === "string" ? partRecord.text : undefined;
}

function readErrorEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  if (record.type !== "error") {
    return undefined;
  }

  const error = record.error;
  if (typeof error !== "object" || error === null) {
    return "Unknown OpenCode error.";
  }

  const data = (error as Record<string, unknown>).data;
  if (typeof data === "object" && data !== null) {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }

  const name = (error as Record<string, unknown>).name;
  return typeof name === "string" ? name : "Unknown OpenCode error.";
}

function readToolUseEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  if (record.type !== "tool_use") {
    return undefined;
  }

  const part = record.part;
  if (typeof part !== "object" || part === null) {
    return undefined;
  }

  const partRecord = part as Record<string, unknown>;
  const tool = typeof partRecord.tool === "string" ? partRecord.tool : "tool";
  const state = partRecord.state;
  if (typeof state !== "object" || state === null) {
    return `${tool} started`;
  }

  const stateRecord = state as Record<string, unknown>;
  const status =
    typeof stateRecord.status === "string" ? stateRecord.status : "running";
  const title = typeof stateRecord.title === "string" ? stateRecord.title : "";
  const metadata = stateRecord.metadata;
  const summary = readToolMetadataSummary(metadata);

  return [tool, status, title, summary]
    .filter((part) => part.length > 0)
    .join(" - ");
}

function readToolMetadataSummary(metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null) {
    return "";
  }

  const record = metadata as Record<string, unknown>;
  if (typeof record.matches === "number") {
    return `${record.matches} matches`;
  }

  if (typeof record.count === "number") {
    return `${record.count} results`;
  }

  return "";
}

function readResultEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  if (record.status === "needs-dependency-install") {
    const command =
      typeof record.command === "string" ? record.command : "install command";

    return `[opencode] dependency install requested: ${command}`;
  }

  if (record.status === "succeeded") {
    return "[opencode] Repo Preparation completed.";
  }

  if (record.status === "failed") {
    const blockers = Array.isArray(record.blockers)
      ? record.blockers.filter(
          (blocker): blocker is string => typeof blocker === "string",
        )
      : [];
    return blockers.length === 0
      ? "[opencode] Repo Preparation failed."
      : `[opencode] Repo Preparation failed: ${blockers.join("; ")}`;
  }

  return undefined;
}

function readDependencyInstallFallback(line: string): string | undefined {
  if (!line.includes('"status":"needs-dependency-install"')) {
    return undefined;
  }

  const command = line.match(/"command":"([^"]+)"/)?.[1] ?? "install command";
  return `[opencode] dependency install requested: ${command}`;
}

function stripTerminalControls(text: string): string {
  let stripped = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\r") {
      continue;
    }

    if (char !== String.fromCharCode(27)) {
      stripped += char;
      continue;
    }

    while (index < text.length && !isAnsiTerminator(text[index] ?? "")) {
      index += 1;
    }
  }

  return stripped;
}

function isAnsiTerminator(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 64 && code <= 126;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
