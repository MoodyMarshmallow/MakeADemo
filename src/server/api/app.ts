import {
  type ContextGatheringStore,
  submitContextGathering,
} from "../pipeline/01-context-gathering/context-gathering-submission";
import type { DemoRequestStatusStore } from "../pipeline/final-output/demo-request-status.interface";
import {
  type R2UploadStorage,
  createSupportingDocumentUpload,
  storeSupportingDocumentUpload,
} from "../shared/integrations/storage/r2-upload-presigner";
import type { PipelineEventLogger } from "../shared/logging/pipeline-event-logger";

type ApiGithubDependencies = {
  connectAuthorizedInstallation?(code: string): Promise<{
    installationId: string;
    repositories: Array<{
      fullName: string;
      private: boolean;
      repoUrl: string;
    }>;
  } | null>;
  createAuthorizationUrl?(input: { state: string }): string;
  createCallbackUrl?(input: {
    installationId: string;
    setupAction: string;
    state: string;
  }): string;
  createInstallUrl(input: { state: string }): string;
  listRepositories(installationId: string): Promise<
    Array<{
      fullName: string;
      private: boolean;
      repoUrl: string;
    }>
  >;
  resolveRepositoryRevision?(input: {
    githubInstallationId?: string;
    repoUrl: string;
  }): Promise<string>;
};

const MAX_SUPPORTING_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024;

export type ApiAppDependencies = {
  demoRequests: DemoRequestStatusStore;
  frontend?: FrontendAssetReader;
  github: ApiGithubDependencies;
  logger?: PipelineEventLogger;
  store: ContextGatheringStore;
  uploads: R2UploadStorage;
};

/**
 * Reads production frontend assets for browser requests.
 * Implementations must return null when no asset should be served so API 404s
 * stay explicit and observable.
 */
export type FrontendAssetReader = {
  readAsset(pathname: string): Promise<Response | null>;
};

export type ApiApp = {
  fetch(request: Request): Promise<Response>;
};

export function createApiApp(dependencies: ApiAppDependencies): ApiApp {
  return {
    async fetch(request) {
      const startedAt = Date.now();
      const url = new URL(request.url);
      try {
        const response = await handleRequest(request, dependencies);
        await logApiRequest(dependencies.logger, {
          durationMs: Date.now() - startedAt,
          event: "api.request.completed",
          message: "API request completed.",
          method: request.method,
          path: url.pathname,
          status: response.status,
        });
        return response;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unexpected API error";
        const response = json({ error: errorMessage }, { status: 400 });
        await logApiRequest(dependencies.logger, {
          durationMs: Date.now() - startedAt,
          errorMessage,
          errorType: error instanceof Error ? error.name : "UnknownError",
          event: "api.request.failed",
          message: "API request failed.",
          method: request.method,
          path: url.pathname,
          status: response.status,
        });
        return response;
      }
    },
  };
}

async function logApiRequest(
  logger: PipelineEventLogger | undefined,
  entry: {
    durationMs: number;
    errorMessage?: string;
    errorType?: string;
    event: "api.request.completed" | "api.request.failed";
    message: string;
    method: string;
    path: string;
    status: number;
  },
) {
  if (logger === undefined) {
    return;
  }

  try {
    await logger[entry.event === "api.request.failed" ? "error" : "info"](
      entry,
      entry.message,
    );
  } catch {
    // Logging must never interrupt API responses.
  }
}

