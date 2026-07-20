import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import { executeSubmittedCode } from "../../../pipeline/03-repo-preparation/submitted-code-execution";
import type {
  BrowserValidationInput,
  BrowserValidationOutput,
  BrowserValidator,
} from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/browser-validator.interface";
import {
  type NetworkAttempt,
  sanitizeNetworkAttemptUrl,
  sanitizeNetworkAttempts,
} from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";
import { boundValidationLogs } from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/validation-evidence";

type BrowserValidationPage = {
  close(): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  screenshot(): Promise<string>;
  route?(
    pattern: string,
    handler: (route: BrowserValidationRoute) => Promise<void>,
  ): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  requestedUrls?(): Promise<string[]>;
};

type BrowserValidationRoute = {
  abort(errorCode?: "blockedbyclient"): Promise<void>;
  continue(): Promise<void>;
  request(): { url(): string };
};

type BrowserValidationPageFactory = () => Promise<BrowserValidationPage>;

export type PlaywrightBrowserValidatorOptions = {
  pageFactory?: BrowserValidationPageFactory;
  validationTimeoutMs?: number;
};

export class PlaywrightBrowserValidator implements BrowserValidator {
  private readonly pageFactory: BrowserValidationPageFactory;
  private readonly validationTimeoutMs: number;

  constructor(options: PlaywrightBrowserValidatorOptions = {}) {
    this.pageFactory = options.pageFactory ?? createPlaywrightPage;
    this.validationTimeoutMs = options.validationTimeoutMs ?? 30_000;
  }

  async validate(
    input: BrowserValidationInput,
  ): Promise<BrowserValidationOutput> {
    if (input.preparationWorkspace !== undefined) {
      return await this.validateInsideSubmittedCode(input);
    }

    const page = await withTimeout(
      this.pageFactory(),
      this.validationTimeoutMs,
      "Browser page creation",
    );

    try {
      return await withTimeout(
        this.validatePage(input, page),
        this.validationTimeoutMs,
        `Browser validation for ${input.url}`,
      );
    } catch (error) {
      if (error instanceof BrowserValidationTimeoutError) {
        return {
          failureKind: "browser-validation-timeout",
          interactable: false,
          logs: [
            `Browser validation timed out after ${this.validationTimeoutMs}ms for ${input.url}`,
          ],
          screenshotArtifactId: "",
        };
      }

      throw error;
    } finally {
      await closeQuietly(page);
    }
  }

  private async validateInsideSubmittedCode(
    input: BrowserValidationInput,
  ): Promise<BrowserValidationOutput> {
    const preparationWorkspace = input.preparationWorkspace;
    if (preparationWorkspace === undefined) {
      throw new Error(
        "Submitted-code browser validation requires a workspace.",
      );
    }

    const result = await executeSubmittedCode(
      preparationWorkspace.workspace,
      createSubmittedCodeBrowserValidationCommand(input.url),
    );
    if (result.exitCode !== 0) {
      const logs = [result.stdout, result.stderr].filter(
        (output) => output.length > 0,
      );
      if (isMissingSandboxPlaywrightError(logs)) {
        return {
          failureKind: "validator-dependency-failed",
          interactable: false,
          logs: [
            "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.",
            ...logs,
          ],
          screenshotArtifactId: "",
        };
      }

      return {
        failureKind: "browser-validation-protocol-failed",
        interactable: false,
        logs: [
          `Browser validation failed inside submitted-code container for ${input.url}`,
          ...logs,
        ],
        screenshotArtifactId: "",
      };
    }

    const parsed = tryParseBrowserValidationOutput(result.stdout);
    if (parsed === undefined) {
      return {
        failureKind: "browser-validation-protocol-failed",
        interactable: false,
        logs: [
          `Browser validation returned malformed output for ${input.url}`,
          result.stdout,
        ].filter((output) => output.length > 0),
        screenshotArtifactId: "",
      };
    }

    const screenshot =
      parsed.screenshot ??
      (parsed.screenshotArtifactId.startsWith("screenshot:")
        ? {
            mimeType: "image/png" as const,
            path: "/workspace/.makeademo/validation-screenshot.png",
          }
        : undefined);
    const accessibleScreenshot = await copyScreenshotToRepairWorkspace(
      preparationWorkspace,
      screenshot,
    );
    const { screenshot: _submittedScreenshot, ...parsedWithoutScreenshot } =
      parsed;
    return {
      ...parsedWithoutScreenshot,
      ...(parsed.interactable
        ? {}
        : {
            failureKind:
              parsed.failureKind ??
              (parsed.blockedNetworkAttempts?.length
                ? "runtime-network-blocked"
                : "browser-not-interactable"),
          }),
      logs: boundValidationLogs(parsed.logs),
      ...(accessibleScreenshot.screenshot === undefined
        ? {}
        : { screenshot: accessibleScreenshot.screenshot }),
      ...(accessibleScreenshot.diagnostic === undefined
        ? {}
        : {
            logs: boundValidationLogs([
              ...parsed.logs,
              accessibleScreenshot.diagnostic,
            ]),
          }),
      ...(parsed.screenshotArtifactId.startsWith("screenshot:")
        ? { screenshotArtifactId: "" }
        : {}),
      ...(parsed.blockedNetworkAttempts === undefined
        ? {}
        : {
            blockedNetworkAttempts:
              sanitizeNetworkAttempts(parsed.blockedNetworkAttempts) ?? [],
          }),
    };
  }

