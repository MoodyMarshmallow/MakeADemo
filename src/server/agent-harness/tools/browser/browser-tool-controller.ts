import { randomUUID } from "node:crypto";

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { executeSubmittedCode } from "../../../pipeline/03-repo-preparation/submitted-code-execution";
import {
  type RuntimeNetworkPolicy,
  defaultRuntimeNetworkPolicy,
} from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";
import { transferBrowserScreenshot } from "../../../shared/integrations/browser/browser-screenshot-transfer";
import type {
  BrowserAction,
  BrowserInspectionKind,
  BrowserToolController,
  BrowserToolControllerInput,
} from "./browser-tool-controller.interface";
import { BrowserToolError } from "./browser-tool-controller.interface";

const browserCommandTimeoutMs = 30_000;
const browserOutputDirectory = "/tmp/makeademo-browser-tools";
const browserOutputLimit = 16 * 1024;
const browserScreenshotPath = "/workspace/.makeademo/browser-tools/latest.png";

export type { BrowserToolController } from "./browser-tool-controller.interface";

/**
 * Creates the workspace-scoped boundary around the submitted-code Playwright
 * CLI. Its opaque session, output location, and authorized origin remain
 * backend-owned; model-facing tools may supply only validated browser intent.
 */
export function createBrowserToolController(
  input: BrowserToolControllerInput,
): BrowserToolController {
  const session = `makeademo-${randomUUID()}`;
  let opened = false;
  let maybeStarted = false;
  let requiresReopen = false;
  let context = {
    deadlineAt: input.deadlineAt,
    localUrl: input.localUrl,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const runtimeNetworkPolicy =
    input.runtimeNetworkPolicy ?? defaultRuntimeNetworkPolicy;
  const runCommand = (
    commandInput: Omit<
      Parameters<typeof runBrowserCommand>[0],
      "runtimeNetworkPolicy"
    >,
  ) => runBrowserCommand({ ...commandInput, runtimeNetworkPolicy });

  return {
    async act(action) {
      await ensureOpen();
      const output = await runCommand({
        command: commandForAction(action),
        configure: false,
        deadlineAt: context.deadlineAt,
        session,
        signal: context.signal,
        localUrl: context.localUrl,
        workspace: input.workspace,
      });
      await assertAuthorizedOrigin();
      return { output: normalizeBrowserOutput(output, "action") };
    },
    async inspect({ kind }) {
      await ensureOpen();
      await assertAuthorizedOrigin();
      const command = kind === "snapshot" ? "snapshot --depth=8" : kind;
      const output = await runCommand({
        command,
        configure: false,
        deadlineAt: context.deadlineAt,
        session,
        signal: context.signal,
        localUrl: context.localUrl,
        workspace: input.workspace,
      });
      await assertAuthorizedOrigin();
      return {
        kind,
        output: normalizeBrowserOutput(output, `inspect-${kind}`),
      };
    },
    async navigate({ path }) {
      await ensureOpen();
      const url = resolveRelativeUrl(context.localUrl, path);
      const output = await runCommand({
        command: `goto ${shellQuote(url)}`,
        configure: false,
        deadlineAt: context.deadlineAt,
        session,
        signal: context.signal,
        localUrl: context.localUrl,
        workspace: input.workspace,
      });
      await assertAuthorizedOrigin();
      return { output: normalizeBrowserOutput(output, "navigation"), url };
    },
    async screenshot(options = {}) {
      if (options.target !== undefined && options.fullPage === true) {
        throw new Error(
          "Browser screenshot cannot combine target and fullPage.",
        );
      }
      await ensureOpen();
      await assertAuthorizedOrigin();
      const sourcePath = `${browserOutputDirectory}/${session}/latest.png`;
      const command = [
        "screenshot",
        ...(options.target === undefined ? [] : [shellQuote(options.target)]),
        `--filename=${shellQuote(sourcePath)}`,
        ...(options.fullPage === true ? ["--full-page"] : []),
      ].join(" ");
      await runCommand({
        command,
        configure: false,
        deadlineAt: context.deadlineAt,
        session,
        signal: context.signal,
        localUrl: context.localUrl,
        workspace: input.workspace,
      });
      await assertAuthorizedOrigin();
      const transferred = await transferBrowserScreenshot({
        destinationPath: browserScreenshotPath,
        sourcePath,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        timeoutMs: remainingTimeout(context.deadlineAt),
        workspace: input.workspace,
      });
      return { path: browserScreenshotPath, sizeBytes: transferred.sizeBytes };
    },
    async reset() {
      if (!maybeStarted) return;
      await cleanupSession();
    },
    updateContext(next) {
      if (
        opened &&
        new URL(context.localUrl).origin !== new URL(next.localUrl).origin
      ) {
        requiresReopen = true;
      }
      context = {
        deadlineAt: next.deadlineAt,
        localUrl: next.localUrl,
        ...(next.signal === undefined ? {} : { signal: next.signal }),
      };
    },
  };

  async function ensureOpen(): Promise<void> {
    if (requiresReopen) {
      await cleanupSession();
      requiresReopen = false;
    }
    if (opened) return;
    maybeStarted = true;
    try {
      await runCommand({
        command: `open ${shellQuote(new URL(context.localUrl).toString())}`,
        configure: true,
        deadlineAt: context.deadlineAt,
        session,
        signal: context.signal,
        localUrl: context.localUrl,
        workspace: input.workspace,
      });
      opened = true;
      await assertAuthorizedOrigin();
    } catch (error) {
      if (maybeStarted) await cleanupSession();
      throw error;
    }
  }

  async function assertAuthorizedOrigin(): Promise<void> {
    let observedOrigin: string | undefined;
    try {
      const output = await runCommand({
        command: `eval ${shellQuote("() => location.origin")}`,
        configure: false,
        deadlineAt: context.deadlineAt,
        session,
        signal: context.signal,
        localUrl: context.localUrl,
        workspace: input.workspace,
      });
      observedOrigin = readCliOrigin(output);
    } catch (error) {
      await cleanupSession();
      throw error;
    }
    if (observedOrigin === undefined) {
      await cleanupSession();
      throw new BrowserToolError(
        "invalid-cli-output",
        "Browser CLI returned an invalid origin result.",
      );
    }
    if (observedOrigin !== new URL(context.localUrl).origin) {
      await cleanupSession();
      throw new BrowserToolError(
        "navigation-outside-demo-origin",
        "Browser navigation left the authorized demo origin.",
      );
    }
  }

  async function cleanupSession(): Promise<void> {
    const cleanupDeadlineAt = Date.now() + 5_000;
    try {
      await runCommand({
        command: "close",
        configure: false,
        deadlineAt: cleanupDeadlineAt,
        session,
        signal: undefined,
        localUrl: context.localUrl,
        workspace: input.workspace,
      });
    } catch {
      await runCommand({
        command: "kill-all",
        configure: false,
        deadlineAt: cleanupDeadlineAt,
        session,
        signal: undefined,
        localUrl: context.localUrl,
        workspace: input.workspace,
      }).catch(() => undefined);
    } finally {
      try {
        await removeSessionDirectory({
          deadlineAt: cleanupDeadlineAt,
          session,
          workspace: input.workspace,
        });
      } finally {
        maybeStarted = false;
        opened = false;
        requiresReopen = false;
      }
    }
  }
}

function commandForAction(action: BrowserAction): string {
  switch (action.kind) {
    case "check":
    case "click":
    case "hover":
    case "uncheck":
      return `${action.kind} ${shellQuote(action.ref)}`;
    case "fill":
      return `fill ${shellQuote(action.ref)} ${shellQuote(action.text)}`;
    case "press":
      return `press ${shellQuote(action.key)}`;
    case "select":
      return `select ${shellQuote(action.ref)} ${shellQuote(action.value)}`;
    case "type":
      return `type ${shellQuote(action.text)}`;
    default:
      throw new Error("Unsupported browser action.");
  }
}

async function runBrowserCommand(input: {
  command: string;
  configure: boolean;
  deadlineAt: number | undefined;
  session: string;
  signal: AbortSignal | undefined;
  localUrl: string;
  runtimeNetworkPolicy: RuntimeNetworkPolicy;
  workspace: PreparationWorkspace;
}): Promise<unknown> {
  throwIfCancelled(input.signal, input.deadlineAt);
  const outputDirectory = `${browserOutputDirectory}/${input.session}`;
  const configPath = `${outputDirectory}/config.json`;
  const commandOutputPath = `${outputDirectory}/command-${randomUUID()}.json`;
  const commandStatusPath = `${outputDirectory}/command-${randomUUID()}.status`;
  const config = JSON.stringify({
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: { chromiumSandbox: false, headless: true },
    },
    ...(input.runtimeNetworkPolicy === "loopback-only"
      ? { network: { allowedOrigins: [new URL(input.localUrl).origin] } }
      : {}),
    outputDir: outputDirectory,
    outputMode: "stdout",
  });
  const cliCommand = [
    ...(input.configure
      ? [`PLAYWRIGHT_MCP_CONFIG=${shellQuote(configPath)}`]
      : []),
    "playwright-cli",
    `-s=${shellQuote(input.session)}`,
    "--json",
    input.command,
  ].join(" ");
  const boundedCliCommand = [
    `makeademo_cli_status_path=${shellQuote(commandStatusPath)}`,
    `((${cliCommand}; makeademo_cli_status=$?; printf '%s' "$makeademo_cli_status" > "$makeademo_cli_status_path") 2>&1 | (head -c ${browserOutputLimit + 1} > ${shellQuote(commandOutputPath)}; cat > /dev/null))`,
    'makeademo_cli_status="$(cat "$makeademo_cli_status_path")"',
    `cat ${shellQuote(commandOutputPath)}`,
    `rm -f ${shellQuote(commandOutputPath)} "$makeademo_cli_status_path"`,
    'exit "$makeademo_cli_status"',
  ].join("; ");
  const result = await executeSubmittedCode(
    input.workspace,
    [
      ...(input.configure
        ? [
            `mkdir -p ${shellQuote(outputDirectory)}`,
            `printf '%s' ${shellQuote(config)} > ${shellQuote(configPath)}`,
          ]
        : []),
      boundedCliCommand,
    ].join(" && "),
    {
      env: {
        NO_UPDATE_NOTIFIER: "1",
        PLAYWRIGHT_CLI_SESSION: input.session,
        PLAYWRIGHT_MCP_OUTPUT_DIR: outputDirectory,
        ...(input.runtimeNetworkPolicy === "loopback-only"
          ? {
              PLAYWRIGHT_MCP_ALLOWED_ORIGINS: new URL(input.localUrl).origin,
            }
          : {}),
      },
      timeoutMs: remainingTimeout(input.deadlineAt),
    },
  );
  throwIfCancelled(input.signal, input.deadlineAt);
  if (Buffer.byteLength(result.stdout, "utf8") > browserOutputLimit) {
    throw new BrowserToolError(
      "output-too-large",
      `Browser CLI output exceeded ${browserOutputLimit} bytes.`,
    );
  }
  let response: unknown;
  try {
    response = parseCliJson(result.stdout);
  } catch (error) {
    if (result.exitCode === 0) throw error;
    throw new BrowserToolError("cli-error", "Browser command failed.");
  }
  const cliFailure = readCliFailure(response);
  if (cliFailure !== undefined || result.exitCode !== 0) {
    throw new BrowserToolError(
      "cli-error",
      sanitizeBrowserText(cliFailure ?? "Browser command failed.").slice(
        0,
        browserOutputLimit,
      ),
    );
  }
  return response;
}

