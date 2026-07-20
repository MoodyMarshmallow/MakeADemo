import {
  type AgentToolResult,
  type ToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import {
  Client,
  type ClientOptions,
} from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Static, Type } from "typebox";

/** The anonymous Exa MCP endpoint; callers cannot override this in production. */
export const exaMcpEndpoint = "https://mcp.exa.ai/mcp";

const maxQueryLength = 2_000;
const maxUrlLength = 2_048;
const maxResultCharacters = 12_000;
const requestTimeoutMs = 30_000;

/** The MCP transport seam used by offline tests and the fixed production transport. */
export type ExaMcpTransport = {
  close: () => Promise<void>;
};

/** The small MCP client surface needed by the global tools. */
export type ExaMcpClient = Pick<Client, "callTool" | "close" | "connect">;

/** Session-owned Exa tools and their idempotent resource cleanup operation. */
export type AnonymousExaGlobalAgentTools = {
  close: () => Promise<void>;
  tools: readonly ToolDefinition[];
};

/** Test-only dependency seams; production uses the fixed official SDK classes. */
export type AnonymousExaGlobalAgentToolsOptions = {
  /** Injected only for tests; production always uses the official MCP Client. */
  createClient?: (options: ClientOptions) => ExaMcpClient;
  /** Injected only for tests; production always uses Streamable HTTP. */
  createTransport?: (url: URL) => ExaMcpTransport;
};

const WebSearchParams = Type.Object({
  numResults: Type.Optional(Type.Integer({ maximum: 10, minimum: 1 })),
  query: Type.String({ maxLength: maxQueryLength, minLength: 1 }),
});

const WebFetchParams = Type.Object({
  maxCharacters: Type.Optional(
    Type.Integer({ maximum: maxResultCharacters, minimum: 1 }),
  ),
  url: Type.String({ maxLength: maxUrlLength, minLength: 1 }),
});

type WebSearchParams = Static<typeof WebSearchParams>;
type WebFetchParams = Static<typeof WebFetchParams>;

/**
 * Creates session-scoped, anonymous Exa tools for the Agent Harness.
 *
 * The MCP connection is lazy and shared by both tools for the lifetime of the
 * returned object. It has no API-key or endpoint configuration surface, and
 * only forwards the two explicitly approved Exa tool names.
 */
export function createAnonymousExaGlobalAgentTools(
  options: AnonymousExaGlobalAgentToolsOptions = {},
): AnonymousExaGlobalAgentTools {
  let client: ExaMcpClient | undefined;
  let transport: ExaMcpTransport | undefined;
  let connection: Promise<ExaMcpClient> | undefined;
  let closed = false;

  const getClient = async (
    signal: AbortSignal | undefined,
  ): Promise<ExaMcpClient> => {
    assertNotAborted(signal);
    if (closed) throw new Error("Anonymous Exa tools have been closed.");
    if (client !== undefined) return client;
    if (connection !== undefined) return connection;

    const clientOptions: ClientOptions = {
      capabilities: {},
    };
    const nextClient =
      options.createClient?.(clientOptions) ??
      new Client(
        { name: "makeademo-agent-harness", version: "0.1.0" },
        clientOptions,
      );
    const nextTransport =
      options.createTransport?.(new URL(exaMcpEndpoint)) ??
      new StreamableHTTPClientTransport(new URL(exaMcpEndpoint), {
        // Anonymous development access must never read or inject credentials.
        reconnectionOptions: {
          initialReconnectionDelay: 100,
          maxReconnectionDelay: 500,
          maxRetries: 0,
          reconnectionDelayGrowFactor: 1,
        },
      });
    transport = nextTransport;
    const connectOptions: RequestOptions = {
      maxTotalTimeout: requestTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
    connection = nextClient
      // The production transport is the official SDK transport. The narrow
      // test seam above deliberately omits its wire methods.
      .connect(nextTransport as unknown as Transport, connectOptions)
      .then(() => {
        client = nextClient;
        return nextClient;
      })
      .finally(() => {
        connection = undefined;
      });
    return connection;
  };

  const callExa = async (
    name: "web_fetch_exa" | "web_search_exa",
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<undefined>> => {
    assertNotAborted(signal);
    const connectedClient = await getClient(signal);
    const requestOptions: RequestOptions = {
      maxTotalTimeout: requestTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
    const result = await connectedClient.callTool(
      { arguments: args, name },
      undefined,
      requestOptions,
    );
    const text = readMcpResultText(result);
    if (isRecord(result) && result.isError === true) {
      throw new Error(text || `Exa MCP tool ${name} failed.`);
    }
    return {
      content: [{ text, type: "text" }],
      details: undefined,
    };
  };

  const tools: readonly ToolDefinition[] = [
    defineTool({
      description:
        "Search the public web with Exa using only public or generalized queries. Never include private repository content, personal data, credentials, or proprietary source text; results are bounded.",
      executionMode: "sequential",
      execute: async (_toolCallId, params: WebSearchParams, signal) => {
        const args: Record<string, unknown> = {
          query: boundedString(params.query, maxQueryLength, "query"),
        };
        if (params.numResults !== undefined)
          args.numResults = params.numResults;
        return callExa("web_search_exa", args, signal);
      },
      label: "Web search",
      name: "web_search",
      parameters: WebSearchParams,
    }),
    defineTool({
      description:
        "Fetch one public HTTPS page with Exa. Never use URLs containing private or credentialed information; local, credentialed, and non-HTTPS URLs are rejected.",
      executionMode: "sequential",
      execute: async (_toolCallId, params: WebFetchParams, signal) => {
        const url = validatePublicHttpsUrl(params.url);
        return callExa(
          "web_fetch_exa",
          {
            ...(params.maxCharacters === undefined
              ? {}
              : { maxCharacters: params.maxCharacters }),
            urls: [url],
          },
          signal,
        );
      },
      label: "Web fetch",
      name: "web_fetch",
      parameters: WebFetchParams,
    }),
  ];

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await connection?.catch(() => undefined);
      const activeClient = client;
      client = undefined;
      const activeTransport = transport;
      transport = undefined;
      if (activeClient !== undefined) {
        // The official MCP Client closes its connected transport.
        await activeClient.close();
      } else if (activeTransport !== undefined) {
        await activeTransport.close();
      }
    },
    tools,
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw new DOMException("The Exa MCP request was aborted.", "AbortError");
}

function boundedString(value: string, maximum: number, label: string): string {
  if (value.length === 0 || value.length > maximum) {
    throw new Error(
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
  return value;
}

function validatePublicHttpsUrl(value: string): string {
  const url = boundedString(value, maxUrlLength, "url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("web_fetch requires a valid public HTTPS URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIpLiteral(hostname)
  ) {
    throw new Error(
      "web_fetch requires a public HTTPS URL without credentials.",
    );
  }
  return parsed.toString();
}

function isIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return /^[0-9a-f:.]+$/i.test(normalized);
}

function readMcpResultText(value: unknown): string {
  const parts: string[] = [];
  if (isRecord(value) && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (
        isRecord(item) &&
        item.type === "text" &&
        typeof item.text === "string"
      ) {
        parts.push(item.text);
      }
    }
  }
  if (
    parts.length === 0 &&
    isRecord(value) &&
    value.structuredContent !== undefined
  ) {
    parts.push(JSON.stringify(value.structuredContent));
  }
  if (parts.length === 0) parts.push(JSON.stringify(value));
  return truncate(parts.join("\n\n"));
}

function truncate(value: string): string {
  if (value.length <= maxResultCharacters) return value;
  return `${value.slice(0, maxResultCharacters - 13)}\n[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
