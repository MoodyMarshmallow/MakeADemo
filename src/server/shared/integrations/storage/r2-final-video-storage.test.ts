import { describe, expect, it } from "vitest";

import { R2FinalVideoStorage } from "./r2-final-video-storage";

describe("R2FinalVideoStorage", () => {
  it("stores retries under one stable Demo Request publication key", async () => {
    const storedKeys: string[] = [];
    const storage = new R2FinalVideoStorage({
      bucket: "owlet",
      putObject: async (input) => {
        expect(input.bucket).toBe("owlet");
        expect(input.contentType).toBe("video/mp4");
        storedKeys.push(input.key);
        expect(new TextDecoder().decode(input.body)).toBe("rendered mp4");
      },
      presignGet: async () => {
        throw new Error("presignGet should not be called");
      },
      presignPut: async () => {
        throw new Error("presignPut should not be called");
      },
    });

    const result = await storage.storeFinalVideo({
      body: new TextEncoder().encode("rendered mp4"),
      contentType: "video/mp4",
      demoRequestId: "demo-request-123",
      fileName: "final-video.mp4",
      scriptId: "script-123",
    });
    await storage.storeFinalVideo({
      body: new TextEncoder().encode("rendered mp4"),
      contentType: "video/mp4",
      demoRequestId: "demo-request-123",
      fileName: "final-video.mp4",
      scriptId: "script-123",
    });

    expect(result).toEqual({
      key: "demo-videos/demo-request-123/final-video.mp4",
      r2Url: "r2://owlet/demo-videos/demo-request-123/final-video.mp4",
    });
    expect(storedKeys).toEqual([
      "demo-videos/demo-request-123/final-video.mp4",
      "demo-videos/demo-request-123/final-video.mp4",
    ]);
  });
});