  private async validatePage(
    input: BrowserValidationInput,
    page: BrowserValidationPage,
  ): Promise<BrowserValidationOutput> {
    const localHost = new URL(input.url).hostname;
    const blockedRequests: NetworkAttempt[] = [];
    await page.route?.("**/*", async (route) => {
      const blockedRequest = readForbiddenBrowserRequest(
        route.request().url(),
        localHost,
      );
      if (blockedRequest !== undefined) {
        blockedRequests.push(blockedRequest);
        await route.abort("blockedbyclient");
        return;
      }

      await route.continue();
    });

    try {
      await page.goto(input.url, {
        timeout: 15_000,
        waitUntil: "domcontentloaded",
      });
    } catch (error) {
      if (blockedRequests.length > 0) {
        return formatBlockedNetworkResult(blockedRequests);
      }

      return {
        interactable: false,
        logs: [`Failed to load ${input.url}: ${formatError(error)}`],
        screenshotArtifactId: "",
      };
    }
    if (blockedRequests.length > 0) {
      return formatBlockedNetworkResult(blockedRequests);
    }
    const bodyText = (await page.textContent("body")) ?? "";
    const screenshotArtifactId = await page.screenshot();
    const interactable =
      bodyText.trim().length > 0 && !looksLikeRuntimeError(bodyText);
    const blockedNetworkAttempts = findBlockedBrowserRequests(
      input.url,
      page.requestedUrls === undefined ? [] : await page.requestedUrls(),
    );

    return {
      ...(blockedNetworkAttempts.length === 0
        ? {}
        : { blockedNetworkAttempts }),
      ...(interactable ? {} : { failureKind: "browser-not-interactable" }),
      interactable,
      logs: [`Loaded ${input.url}`, "Captured screenshot proof."],
      screenshotArtifactId,
    };
  }
}

const repairScreenshotPath =
  "/workspace/.makeademo/demo-runtime-preflight/browser.png";
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const maximumScreenshotSizeBytes = 10 * 1024 * 1024;

async function copyScreenshotToRepairWorkspace(
  handle: NonNullable<BrowserValidationInput["preparationWorkspace"]>,
  screenshot: BrowserValidationOutput["screenshot"] | undefined,
): Promise<{
  diagnostic?: string;
  screenshot?: BrowserValidationOutput["screenshot"];
}> {
  if (screenshot === undefined) {
    return {};
  }
  if (handle.workspace.downloadSubmittedCodeFiles === undefined) {
    return {
      diagnostic:
        "Validation screenshot is unavailable to the repair workspace.",
    };
  }
  let directory: string | undefined;
  try {
    try {
      directory = await mkdtemp(join(tmpdir(), "makeademo-validation-"));
    } catch {
      return {
        diagnostic:
          "Validation screenshot download from submitted-code sandbox failed.",
      };
    }
    const localPath = join(directory, "browser.png");
    try {
      await handle.workspace.downloadSubmittedCodeFiles([
        { destinationPath: localPath, sourcePath: screenshot.path },
      ]);
    } catch {
      return {
        diagnostic:
          "Validation screenshot download from submitted-code sandbox failed.",
      };
    }

    let screenshotSizeBytes: number;
    try {
      screenshotSizeBytes = (await stat(localPath)).size;
    } catch {
      return {
        diagnostic:
          "Validation screenshot download from submitted-code sandbox failed.",
      };
    }

    if (
      screenshotSizeBytes < pngSignature.length ||
      screenshotSizeBytes > maximumScreenshotSizeBytes
    ) {
      return {
        diagnostic:
          "Validation screenshot from submitted-code sandbox is invalid.",
      };
    }

    let screenshotBytes: Buffer;
    try {
      screenshotBytes = await readFile(localPath);
    } catch {
      return {
        diagnostic:
          "Validation screenshot download from submitted-code sandbox failed.",
      };
    }

    if (
      screenshotBytes.length < pngSignature.length ||
      screenshotBytes.length > maximumScreenshotSizeBytes ||
      !screenshotBytes.subarray(0, pngSignature.length).equals(pngSignature)
    ) {
      return {
        diagnostic:
          "Validation screenshot from submitted-code sandbox is invalid.",
      };
    }

    try {
      await handle.workspace.uploadFiles([
        { destinationPath: repairScreenshotPath, sourcePath: localPath },
      ]);
    } catch {
      return {
        diagnostic:
          "Validation screenshot upload to the repair workspace failed.",
      };
    }
    return {
      screenshot: {
        ...screenshot,
        path: repairScreenshotPath,
        sizeBytes: screenshotBytes.length,
      },
    };
  } finally {
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true }).catch(() => {});
    }
  }
}

