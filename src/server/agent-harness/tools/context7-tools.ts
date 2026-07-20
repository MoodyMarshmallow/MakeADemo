import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { queryDocsTool } from "@upstash/context7-pi/lib/tools/query-docs";
import { resolveLibraryIdTool } from "@upstash/context7-pi/lib/tools/resolve-library-id";
import type { TSchema } from "typebox";

const defaultTimeoutMs = 30_000;
const defaultMaxOutputCharacters = 12_000;
type Context7ToolDefinition = ToolDefinition<TSchema, unknown, unknown>;

/**
 * Wraps the official Context7 Pi tools with harness resource bounds.
 *
 * The official tool definitions remain responsible for Context7 request and
 * response semantics; this decorator only supplies cancellation, a timeout,
 * and a bounded textual result for the Agent Harness seam.
 */
export function createContext7ToolDefinitions(
  input: {
    maxOutputCharacters?: number;
    officialTools?: readonly Context7ToolDefinition[];
    timeoutMs?: number;
  } = {},
): Context7ToolDefinition[] {
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  const maxOutputCharacters =
    input.maxOutputCharacters ?? defaultMaxOutputCharacters;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Context7 timeoutMs must be greater than zero.");
  }
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters <= 0) {
    throw new Error("Context7 maxOutputCharacters must be a positive integer.");
  }

  const officialTools = input.officialTools ?? [
    resolveLibraryIdTool,
    queryDocsTool,
  ];
  return officialTools.map((tool) => {
    const official = tool as Context7ToolDefinition;
    return {
      ...official,
      execute: async (toolCallId, params, signal, onUpdate, context) => {
        const controller = new AbortController();
        let abortReject: ((reason: unknown) => void) | undefined;
        const abortFromParent = () => {
          controller.abort();
          abortReject?.(abortError());
        };
        if (signal?.aborted === true) {
          throw abortError();
        }
        signal?.addEventListener("abort", abortFromParent, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const task = Promise.resolve(
          official.execute(
            toolCallId,
            params as never,
            controller.signal,
            onUpdate,
            context,
          ),
        );
        const timeout = new Promise<AgentToolResult<unknown>>(
          (_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(timeoutError());
            }, timeoutMs);
          },
        );
        const aborted = new Promise<AgentToolResult<unknown>>(
          (_resolve, reject) => {
            abortReject = reject;
          },
        );
        try {
          const result = await Promise.race([task, timeout, aborted]);
          return boundResult(result, maxOutputCharacters);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", abortFromParent);
          abortReject = undefined;
          // Prevent a late official request rejection from becoming unhandled
          // after the harness has timed out or been aborted.
          void task.catch(() => undefined);
        }
      },
    } as Context7ToolDefinition;
  });
}

function boundResult(
  result: AgentToolResult<unknown>,
  maximum: number,
): AgentToolResult<unknown> {
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === "text"
        ? { ...block, text: truncate(block.text, maximum) }
        : block,
    ),
  };
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = "\n[truncated]";
  if (maximum <= suffix.length) return suffix.slice(0, maximum);
  return `${value.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

function abortError(): DOMException {
  return new DOMException("The Context7 request was aborted.", "AbortError");
}

function timeoutError(): DOMException {
  return new DOMException("The Context7 request timed out.", "TimeoutError");
}
