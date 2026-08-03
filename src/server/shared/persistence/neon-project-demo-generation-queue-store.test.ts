import { describe, expect, it } from "vitest";

import { NeonProjectDemoGenerationQueueStore } from "./neon-project-demo-generation-queue-store";

describe("NeonProjectDemoGenerationQueueStore", () => {
  it("claims the next queued Project and maps intake context into a demo generation job", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      orderBy() {
                        return {
                          limit: async () => [
                            {
                              commitSha: "a".repeat(40),
                              context: {
                                structuredContext: {
                                  importantFeatures:
                                    "script generation, video generation",
                                  productSummary: "Creates demo videos.",
                                  requestedDurationSeconds: 60,
                                  targetUsers: "Founders",
                                },
                              },
                              demoRequestId: "demo-request-1",
                              githubInstallationId: "installation-123",
                              projectId: "project-1",
                              repoUrl: "https://github.com/example/app",
                              repoVisibility: "public",
                              supportingFiles: [
                                JSON.stringify({
                                  fileName: "product.md",
                                  mimeType: "text/markdown",
                                  r2Key: "uploads/draft-1/product.md",
                                  r2Url:
                                    "r2://owlet/uploads/draft-1/product.md",
                                  sizeBytes: 128,
                                }),
                              ],
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
                  returning: async () => [{ id: "project-1" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonProjectDemoGenerationQueueStore(db, {
      async loadSupportingDocuments(input) {
        expect(input).toEqual([
          {
            fileName: "product.md",
            mimeType: "text/markdown",
            r2Key: "uploads/draft-1/product.md",
            r2Url: "r2://owlet/uploads/draft-1/product.md",
            sizeBytes: 128,
          },
        ]);

        return [
          {
            normalizedText: "Product context from R2.",
            sourceArtifactId: "r2://owlet/uploads/draft-1/product.md",
            sourceFileName: "product.md",
          },
        ];
      },
    });

    await expect(store.claimNextQueuedProject()).resolves.toEqual({
      commitSha: "a".repeat(40),
      demoBrief: {
        audience: "Founders",
        keyProductFeatures: ["script generation", "video generation"],
      },
      demoRequestId: "demo-request-1",
      githubInstallationId: "installation-123",
      normalizedSupportingDocuments: [
        {
          normalizedText: "Product context from R2.",
          sourceArtifactId: "r2://owlet/uploads/draft-1/product.md",
          sourceFileName: "product.md",
        },
      ],
      projectId: "project-1",
      repoUrl: "https://github.com/example/app",
      repoVisibility: "public",
      workspaceId: "project-1",
    });
    expect(updates).toEqual([{ status: "processing" }]);
  });

  it("fails a legacy queued Project that has no pinned source revision", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [
                    {
                      context: {
                        structuredContext: { importantFeatures: "demo" },
                      },
                      demoRequestId: "demo-request-legacy",
                      projectId: "project-legacy",
                      repoUrl: "https://github.com/example/legacy",
                      repoVisibility: "public",
                      supportingFiles: [],
                    },
                  ],
                }),
              }),
            }),
          }),
        };
      },
      update() {
        return {
          set(values: unknown) {
            updates.push(values);
            return {
              where: () => ({
                returning: async () => [{ id: "project-legacy" }],
              }),
            };
          },
        };
      },
    };

    await expect(
      new NeonProjectDemoGenerationQueueStore(db).claimNextQueuedProject(),
    ).resolves.toEqual({
      claimStatus: "failed",
      demoRequestId: "demo-request-legacy",
      error:
        "Queued Project has no valid pinned source revision; legacy Projects must be resubmitted.",
      projectId: "project-legacy",
      workspaceId: "project-legacy",
    });
    expect(updates).toEqual([
      { status: "processing" },
      {
        failureReason:
          "Queued Project has no valid pinned source revision; legacy Projects must be resubmitted.",
        status: "failed",
      },
    ]);
  });

  it("marks a claimed Project failed when Supporting Documents cannot be normalized", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      orderBy() {
                        return {
                          limit: async () => [
                            {
                              commitSha: "b".repeat(40),
                              context: {
                                structuredContext: {
                                  importantFeatures: "script generation",
                                  productSummary: "Creates demo videos.",
                                  targetUsers: "Founders",
                                },
                              },
                              demoRequestId: "demo-request-1",
                              projectId: "project-1",
                              repoUrl: "https://github.com/example/app",
                              repoVisibility: "public",
                              supportingFiles: [
                                JSON.stringify({
                                  fileName: "deck.pdf",
                                  mimeType: "application/pdf",
                                  r2Key: "uploads/draft-1/deck.pdf",
                                  r2Url: "r2://owlet/uploads/draft-1/deck.pdf",
                                  sizeBytes: 128,
                                }),
                              ],
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
                  returning: async () => [{ id: "project-1" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonProjectDemoGenerationQueueStore(db, {
      async loadSupportingDocuments() {
        throw new Error("PDF normalization unavailable");
      },
    });

    await expect(store.claimNextQueuedProject()).resolves.toMatchObject({
      claimStatus: "failed",
      error: "PDF normalization unavailable",
      projectId: "project-1",
    });
    expect(updates).toEqual([
      { status: "processing" },
      {
        failureReason: "PDF normalization unavailable",
        status: "failed",
      },
    ]);
  });

  it("marks Project queue status completed or failed without touching Demo Request status", async () => {
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
                  returning: async () => [{ id: "project-1" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonProjectDemoGenerationQueueStore(db);

    await store.markProjectCompleted({
      generatedDemoUrl: "r2://owlet/demo-videos/demo-request-1/final.mp4",
      projectId: "project-1",
    });
    await store.markProjectFailed({
      error: "renderer failed",
      projectId: "project-2",
    });

    expect(updates).toEqual([
      { failureReason: null, status: "completed" },
      { failureReason: "renderer failed", status: "failed" },
    ]);
  });
});
