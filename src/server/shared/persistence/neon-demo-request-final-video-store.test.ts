import { describe, expect, it } from "vitest";

import { NeonDemoRequestFinalVideoStore } from "./neon-demo-request-final-video-store";

describe("NeonDemoRequestFinalVideoStore", () => {
  it("saves the generated Demo Script on the Demo Request", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        throw new Error("select should not be called");
      },
      update() {
        return {
          set(values: unknown) {
            updates.push(values);
            return {
              where() {
                return {
                  returning: async () => [{ id: "demo-request-123" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await store.saveGeneratedScript({
      demoRequestId: "demo-request-123",
      script: {
        demoPlaywrightScript:
          "await scene('scene_article_feed', async () => { await page.goto(baseUrl); });",
        format: "16:9",
        presentation: {
          music: { enabled: false },
          textOverlays: [],
          transitions: [],
        },
        scenes: [
          {
            expectedVisibleOutcome: "The article feed is visible.",
            humanReadableDescription: "Show article feed.",
            id: "scene_article_feed",
          },
        ],
        scriptId: "script_test",
        title: "Demo",
        version: 1,
      },
    });

    expect(updates).toEqual([
      {
        script: expect.objectContaining({
          scriptId: "script_test",
          title: "Demo",
        }),
      },
    ]);
  });

  it("links the generated final video to the Demo Request without writing queue status", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  innerJoin() {
                    return {
                      where() {
                        return {
                          limit: async () => [
                            {
                              email: "maker@example.com",
                            },
                          ],
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      update() {
        return {
          set(values: unknown) {
            updates.push(values);
            return {
              where() {
                return {
                  returning: async () => [
                    {
                      finalVideoEmailSentAt: null,
                      id: "demo-request-123",
                    },
                  ],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await expect(
      store.linkFinalVideo({
        demoRequestId: "demo-request-123",
        generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
      }),
    ).resolves.toEqual({
      finalVideoEmailSentAt: null,
      makerEmail: "maker@example.com",
    });

    expect(updates).toEqual([
      {
        generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
      },
    ]);
  });

  it("marks the final video ready email as sent", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        throw new Error("select should not be called");
      },
      update() {
        return {
          set(values: unknown) {
            updates.push(values);
            return {
              where() {
                return {
                  returning: async () => [{ id: "demo-request-123" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await store.markFinalVideoEmailSent({
      demoRequestId: "demo-request-123",
      sentAt: "2026-06-08T02:00:00.000Z",
    });

    expect(updates).toEqual([
      {
        finalVideoEmailSentAt: new Date("2026-06-08T02:00:00.000Z"),
      },
    ]);
  });

  it("rejects missing Demo Requests instead of creating a link", async () => {
    const db = {
      select() {
        throw new Error("select should not be called");
      },
      update() {
        return {
          set() {
            return {
              where() {
                return {
                  returning: async () => [],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await expect(
      store.linkFinalVideo({
        demoRequestId: "missing-request",
        generatedDemoUrl: "r2://owlet/demo-videos/missing-request/video.mp4",
      }),
    ).rejects.toThrow("Failed to link final video to Demo Request");
  });

  it("reads completed Demo Request status with the generated final video URL", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      limit: async () => [
                        {
                          generatedDemoUrl:
                            "r2://owlet/demo-videos/demo-request-123/video.mp4",
                          status: "completed",
                        },
                      ],
                    };
                  },
                };
              },
            };
          },
        };
      },
      update() {
        throw new Error("update should not be called");
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await expect(
      store.readDemoRequestStatus("demo-request-123"),
    ).resolves.toEqual({
      generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
      status: "completed",
    });
  });

  it("maps queued Projects to processing status", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      limit: async () => [
                        {
                          generatedDemoUrl: null,
                          status: "queued",
                        },
                      ],
                    };
                  },
                };
              },
            };
          },
        };
      },
      update() {
        throw new Error("update should not be called");
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await expect(
      store.readDemoRequestStatus("demo-request-123"),
    ).resolves.toEqual({
      status: "processing",
    });
  });
});
