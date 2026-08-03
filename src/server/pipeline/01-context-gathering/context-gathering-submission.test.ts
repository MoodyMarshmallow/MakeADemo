import { describe, expect, it } from "vitest";

import {
  type ContextGatheringStore,
  submitContextGathering,
} from "./context-gathering-submission";

describe("submitContextGathering", () => {
  it("stores the maker, Demo Request, and queued Project from a public repo intake", async () => {
    const calls: string[] = [];
    const commitSha = "a".repeat(40);
    const store: ContextGatheringStore = {
      async createQueuedProject(input) {
        calls.push("createQueuedProject");
        expect(input.user.email).toBe("founder@example.com");
        expect(input.user.name).toBe("Anqi");
        expect(input.project.repoUrl).toBe("https://github.com/example/app");
        expect(input.project.commitSha).toBe(commitSha);
        expect(input.project.repoVisibility).toBe("public");
        expect(input.project.githubInstallationId).toBeUndefined();
        expect(input.project.supportingFiles).toEqual([
          JSON.stringify({
            fileName: "product.md",
            mimeType: "text/markdown",
            r2Key: "uploads/draft-1/product.md",
            r2Url: "r2://owlet/uploads/draft-1/product.md",
            sizeBytes: 128,
          }),
        ]);
        expect(input.project.context).toEqual({
          importantFeatures: "repo validation, script generation",
          productSummary: "A product that creates demo videos.",
          requestedDurationSeconds: 90,
          targetUsers: "Early founders",
        });
        return {
          demoRequestId: "demo-request-1",
          projectId: "project-1",
          status: "queued",
        };
      },
    };

    const result = await submitContextGathering(
      {
        contact: { email: "founder@example.com", name: "Anqi" },
        repoUrl: "https://github.com/example/app",
        repoVisibility: "public",
        structuredContext: {
          importantFeatures: "repo validation, script generation",
          productSummary: "A product that creates demo videos.",
          requestedDurationSeconds: 90,
          targetUsers: "Early founders",
        },
        supportingFiles: [
          {
            fileName: "product.md",
            mimeType: "text/markdown",
            r2Key: "uploads/draft-1/product.md",
            r2Url: "r2://owlet/uploads/draft-1/product.md",
            sizeBytes: 128,
          },
        ],
      },
      {
        revisionResolver: {
          async resolve(input) {
            calls.push("resolveRevision");
            expect(input).toEqual({
              repoUrl: "https://github.com/example/app",
            });
            return commitSha;
          },
        },
        store,
      },
    );

    expect(calls).toEqual(["resolveRevision", "createQueuedProject"]);
    expect(result).toEqual({
      demoRequestId: "demo-request-1",
      projectId: "project-1",
      status: "queued",
    });
  });

  it("requires a GitHub installation id for private repos", async () => {
    const store: ContextGatheringStore = {
      async createQueuedProject() {
        throw new Error("store should not be called");
      },
    };

    await expect(
      submitContextGathering(
        {
          contact: { email: "founder@example.com", name: "Anqi" },
          repoUrl: "https://github.com/example/private-app",
          repoVisibility: "private",
          structuredContext: {
            importantFeatures: "private workflows",
            productSummary: "A private product.",
            requestedDurationSeconds: 60,
            targetUsers: "Internal teams",
          },
          supportingFiles: [],
        },
        {
          revisionResolver: {
            async resolve() {
              throw new Error("revision resolver should not be called");
            },
          },
          store,
        },
      ),
    ).rejects.toThrow("githubInstallationId is required for private repos");
  });

  it("rejects malformed Supporting Document metadata before queueing", async () => {
    const store: ContextGatheringStore = {
      async createQueuedProject() {
        throw new Error("store should not be called");
      },
    };

    await expect(
      submitContextGathering(
        {
          contact: { email: "founder@example.com", name: "Anqi" },
          repoUrl: "https://github.com/example/app",
          repoVisibility: "public",
          structuredContext: {
            importantFeatures: "script generation",
            productSummary: "A demo generator.",
            requestedDurationSeconds: 60,
            targetUsers: "Founders",
          },
          supportingFiles: [
            {
              fileName: "demo.mp4",
              mimeType: "video/mp4",
              r2Key: "uploads/draft-1/demo.mp4",
              r2Url: "r2://owlet/uploads/draft-1/demo.mp4",
              sizeBytes: 128,
            },
          ],
        },
        {
          revisionResolver: {
            async resolve() {
              throw new Error("revision resolver should not be called");
            },
          },
          store,
        },
      ),
    ).rejects.toThrow("Supporting Documents cannot be videos or pictures");
  });
});