async function handleRequest(
  request: Request,
  dependencies: ApiAppDependencies,
): Promise<Response> {
  const url = new URL(request.url);

  if (
    request.method === "GET" &&
    url.pathname === "/api/github/authorization-url"
  ) {
    const createAuthorizationUrl = dependencies.github.createAuthorizationUrl;
    if (!createAuthorizationUrl) {
      throw new Error("GitHub authorization is not configured");
    }

    return json({
      authorizationUrl: createAuthorizationUrl({
        state: url.searchParams.get("state") ?? crypto.randomUUID(),
      }),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/github/install-url") {
    return json({
      installUrl: dependencies.github.createInstallUrl({
        state: url.searchParams.get("state") ?? crypto.randomUUID(),
      }),
    });
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/github/oauth-callback"
  ) {
    const connectAuthorizedInstallation =
      dependencies.github.connectAuthorizedInstallation;
    if (!connectAuthorizedInstallation) {
      throw new Error("GitHub authorization callbacks are not configured");
    }

    const state = url.searchParams.get("state") ?? crypto.randomUUID();
    const connection = await connectAuthorizedInstallation(
      readRequiredSearchParam(url, "code"),
    );
    if (!connection) {
      return Response.redirect(
        dependencies.github.createInstallUrl({ state }),
        302,
      );
    }

    const createCallbackUrl = dependencies.github.createCallbackUrl;
    if (!createCallbackUrl) {
      throw new Error("GitHub callback redirects are not configured");
    }

    return Response.redirect(
      createCallbackUrl({
        installationId: connection.installationId,
        setupAction: "oauth",
        state,
      }),
      302,
    );
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/github/authorized-installation"
  ) {
    const connectAuthorizedInstallation =
      dependencies.github.connectAuthorizedInstallation;
    if (!connectAuthorizedInstallation) {
      throw new Error("GitHub authorization callbacks are not configured");
    }

    const connection = await connectAuthorizedInstallation(
      readRequiredSearchParam(url, "code"),
    );
    if (!connection) {
      return json(
        { error: "GitHub App installation not found" },
        { status: 404 },
      );
    }

    return json(connection);
  }

  const repositoriesMatch =
    /^\/api\/github\/installations\/([^/]+)\/repositories$/.exec(url.pathname);
  if (request.method === "GET" && repositoriesMatch?.[1]) {
    return json({
      repositories: await dependencies.github.listRepositories(
        repositoriesMatch[1],
      ),
    });
  }

  const demoRequestStatusMatch = /^\/api\/demo-requests\/([^/]+)$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && demoRequestStatusMatch?.[1]) {
    const demoRequestId = demoRequestStatusMatch[1];
    const status =
      await dependencies.demoRequests.readDemoRequestStatus(demoRequestId);

    if (!status) {
      return json({ error: "Demo Request not found" }, { status: 404 });
    }

    if (status.status === "completed" && status.generatedDemoUrl) {
      return json({
        status: "completed",
        videoUrl: `/api/demo-requests/${encodeURIComponent(demoRequestId)}/video`,
      });
    }

    return json({
      status: status.status === "failed" ? "failed" : "processing",
    });
  }

  const demoRequestVideoMatch = /^\/api\/demo-requests\/([^/]+)\/video$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && demoRequestVideoMatch?.[1]) {
    const status = await dependencies.demoRequests.readDemoRequestStatus(
      demoRequestVideoMatch[1],
    );

    if (status?.status !== "completed" || !status.generatedDemoUrl) {
      return json({ error: "Demo video is not ready" }, { status: 404 });
    }

    return Response.redirect(
      await createPlaybackUrl(status.generatedDemoUrl, dependencies.uploads),
      302,
    );
  }

  if (request.method === "POST" && url.pathname === "/api/uploads/presign") {
    return json(
      await createSupportingDocumentUpload(
        readUploadRequest(await request.json()),
        dependencies.uploads,
      ),
    );
  }

  if (request.method === "POST" && url.pathname === "/api/uploads") {
    return json(
      await storeSupportingDocumentUpload(
        await readMultipartUploadRequest(request),
        dependencies.uploads,
      ),
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/context-gathering/submit"
  ) {
    if (dependencies.github.resolveRepositoryRevision === undefined) {
      throw new Error("GitHub revision resolution is unavailable");
    }
    return json(
      await submitContextGathering(await request.json(), {
        revisionResolver: {
          resolve: dependencies.github.resolveRepositoryRevision,
        },
        store: dependencies.store,
      }),
    );
  }

  if (!url.pathname.startsWith("/api/") && dependencies.frontend) {
    const frontendResponse = await dependencies.frontend.readAsset(
      url.pathname,
    );
    if (frontendResponse) {
      return frontendResponse;
    }
  }

  return json({ error: "Not found" }, { status: 404 });
}

async function createPlaybackUrl(
  generatedDemoUrl: string,
  storage: R2UploadStorage,
) {
  const storedVideo = parseR2Url(generatedDemoUrl);
  if (storedVideo.bucket !== storage.bucket) {
    throw new Error(
      "generated demo video bucket does not match storage bucket",
    );
  }

  return storage.presignGet({
    bucket: storedVideo.bucket,
    key: storedVideo.key,
  });
}

function parseR2Url(value: string) {
  const url = new URL(value);
  if (url.protocol !== "r2:") {
    return {
      bucket: "",
      key: value,
    };
  }

  const bucket = url.hostname;
  const key = url.pathname.replace(/^\//, "");
  if (!bucket || !key) {
    throw new Error("generated demo URL must be a valid R2 URL");
  }

  return { bucket, key };
}

function readUploadRequest(value: unknown) {
  const record = readRecord(value, "upload request");
  const sizeBytes = readNumber(record, "sizeBytes");
  assertSupportingDocumentSize(sizeBytes);

  return {
    draftId: readString(record, "draftId"),
    fileName: readString(record, "fileName"),
    mimeType: readString(record, "mimeType"),
    sizeBytes,
  };
}

async function readMultipartUploadRequest(request: Request) {
  const body = await request.formData();
  const draftId = body.get("draftId");
  const file = body.get("file");

  if (typeof draftId !== "string" || draftId.trim().length === 0) {
    throw new Error("draftId must be a non-empty string");
  }

  if (!(file instanceof File)) {
    throw new Error("file must be provided");
  }

  assertSupportingDocumentSize(file.size);

  return {
    body: new Uint8Array(await file.arrayBuffer()),
    draftId,
    fileName: file.name,
    mimeType: file.type || "text/plain",
    sizeBytes: file.size,
  };
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function readRequiredSearchParam(url: URL, key: string) {
  const value = url.searchParams.get(key);
  if (!value || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function assertSupportingDocumentSize(sizeBytes: number): void {
  if (sizeBytes > MAX_SUPPORTING_DOCUMENT_UPLOAD_BYTES) {
    throw new Error("Supporting Document uploads must be 10 MB or smaller");
  }
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }

  return value;
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}
