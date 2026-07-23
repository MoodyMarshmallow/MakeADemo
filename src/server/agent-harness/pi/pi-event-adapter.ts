import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type PiToolExecution = {
  args: unknown;
  isError: boolean;
  name: string;
  result?: unknown;
  status: "completed" | "started";
};

/** Provider reasoning fragment emitted while an assistant message streams. */
export type PiReasoningEvent = {
  content: string;
  contentIndex: number;
  status: "completed" | "delta";
};

/** Returns user-visible assistant text emitted by a Pi event, if any. */
export function readPiTextDelta(event: AgentSessionEvent): string | undefined {
  if (event.type !== "message_update") return undefined;
  const update = event.assistantMessageEvent;
  // Thinking is meaningful activity but is never forwarded to Pipeline output;
  // provider reasoning must not become user-visible transcript text.
  if (update.type === "text_delta") {
    return update.delta;
  }
  return undefined;
}

/** Normalizes Pi reasoning deltas and terminal summaries for session buffering. */
export function readPiReasoningEvent(
  event: AgentSessionEvent,
): PiReasoningEvent | undefined {
  if (event.type !== "message_update") return undefined;
  const update = event.assistantMessageEvent;
  if (update.type === "thinking_delta") {
    return {
      content: update.delta,
      contentIndex: update.contentIndex,
      status: "delta",
    };
  }
  if (update.type === "thinking_end") {
    return {
      content: update.content,
      contentIndex: update.contentIndex,
      status: "completed",
    };
  }
  return undefined;
}

/** Returns the provider error embedded in a settled Pi assistant message. */
export function readPiProviderError(
  event: AgentSessionEvent,
  options: { ignoreAborted?: boolean } = {},
): string | undefined {
  if (event.type !== "agent_end") return undefined;
  for (const message of event.messages) {
    if (message.role !== "assistant") continue;
    if (message.stopReason === "aborted" && options.ignoreAborted === true) {
      continue;
    }
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      continue;
    }
    return message.errorMessage ?? `Pi agent ${message.stopReason}.`;
  }
  return undefined;
}

/** Normalizes Pi tool lifecycle events to the harness protocol shape. */
export function readPiToolExecution(
  event: AgentSessionEvent,
): PiToolExecution | undefined {
  if (event.type === "tool_execution_start") {
    return {
      args: event.args,
      isError: false,
      name: event.toolName,
      status: "started",
    };
  }
  if (event.type === "tool_execution_end") {
    const result = event.result;
    return {
      args: readToolArgs(event),
      isError: event.isError,
      name: event.toolName,
      status: "completed",
      ...(result === undefined ? {} : { result }),
    };
  }
  return undefined;
}

function readToolArgs(event: AgentSessionEvent): unknown {
  if (event.type === "tool_execution_start") return event.args;
  if (event.type === "tool_execution_end") {
    return (event as unknown as { args?: unknown }).args;
  }
  return undefined;
}

/** Extracts the latest assistant text from Pi's retained message history. */
export function readPiAssistantText(messages: readonly unknown[]): string {
  const assistantMessages = messages.filter(
    (message): message is { content: unknown[]; role: "assistant" } =>
      isRecord(message) &&
      message.role === "assistant" &&
      Array.isArray(message.content),
  );
  const last = assistantMessages.at(-1);
  if (last === undefined) return "";
  return last.content
    .map((content) =>
      isRecord(content) &&
      content.type === "text" &&
      typeof content.text === "string"
        ? content.text
        : "",
    )
    .join("");
}

export function parsePiStructuredOutput(text: string): unknown {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced !== undefined) candidates.push(fenced);
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // A normal prose response is not structured output.
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