function createSubmittedCodeBrowserValidationCommand(url: string): string {
  return [
    `node - ${shellQuote(url)} <<'MAKEADEMO_BROWSER_VALIDATION'`,
    submittedCodeBrowserValidationScript,
    "MAKEADEMO_BROWSER_VALIDATION",
  ].join("\n");
}

const submittedCodeBrowserValidationScript = String.raw`
const targetUrl = process.argv[2];
const localHost = new URL(targetUrl).hostname;
const blockedRequests = [];
let browser;
const { execSync } = require("node:child_process");
const { createRequire } = require("node:module");

function requireSandboxPlaywright() {
  const globalNodeModules = readGlobalNodeModules();
  const candidates = [
    ...(globalNodeModules.length === 0 ? [] : [
      { createRequireFrom: globalNodeModules + "/playwright/package.json", id: "playwright" },
      { createRequireFrom: globalNodeModules + "/@playwright/test/package.json", id: "@playwright/test" },
    ]),
    { createRequireFrom: process.cwd() + "/package.json", id: "playwright" },
    { createRequireFrom: process.cwd() + "/package.json", id: "@playwright/test" },
  ];

  const failures = [];
  for (const candidate of candidates) {
    try {
      return createRequire(candidate.createRequireFrom)(candidate.id);
    } catch (error) {
      failures.push(candidate.id + " from " + candidate.createRequireFrom + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }

  throw new Error("MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox. " + failures.join(" | "));
}

function readGlobalNodeModules() {
  try {
    return execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function redactNetworkAttemptUrl(requestedUrl) {
  const url = new URL(requestedUrl);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    url.searchParams.set(key, "[redacted]");
  }
  return url.toString();
}

// Cross-process result protocol: the parent validator parses exactly one JSON
// object from stdout. Keep this generated script on console.log(JSON.stringify)
// rather than Pino unless tryParseBrowserValidationOutput changes with it.

async function main() {
  const { chromium } = requireSandboxPlaywright();
  try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on?.("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on?.("pageerror", (error) => pageErrors.push(error instanceof Error ? error.message : String(error)));
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const host = new URL(requestUrl).hostname;
    if (host !== localHost && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      blockedRequests.push({ direction: "outbound", host, phase: "runtime", url: redactNetworkAttemptUrl(requestUrl) });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.goto(targetUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
  if (blockedRequests.length > 0) {
    console.log(JSON.stringify({
      blockedNetworkAttempts: blockedRequests,
      interactable: false,
      logs: blockedRequests.map((request) => "Blocked forbidden browser request to " + request.host),
      screenshotArtifactId: "",
    }));
    process.exit(0);
  }
  const bodyText = (await page.textContent("body")) ?? "";
  let screenshotPath = "/workspace/.makeademo/validation-screenshot.png";
  try {
    require("node:fs").mkdirSync("/workspace/.makeademo", { recursive: true });
  } catch {
    screenshotPath = ".makeademo/validation-screenshot.png";
    require("node:fs").mkdirSync(".makeademo", { recursive: true });
  }
  const screenshot = await page.screenshot({ path: screenshotPath, type: "png" });
  const interactable = bodyText.trim().length > 0 && !/error|exception|stack trace|not found/i.test(bodyText);
  console.log(JSON.stringify({
    interactable,
    logs: ["Loaded " + targetUrl, "Captured screenshot proof.", ...consoleErrors, ...pageErrors, bodyText.slice(0, 2048)],
    screenshot: { mimeType: "image/png", path: screenshotPath, sizeBytes: screenshot.length },
    screenshotArtifactId: "",
  }));
} catch (error) {
  if (blockedRequests.length > 0) {
    console.log(JSON.stringify({
      blockedNetworkAttempts: blockedRequests,
      interactable: false,
      logs: blockedRequests.map((request) => "Blocked forbidden browser request to " + request.host),
      screenshotArtifactId: "",
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    failureKind: "browser-load-failed",
    interactable: false,
    logs: ["Failed to load " + targetUrl + ": " + (error instanceof Error ? error.message : String(error))],
    screenshotArtifactId: "",
  }));
} finally {
  await browser?.close();
}

}

void main();
`;

