import { describe, expect, it, vi } from "vitest";

import {
  type ExaMcpClient,
  type ExaMcpTransport,
  createAnonymousExaGlobalAgentTools,
  exaMcpEndpoint,
} from "./global-agent-tools";

function createTransport(): ExaMcpTransport {
  return {
    close: vi.fn(async () => undefined),
  };
}

function createClient(response: unknown): ExaMcpClient {
  return {
    callTool: vi.fn(async () => response) as ExaMcpClient["callTool"],
    close: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
  };
}

describe("anonymous Exa global agent tools", () => {
  it("exposes only bounded web search and fetch tools through one anonymous MCP session", async () => {
    const client = createClient({
      content: [{ text: "search result", type: "text" }],
    });
    const transport = createTransport();
    const transportUrl = vi.fn((url: URL) => {
      expect(url.toString()).toBe(exaMcpEndpoint);
      return transport;
    });
    const tools = createAnonymousExaGlobalAgentTools({
      createClient: () => client,
      createTransport: transportUrl,
    });

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "web_fetch",
    ]);

    const search = tools.tools[0];
    if (search === undefined) throw new Error("Expected web_search tool.");
    await search.execute(
      "search-call",
      {
        numResults: 3,
        query: "Pi SDK custom tools",
      },
      undefined,
      undefined,
      {} as never,
    );
    await search.execute(
      "search-call-2",
      {
        query: "MCP streamable HTTP",
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(transportUrl).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.callTool).toHaveBeenNthCalledWith(
      1,
      {
        arguments: { numResults: 3, query: "Pi SDK custom tools" },
        name: "web_search_exa",
      },
      undefined,
      expect.objectContaining({ maxTotalTimeout: 30_000 }),
    );

    await tools.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("maps web_fetch only to HTTPS public URLs and passes abort signals through", async () => {
    const client = createClient({
      content: [{ text: "fetched page", type: "text" }],
    });
    const tools = createAnonymousExaGlobalAgentTools({
      createClient: () => client,
      createTransport,
    });
    const fetchTool = tools.tools[1];
    if (fetchTool === undefined) throw new Error("Expected web_fetch tool.");
    const controller = new AbortController();

    await fetchTool.execute(
      "fetch-call",
      {
        maxCharacters: 4_000,
        url: "https://example.com/docs",
      },
      controller.signal,
      undefined,
      {} as never,
    );

    expect(client.callTool).toHaveBeenCalledWith(
      {
        arguments: {
          maxCharacters: 4_000,
          urls: ["https://example.com/docs"],
        },
        name: "web_fetch_exa",
      },
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    );

    await expect(
      fetchTool.execute(
        "bad-url",
        {
          url: "file:///etc/passwd",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("HTTPS");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("bounds tool results and aborts before opening an MCP session", async () => {
    const client = createClient({
      content: [{ text: "x".repeat(20_000), type: "text" }],
    });
    const tools = createAnonymousExaGlobalAgentTools({
      createClient: () => client,
      createTransport,
    });
    const search = tools.tools[0];
    if (search === undefined) throw new Error("Expected web_search tool.");
    const controller = new AbortController();
    controller.abort();

    await expect(
      search.execute(
        "aborted",
        { query: "ignored" },
        controller.signal,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(client.connect).not.toHaveBeenCalled();

    const result = await search.execute(
      "bounded",
      { query: "bounded" },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content[0];
    expect(text?.type).toBe("text");
    if (text?.type === "text") {
      expect(text.text.length).toBeLessThanOrEqual(12_000);
      expect(text.text).toContain("[truncated]");
    }
  });
});
