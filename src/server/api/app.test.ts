import { describe, expect, it } from "vitest";

import { createPipelineEventLogger } from "../shared/logging/pipeline-event-logger";
import { createApiApp } from "./app";

describe("Context Gathering API", () => {
  it("serves the frontend fallback for browser routes while keeping API routes explicit", async () => {
    const app = createApiApp({
      frontend: {
        async readAsset(pathname) {
          if (pathname === "/dashboard") {
            return new Response('<div id="root"></div>', {
              headers: { "Content-Type": "text/html" },
            });
          }

          return null;
        },
      },
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const browserRouteResponse = await app.fetch(
      new Request("http://localhost/dashboard"),
    );
    expect(browserRouteResponse.status).toBe(200);
    expect(browserRouteResponse.headers.get("Content-Type")).toContain(
      "text/html",
    );
    await expect(browserRouteResponse.text()).resolves.toContain(
      '<div id="root"></div>',
    );

    const apiRouteResponse = await app.fetch(
      new Request("http://localhost/api/not-found"),
    );
    expect(apiRouteResponse.status).toBe(404);
    await expect(apiRouteResponse.json()).resolves.toEqual({
      error: "Not found",
    });
  });

  it("logs completed API requests through Pino JSON", async () => {
    const lines: string[] = [];
    const app = createApiApp({
      ...createDefaultDependencies(),
      logger: createPipelineEventLogger({
        base: { component: "api" },
        sinks: [{ write: (line) => void lines.push(line) }],
        timestamp: () => "2026-06-17T00:00:00.000Z",
      }),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/github/install-url?state=draft-1"),
    );

    expect(response.status).toBe(200);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        component: "api",
        durationMs: expect.any(Number),
        event: "api.request.completed",
        level: "info",
        message: "API request completed.",
        method: "GET",
        path: "/api/github/install-url",
        service: "makeademo",
        status: 200,
        time: "2026-06-17T00:00:00.000Z",
      },
    ]);
  });

  it("logs API request failures without query strings or request bodies", async () => {
    const lines: string[] = [];
    const app = createApiApp({
      ...createDefaultDependencies(),
      logger: createPipelineEventLogger({
        base: { component: "api" },
        sinks: [{ write: (line) => void lines.push(line) }],
        timestamp: () => "2026-06-17T00:00:00.000Z",
      }),
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/github/authorization-url?providerApiKey=secret",
      ),
    );

    expect(response.status).toBe(400);
    const rawLog = lines.join("");
    expect(rawLog).not.toContain("providerApiKey");
    expect(rawLog).not.toContain("secret");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      component: "api",
      errorMessage: "GitHub authorization is not configured",
      errorType: "Error",
      event: "api.request.failed",
      level: "error",
      message: "API request failed.",
      method: "GET",
      path: "/api/github/authorization-url",
      status: 400,
    });
  });

  it("presigns Supporting Document uploads", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        createId: () => "file-1",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async ({ key }) => `https://uploads.example.test/${key}`,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/uploads/presign", {
        body: JSON.stringify({
          draftId: "draft-1",
          fileName: "Product Brief.md",
          mimeType: "text/markdown",
          sizeBytes: 120,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      key: "uploads/draft-1/file-1-product-brief.md",
      method: "PUT",
      r2Url: "r2://owlet/uploads/draft-1/file-1-product-brief.md",
    });
  });

  it("rejects oversized Supporting Document presign requests", async () => {
    const app = createApiApp(createDefaultDependencies());

    const response = await app.fetch(
      new Request("http://localhost/api/uploads/presign", {
        body: JSON.stringify({
          draftId: "draft-1",
          fileName: "Huge Brief.md",
          mimeType: "text/markdown",
          sizeBytes: 10 * 1024 * 1024 + 1,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Supporting Document uploads must be 10 MB or smaller",
    });
  });

  it("stores Supporting Document uploads through the API so the browser does not PUT to R2", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        createId: () => "file-1",
        async putObject(input) {
          expect(input.bucket).toBe("owlet");
          expect(input.key).toBe("uploads/draft-1/file-1-product-brief.md");
          expect(input.contentType).toBe("text/markdown");
          expect(new TextDecoder().decode(input.body)).toBe("hello");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => {
          throw new Error("presignPut should not be called");
        },
      },
    });
    const body = new FormData();
    body.set("draftId", "draft-1");
    body.set(
      "file",
      new File(["hello"], "Product Brief.md", { type: "text/markdown" }),
    );

    const response = await app.fetch(
      new Request("http://localhost/api/uploads", {
        body,
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fileName: "Product Brief.md",
      key: "uploads/draft-1/file-1-product-brief.md",
      r2Url: "r2://owlet/uploads/draft-1/file-1-product-brief.md",
    });
  });

  it("rejects oversized multipart Supporting Document uploads before storage", async () => {
    const app = createApiApp(createDefaultDependencies());
    const body = new FormData();
    body.set("draftId", "draft-1");
    body.set(
      "file",
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "Huge Brief.md", {
        type: "text/markdown",
      }),
    );

    const response = await app.fetch(
      new Request("http://localhost/api/uploads", {
        body,
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Supporting Document uploads must be 10 MB or smaller",
    });
  });

  it("submits Context Gathering intake and creates a queued demo request", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
        resolveRepositoryRevision: async () => "d".repeat(40),
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject(input) {
          expect(input.user.email).toBe("anqi@example.com");
          expect(input.project.repoVisibility).toBe("public");
          expect(input.project.commitSha).toBe("d".repeat(40));
          expect(input.project.context).toEqual({
            importantFeatures: "script generation",
            productSummary: "A demo generator.",
            requestedDurationSeconds: 60,
            targetUsers: "Founders",
          });
          return {
            demoRequestId: "demo-request-1",
            projectId: "project-1",
            status: "queued",
          };
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/context-gathering/submit", {
        body: JSON.stringify({
          contact: { email: "anqi@example.com", name: "Anqi" },
          repoUrl: "https://github.com/example/app",
          repoVisibility: "public",
          structuredContext: {
            importantFeatures: "script generation",
            productSummary: "A demo generator.",
            requestedDurationSeconds: 60,
            targetUsers: "Founders",
          },
          supportingFiles: [],
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      demoRequestId: "demo-request-1",
      projectId: "project-1",
      status: "queued",
    });
  });

  it("returns Demo Request processing status without exposing the request id", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      demoRequests: {
        async readDemoRequestStatus(demoRequestId) {
          expect(demoRequestId).toBe("demo-request-1");
          return { status: "processing" };
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/demo-requests/demo-request-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "processing",
    });
  });

  it("returns a browser video URL and redirects playback when a Demo Request is completed", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      demoRequests: {
        async readDemoRequestStatus(demoRequestId) {
          expect(demoRequestId).toBe("demo-request-1");
          return {
            generatedDemoUrl:
              "r2://owlet/demo-videos/demo-request-1/composite-1/final-video.mp4",
            status: "completed",
          };
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async (input) => {
          expect(input.key).toBe(
            "demo-videos/demo-request-1/composite-1/final-video.mp4",
          );
          return "https://videos.example.test/final-video.mp4?signature=1";
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const statusResponse = await app.fetch(
      new Request("http://localhost/api/demo-requests/demo-request-1"),
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({
      status: "completed",
      videoUrl: "/api/demo-requests/demo-request-1/video",
    });

    const videoResponse = await app.fetch(
      new Request("http://localhost/api/demo-requests/demo-request-1/video"),
    );
    expect(videoResponse.status).toBe(302);
    expect(videoResponse.headers.get("Location")).toBe(
      "https://videos.example.test/final-video.mp4?signature=1",
    );
  });

  it("returns GitHub App authorization and install URLs plus installation repositories", async () => {
    const app = createApiApp({
      github: {
        createAuthorizationUrl: ({ state }) =>
          `https://github.com/login/oauth/authorize?client_id=client-123&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fgithub%2Foauth-callback&state=${state}`,
        createInstallUrl: ({ state }) =>
          `https://github.com/apps/owlet/installations/new?state=${state}`,
        listRepositories: async (installationId) => {
          expect(installationId).toBe("123");
          return [
            {
              fullName: "example/private-app",
              private: true,
              repoUrl: "https://github.com/example/private-app",
            },
          ];
        },
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const authorizationResponse = await app.fetch(
      new Request(
        "http://localhost/api/github/authorization-url?state=draft-1",
      ),
    );
    expect(authorizationResponse.status).toBe(200);
    await expect(authorizationResponse.json()).resolves.toEqual({
      authorizationUrl:
        "https://github.com/login/oauth/authorize?client_id=client-123&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fgithub%2Foauth-callback&state=draft-1",
    });

    const installResponse = await app.fetch(
      new Request("http://localhost/api/github/install-url?state=draft-1"),
    );
    expect(installResponse.status).toBe(200);
    await expect(installResponse.json()).resolves.toEqual({
      installUrl:
        "https://github.com/apps/owlet/installations/new?state=draft-1",
    });

    const repositoriesResponse = await app.fetch(
      new Request("http://localhost/api/github/installations/123/repositories"),
    );
    expect(repositoriesResponse.status).toBe(200);
    await expect(repositoriesResponse.json()).resolves.toEqual({
      repositories: [
        {
          fullName: "example/private-app",
          private: true,
          repoUrl: "https://github.com/example/private-app",
        },
      ],
    });
  });

  it("connects an authorized user's existing GitHub App installation", async () => {
    const app = createApiApp({
      github: {
        connectAuthorizedInstallation: async (code) => {
          expect(code).toBe("oauth-code");
          return {
            installationId: "123",
            repositories: [
              {
                fullName: "example/private-app",
                private: true,
                repoUrl: "https://github.com/example/private-app",
              },
            ],
          };
        },
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => {
          throw new Error("listRepositories should not be called");
        },
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/github/authorized-installation?code=oauth-code",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installationId: "123",
      repositories: [
        {
          fullName: "example/private-app",
          private: true,
          repoUrl: "https://github.com/example/private-app",
        },
      ],
    });
  });

  it("returns not found when an authorized user has no GitHub App installation", async () => {
    const app = createApiApp({
      github: {
        connectAuthorizedInstallation: async () => null,
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => {
          throw new Error("listRepositories should not be called");
        },
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/github/authorized-installation?code=oauth-code",
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "GitHub App installation not found",
    });
  });

  it("redirects first-time OAuth callbacks directly to GitHub installation", async () => {
    const app = createApiApp({
      github: {
        connectAuthorizedInstallation: async (code) => {
          expect(code).toBe("oauth-code");
          return null;
        },
        createInstallUrl: ({ state }) =>
          `https://github.com/apps/owlet/installations/new?state=${state}`,
        listRepositories: async () => {
          throw new Error("listRepositories should not be called");
        },
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/github/oauth-callback?code=oauth-code&state=draft-1",
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://github.com/apps/owlet/installations/new?state=draft-1",
    );
  });

  it("redirects OAuth callbacks with existing installations to the frontend callback", async () => {
    const app = createApiApp({
      github: {
        connectAuthorizedInstallation: async (code) => {
          expect(code).toBe("oauth-code");
          return {
            installationId: "123",
            repositories: [
              {
                fullName: "example/private-app",
                private: true,
                repoUrl: "https://github.com/example/private-app",
              },
            ],
          };
        },
        createCallbackUrl: ({ installationId, state }) =>
          `http://localhost:5173/github/callback?installation_id=${installationId}&setup_action=oauth&state=${state}`,
        createInstallUrl: ({ state }) =>
          `https://github.com/apps/owlet/installations/new?state=${state}`,
        listRepositories: async () => {
          throw new Error("listRepositories should not be called");
        },
      },
      demoRequests: {
        async readDemoRequestStatus() {
          throw new Error("demoRequests should not be called");
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/github/oauth-callback?code=oauth-code&state=draft-1",
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:5173/github/callback?installation_id=123&setup_action=oauth&state=draft-1",
    );
  });
});

function createDefaultDependencies() {
  return {
    github: {
      createInstallUrl: () =>
        "https://github.com/apps/owlet/installations/select_target",
      listRepositories: async () => [],
    },
    demoRequests: {
      async readDemoRequestStatus() {
        throw new Error("demoRequests should not be called");
      },
    },
    store: {
      async createQueuedProject() {
        throw new Error("store should not be called");
      },
    },
    uploads: {
      bucket: "owlet",
      createId: () => "file-1",
      putObject: async () => {
        throw new Error("putObject should not be called");
      },
      presignGet: async () => {
        throw new Error("presignGet should not be called");
      },
      presignPut: async () => "https://uploads.example.test/file",
    },
  };
}