function readCliOrigin(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.result !== "string") return undefined;
  try {
    const decoded: unknown = JSON.parse(value.result);
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

async function removeSessionDirectory(input: {
  deadlineAt: number;
  session: string;
  workspace: PreparationWorkspace;
}): Promise<void> {
  try {
    await executeSubmittedCode(
      input.workspace,
      `rm -rf -- ${shellQuote(`${browserOutputDirectory}/${input.session}`)}`,
      { timeoutMs: remainingTimeout(input.deadlineAt) },
    );
  } catch {
    // Cleanup is independent and best effort; the original task outcome wins.
  }
}

function resolveRelativeUrl(authorizedUrl: string, path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    throw new Error(
      "Browser navigation path must be relative to the prepared app.",
    );
  }
  const authorized = new URL(authorizedUrl);
  const resolved = new URL(path, authorized);
  if (resolved.origin !== authorized.origin) {
    throw new Error(
      "Browser navigation path must stay within the prepared app origin.",
    );
  }
  return resolved.toString();
}

function remainingTimeout(deadlineAt: number | undefined): number {
  if (deadlineAt === undefined) return browserCommandTimeoutMs;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0)
    throw new Error("Browser command exceeded the Pipeline deadline.");
  return Math.max(1, Math.min(browserCommandTimeoutMs, remaining));
}

