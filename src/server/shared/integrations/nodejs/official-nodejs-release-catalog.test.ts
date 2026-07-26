import { describe, expect, it, vi } from "vitest";

import { OfficialNodejsReleaseCatalog } from "./official-nodejs-release-catalog";

describe("OfficialNodejsReleaseCatalog", () => {
  it("loads one immutable snapshot of stable supported linux-x64 releases", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse([
        { files: ["linux-x64"], version: "v24.3.2" },
        { files: ["linux-x64"], version: "v23.11.1" },
        { files: ["linux-x64"], version: "v22.23.1" },
        { files: ["linux-x64"], version: "v22.24.0-rc.1" },
        { files: ["headers"], version: "v20.19.5" },
        { files: ["linux-x64"], version: "v18.17.0" },
      ]),
    );
    const catalog = new OfficialNodejsReleaseCatalog({ fetchImplementation });

    const first = await catalog.load();
    const second = await catalog.load();

    expect(first).toEqual({
      releases: [
        { family: 24, version: "24.3.2" },
        { family: 22, version: "22.23.1" },
      ],
      source: "https://nodejs.org/dist/index.json",
    });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.releases)).toBe(true);
    expect(Object.isFrozen(first.releases[0])).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://nodejs.org/dist/index.json",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects redirected and unsuccessful responses", async () => {
    for (const response of [
      new Response(null, { status: 503 }),
      Object.defineProperty(jsonResponse([]), "redirected", { value: true }),
    ]) {
      await expect(
        new OfficialNodejsReleaseCatalog({
          fetchImplementation: async () => response,
        }).load(),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("bounds response bytes before and while reading", async () => {
    await expect(
      new OfficialNodejsReleaseCatalog({
        fetchImplementation: async () =>
          new Response("[]", { headers: { "content-length": "100" } }),
        maxResponseBytes: 10,
      }).load(),
    ).rejects.toMatchObject({ code: "response_too_large" });

    await expect(
      new OfficialNodejsReleaseCatalog({
        fetchImplementation: async () => new Response("[12345678901]"),
        maxResponseBytes: 10,
      }).load(),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("rejects release-count and entry-schema violations", async () => {
    await expect(
      new OfficialNodejsReleaseCatalog({
        fetchImplementation: async () =>
          jsonResponse([
            { files: ["linux-x64"], version: "v24.1.0" },
            { files: ["linux-x64"], version: "v24.2.0" },
          ]),
        maxReleaseCount: 1,
      }).load(),
    ).rejects.toMatchObject({ code: "too_many_releases" });

    await expect(
      new OfficialNodejsReleaseCatalog({
        fetchImplementation: async () =>
          jsonResponse([{ files: "linux-x64", version: "v24.1.0" }]),
      }).load(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("aborts a catalog request at its bounded timeout", async () => {
    const fetchImplementation = vi.fn(
      async (_input: string, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );

    await expect(
      new OfficialNodejsReleaseCatalog({
        fetchImplementation,
        timeoutMs: 5,
      }).load(),
    ).rejects.toMatchObject({ code: "timed_out" });

    await expect(
      new OfficialNodejsReleaseCatalog({
        fetchImplementation: async () =>
          new Response(new ReadableStream({ start() {} })),
        timeoutMs: 5,
      }).load(),
    ).rejects.toMatchObject({ code: "timed_out" });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
