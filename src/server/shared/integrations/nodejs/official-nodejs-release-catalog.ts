import { compare, gte, major, prerelease, valid } from "semver";

import {
  type SubmittedCodeNodeFamily,
  type SubmittedCodeNodeReleaseCatalog,
  SubmittedCodeNodeReleaseCatalogError,
  type SubmittedCodeNodeReleaseSnapshot,
  deepFreezeSnapshot,
  submittedCodeNodeCompatibility,
} from "../../../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";

const officialNodejsReleaseIndexUrl =
  "https://nodejs.org/dist/index.json" as const;
const defaultTimeoutMs = 10_000;
const defaultMaxResponseBytes = 1024 * 1024;
const defaultMaxReleaseCount = 4_096;
const maxFilesPerRelease = 64;
const maxReleaseFieldLength = 64;
const supportedFamilies = new Set<SubmittedCodeNodeFamily>([18, 20, 22, 24]);

type FetchImplementation = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type OfficialNodejsReleaseCatalogOptions = {
  fetchImplementation?: FetchImplementation;
  maxReleaseCount?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

class OfficialNodejsReleaseCatalogError extends SubmittedCodeNodeReleaseCatalogError {
  constructor(
    code: ConstructorParameters<typeof SubmittedCodeNodeReleaseCatalogError>[0],
    message: string,
  ) {
    super(code, message);
    this.name = "OfficialNodejsReleaseCatalogError";
  }
}

/**
 * Loads the official Node.js release index once and exposes a frozen,
 * allowlisted linux-x64 snapshot for one Pipeline Job.
 */
export class OfficialNodejsReleaseCatalog
  implements SubmittedCodeNodeReleaseCatalog
{
  readonly #fetch: FetchImplementation;
  readonly #maxReleaseCount: number;
  readonly #maxResponseBytes: number;
  readonly #timeoutMs: number;
  #snapshotPromise: Promise<SubmittedCodeNodeReleaseSnapshot> | undefined;

  constructor(options: OfficialNodejsReleaseCatalogOptions = {}) {
    this.#fetch =
      options.fetchImplementation ??
      ((input, init) => globalThis.fetch(input, init));
    this.#maxReleaseCount = options.maxReleaseCount ?? defaultMaxReleaseCount;
    this.#maxResponseBytes =
      options.maxResponseBytes ?? defaultMaxResponseBytes;
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  load(): Promise<SubmittedCodeNodeReleaseSnapshot> {
    this.#snapshotPromise ??= this.#loadSnapshot();
    return this.#snapshotPromise;
  }

  async #loadSnapshot(): Promise<SubmittedCodeNodeReleaseSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Node release catalog timed out.")),
      this.#timeoutMs,
    );
    let response: Response;
    try {
      response = await this.#fetch(officialNodejsReleaseIndexUrl, {
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new OfficialNodejsReleaseCatalogError(
          "timed_out",
          "The official Node.js release catalog request timed out.",
        );
      }
      throw new OfficialNodejsReleaseCatalogError(
        "fetch_failed",
        "The official Node.js release catalog could not be loaded.",
      );
    }

    try {
      if (!response.ok || response.redirected) {
        throw new OfficialNodejsReleaseCatalogError(
          "invalid_response",
          "The official Node.js release catalog returned an invalid response.",
        );
      }
      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        (!/^\d+$/.test(contentLength) ||
          Number(contentLength) > this.#maxResponseBytes)
      ) {
        throw new OfficialNodejsReleaseCatalogError(
          "response_too_large",
          "The official Node.js release catalog exceeded its byte limit.",
        );
      }

      const bytes = await readBoundedResponse(
        response,
        this.#maxResponseBytes,
        controller.signal,
      );
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new OfficialNodejsReleaseCatalogError(
          "invalid_response",
          "The official Node.js release catalog was not valid JSON.",
        );
      }
      if (!Array.isArray(payload)) {
        throw new OfficialNodejsReleaseCatalogError(
          "invalid_response",
          "The official Node.js release catalog must contain an array.",
        );
      }
      if (payload.length > this.#maxReleaseCount) {
        throw new OfficialNodejsReleaseCatalogError(
          "too_many_releases",
          "The official Node.js release catalog exceeded its release limit.",
        );
      }

      const releases = new Map<
        string,
        { family: SubmittedCodeNodeFamily; version: string }
      >();
      for (const entry of payload) {
        const parsed = parseReleaseEntry(entry);
        if (parsed !== undefined) releases.set(parsed.version, parsed);
      }
      if (releases.size === 0) {
        throw new OfficialNodejsReleaseCatalogError(
          "invalid_response",
          "The official Node.js release catalog contained no supported releases.",
        );
      }
      return deepFreezeSnapshot({
        releases: [...releases.values()].sort((left, right) =>
          compare(right.version, left.version),
        ),
        source: officialNodejsReleaseIndexUrl,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await readBeforeAbort(reader, signal);
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OfficialNodejsReleaseCatalogError(
        "response_too_large",
        "The official Node.js release catalog exceeded its byte limit.",
      );
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBeforeAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<
  | ReadableStreamDefaultReadDoneResult
  | ReadableStreamDefaultReadValueResult<Uint8Array>
> {
  if (signal.aborted) throw timedOutError();
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(timedOutError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? timedOutError() : error);
      },
    );
  });
}

function timedOutError(): OfficialNodejsReleaseCatalogError {
  return new OfficialNodejsReleaseCatalogError(
    "timed_out",
    "The official Node.js release catalog request timed out.",
  );
}

function parseReleaseEntry(
  value: unknown,
): { family: SubmittedCodeNodeFamily; version: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidEntry();
  }
  const { files, version: encodedVersion } = value as {
    files?: unknown;
    version?: unknown;
  };
  if (
    typeof encodedVersion !== "string" ||
    encodedVersion.length > maxReleaseFieldLength ||
    !Array.isArray(files) ||
    files.length > maxFilesPerRelease ||
    !files.every(
      (file) =>
        typeof file === "string" && file.length <= maxReleaseFieldLength,
    )
  ) {
    throw invalidEntry();
  }
  const version = encodedVersion.startsWith("v")
    ? encodedVersion.slice(1)
    : encodedVersion;
  if (valid(version) !== version || prerelease(version) !== null) {
    return undefined;
  }
  const family = major(version);
  if (!supportedFamilies.has(family as SubmittedCodeNodeFamily)) {
    return undefined;
  }
  const supportedFamily = family as SubmittedCodeNodeFamily;
  if (
    !files.includes("linux-x64") ||
    !gte(
      version,
      submittedCodeNodeCompatibility[supportedFamily].compatibilityMinimum,
    )
  ) {
    return undefined;
  }
  return { family: supportedFamily, version };
}

function invalidEntry(): OfficialNodejsReleaseCatalogError {
  return new OfficialNodejsReleaseCatalogError(
    "invalid_response",
    "The official Node.js release catalog contained a malformed entry.",
  );
}