function tryParseBrowserValidationOutput(
  output: string,
): BrowserValidationOutput | undefined {
  try {
    const payload = JSON.parse(output.trim()) as BrowserValidationOutput;
    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof payload.interactable === "boolean" &&
      Array.isArray(payload.logs) &&
      typeof payload.screenshotArtifactId === "string" &&
      (payload.screenshot === undefined ||
        (typeof payload.screenshot === "object" &&
          payload.screenshot !== null &&
          typeof payload.screenshot.path === "string" &&
          payload.screenshot.mimeType === "image/png"))
    ) {
      return payload;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isMissingSandboxPlaywrightError(logs: string[]): boolean {
  const output = logs.join("\n");
  return (
    output.includes("MakeADemo validator dependency failure: Playwright") ||
    /Cannot find module ['\"](?:playwright|@playwright\/test)['\"]/.test(output)
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class BrowserValidationTimeoutError extends Error {}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new BrowserValidationTimeoutError(
              `${operation} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function closeQuietly(page: BrowserValidationPage) {
  try {
    await withTimeout(page.close(), 5_000, "Browser page close");
  } catch {
    // Preserve the browser validation result that triggered cleanup.
  }
}

async function createPlaywrightPage(): Promise<BrowserValidationPage> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const requestedUrls: string[] = [];
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });

  return {
    async close() {
      await browser.close();
    },
    async goto(url, options) {
      return page.goto(url, options);
    },
    async screenshot() {
      const screenshot = await page.screenshot({ type: "png" });
      return `screenshot:${screenshot.toString("base64")}`;
    },
    async requestedUrls() {
      return requestedUrls;
    },
    async route(pattern, handler) {
      await page.route(pattern, async (route) => {
        await handler({
          abort: (errorCode) => route.abort(errorCode),
          continue: () => route.continue(),
          request: () => ({ url: () => route.request().url() }),
        });
      });
    },
    async textContent(selector) {
      return page.textContent(selector);
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findBlockedBrowserRequests(
  localUrl: string,
  requestedUrls: string[],
): NetworkAttempt[] {
  const localHost = new URL(localUrl).hostname;

  return requestedUrls.flatMap((requestedUrl) => {
    const request = readForbiddenBrowserRequest(requestedUrl, localHost);
    return request === undefined ? [] : [request];
  });
}

function readForbiddenBrowserRequest(
  requestedUrl: string,
  localHost: string,
): NetworkAttempt | undefined {
  try {
    const url = new URL(requestedUrl);
    if (isAllowedRuntimeHost(url.hostname, localHost)) {
      return undefined;
    }

    return {
      direction: "outbound",
      host: url.hostname,
      phase: "runtime",
      url: redactNetworkAttemptUrl(requestedUrl),
    };
  } catch {
    return undefined;
  }
}

function redactNetworkAttemptUrl(requestedUrl: string): string {
  return sanitizeNetworkAttemptUrl(requestedUrl);
}

function formatBlockedNetworkResult(
  attempts: NetworkAttempt[],
): BrowserValidationOutput {
  const blockedNetworkAttempts = dedupeNetworkAttempts(
    sanitizeNetworkAttempts(attempts) ?? [],
  );
  return {
    blockedNetworkAttempts,
    failureKind: "runtime-network-blocked",
    interactable: false,
    logs: blockedNetworkAttempts.map(
      (request) => `Blocked forbidden browser request to ${request.host}`,
    ),
    screenshotArtifactId: "",
  };
}

function dedupeNetworkAttempts(attempts: NetworkAttempt[]): NetworkAttempt[] {
  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    const key = `${attempt.direction}:${attempt.phase}:${attempt.host}:${attempt.url ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isAllowedRuntimeHost(host: string, localHost: string): boolean {
  return (
    host.length === 0 ||
    [localHost, "127.0.0.1", "localhost", "0.0.0.0"].includes(host)
  );
}

function looksLikeRuntimeError(text: string): boolean {
  return /Unhandled Runtime Error|Application error|Internal Server Error|Vite Error/i.test(
    text,
  );
}