function throwIfCancelled(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): void {
  if (signal?.aborted === true)
    throw signal.reason ?? new Error("Browser command cancelled.");
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new Error("Browser command exceeded the Pipeline deadline.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeBrowserOutput(
  value: unknown,
  kind:
    | "action"
    | "inspect-console"
    | "inspect-requests"
    | "inspect-snapshot"
    | "navigation",
): string {
  if (kind === "action" || kind === "navigation") {
    if (isRecord(value)) return "";
  } else if (kind === "inspect-snapshot") {
    if (isRecord(value) && typeof value.snapshot === "string") {
      return sanitizeBrowserText(value.snapshot).slice(0, browserOutputLimit);
    }
  } else if (isRecord(value) && typeof value.result === "string") {
    return sanitizeBrowserText(value.result).slice(0, browserOutputLimit);
  }
  throw new BrowserToolError(
    "invalid-cli-output",
    "Browser CLI returned an invalid result.",
  );
}

function parseCliJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // The stable error below intentionally hides raw provider output.
  }
  throw new BrowserToolError(
    "invalid-cli-output",
    "Browser CLI returned invalid JSON.",
  );
}

function readCliFailure(value: unknown, depth = 0): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.isError === true) {
    return typeof value.error === "string"
      ? value.error
      : "Browser command failed.";
  }
  if (depth >= 2) return undefined;
  if (isRecord(value.result)) {
    return readCliFailure(value.result, depth + 1);
  }
  if (typeof value.result === "string") {
    try {
      return readCliFailure(JSON.parse(value.result), depth + 1);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeBrowserText(value: string): string {
  return value
    .replace(/\/tmp\/makeademo-browser-tools\/[^\s"']+/g, "[internal-path]")
    .replace(/https?:\/\/[^\s"']+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.hash = "";
        for (const key of [...parsed.searchParams.keys()]) {
          parsed.searchParams.set(key, "[redacted]");
        }
        return parsed.toString();
      } catch {
        return "[redacted-url]";
      }
    });
}
