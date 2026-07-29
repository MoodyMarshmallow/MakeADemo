import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import {
  type SubmittedCodeNodeReleaseCatalog,
  submittedCodeKnownGoodNodeReleaseCatalog,
} from "../../../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import type {
  BrowserValidationOutput,
  BrowserValidator,
} from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/browser-validator.interface";
import {
  type DemoRuntimePreflightDependencies,
  runDemoRuntimePreflight,
} from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/demo-runtime-preflight";
import type { SandboxRunner } from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/sandbox-runner.interface";
import type { DemoRuntimePreflightResult } from "../../../pipeline/05-capture-path-validation/demo-runtime-preflight/validation-result";
import { PlaywrightBrowserValidator } from "../browser/playwright-browser-validator";
import { PreparedWorkspaceSandboxRunner } from "../sandbox/prepared-workspace-sandbox-runner";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";
import { RailwaySdkSandboxGateway } from "./railway-sdk-sandbox-gateway";
import { RailwaySpikePreparationWorkspaceProvider } from "./railway-spike-preparation-workspace-provider";
import { railwaySpikeTemplateRecipe } from "./railway-spike-template-recipe";

const localFixtureUrl = "http://127.0.0.1:4173/";
const transferredScreenshotPath =
  "/workspace/.makeademo/demo-runtime-preflight/browser.png";
const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/localhost-app/", import.meta.url),
);

export type RailwayPreflightSpikeEvidenceReport = Readonly<{
  browserUrl: string;
  cleanupFailure?: Readonly<{ message: string; name: string }>;
  evidenceDirectory: string;
  localUrl: string;
  logs: string[];
  publicPreviewCreated: false;
  reportPath: string;
  screenshot: Readonly<{
    mimeType: "image/png";
    path: string;
    sha256: `sha256:${string}`;
    sizeBytes: number;
  }>;
  status: "succeeded";
  templateRevision: string;
  pinnedToolVersions: Readonly<{
    node: string;
    npm: string;
    playwright: string;
  }>;
  warnings: string[];
  workspaceId: string;
}>;

type RailwaySpikeEnvironment = Readonly<Record<string, string | undefined>>;
type RailwaySpikeWorkspaceProvider = {
  create(options?: {
    signal?: AbortSignal;
  }): Promise<PreparationWorkspaceHandle>;
};

/**
 * Injectable external seams for the hard-gated Railway canary. Defaults are
 * deliberately constructed only after the opt-in gate succeeds, so ordinary
 * imports and tests cannot provision Railway resources.
 */
type RailwayPreflightSpikeDependencies = {
  browserValidator?: BrowserValidator;
  createGateway?: (input: {
    environmentId: string;
    projectToken: string;
    railwayAgentSession?: string;
    railwayCaller?: string;
  }) => RailwaySandboxGateway;
  createProvider?: (
    gateway: RailwaySandboxGateway,
  ) => RailwaySpikeWorkspaceProvider;
  nodeReleaseCatalog?: SubmittedCodeNodeReleaseCatalog;
  sandboxRunner?: SandboxRunner;
};

export type RailwayPreflightSpikeInput = {
  dependencies?: RailwayPreflightSpikeDependencies;
  evidenceRootDirectory?: string;
  environment?: RailwaySpikeEnvironment;
  signal?: AbortSignal;
};

/**
 * Runs the Railway-only Demo Runtime Preflight canary against the checked-in
 * localhost fixture. This is not production composition: its explicit gate,
 * dedicated credential names, and fixed provider make accidental use fail
 * before a Railway SDK gateway can be constructed.
 */
export async function runRailwayPreflightSpike(
  input: RailwayPreflightSpikeInput = {},
): Promise<RailwayPreflightSpikeEvidenceReport> {
  const environment = input.environment ?? process.env;
  const credentials = readRailwaySpikeCredentials(environment);
  throwIfAborted(input.signal);
  const dependencies = input.dependencies ?? {};
  const gateway =
    dependencies.createGateway?.(credentials) ??
    new RailwaySdkSandboxGateway(credentials);
  const provider: RailwaySpikeWorkspaceProvider =
    dependencies.createProvider?.(gateway) ??
    new RailwaySpikePreparationWorkspaceProvider({ gateway });

  let handle: PreparationWorkspaceHandle | undefined;
  let operationError: unknown;
  let evidenceDirectory: string | undefined;
  let pendingPreflight: Promise<DemoRuntimePreflightResult> | undefined;
  let report: RailwayPreflightSpikeEvidenceReport | undefined;
  try {
    handle = await provider.create(
      input.signal === undefined ? {} : { signal: input.signal },
    );
    throwIfAborted(input.signal);
    const preparationManifest = createFixtureManifest(handle.id);
    await handle.workspace.uploadFiles(fixtureUploads(), {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    throwIfAborted(input.signal);
    const browserValidator = new EvidenceCapturingBrowserValidator(
      dependencies.browserValidator ?? new PlaywrightBrowserValidator(),
    );
    pendingPreflight = runDemoRuntimePreflight(
      { preparationManifest, preparationWorkspace: handle },
      preflightDependencies(dependencies, browserValidator),
    );
    const result = await waitForAbort(pendingPreflight, input.signal);
    throwIfAborted(input.signal);
    const screenshot = browserValidator.output?.screenshot ?? result.screenshot;
    assertCanaryPreflight(result, screenshot);
    const persistedScreenshot = await persistScreenshotEvidence({
      evidenceRootDirectory: input.evidenceRootDirectory ?? tmpdir(),
      screenshot,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      workspace: handle.workspace,
    });
    evidenceDirectory = persistedScreenshot.evidenceDirectory;
    report = redactedEvidenceReport({
      credentials,
      persistedScreenshot,
      result,
      workspaceId: handle.id,
    });
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  if (handle !== undefined) {
    try {
      await handle.release();
    } catch (error) {
      releaseError = error;
    }
  }
  await pendingPreflight?.catch(() => undefined);
  if (operationError !== undefined || releaseError !== undefined) {
    const failures = [operationError, releaseError].filter(
      (error): error is unknown => error !== undefined,
    );
    if (releaseError !== undefined && report !== undefined) {
      report = {
        ...report,
        cleanupFailure: readRedactedErrorMetadata(
          releaseError,
          credentials.projectToken,
        ),
      };
      try {
        await writeEvidenceReport(report);
      } catch (reportError) {
        failures.push(reportError);
      }
    } else {
      await cleanupPartialEvidence(evidenceDirectory);
    }
    throw redactError(
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "Railway preflight spike operation and release both failed.",
          ),
      credentials.projectToken,
    );
  }
  if (report === undefined) {
    await cleanupPartialEvidence(evidenceDirectory);
    throw new Error("Railway preflight spike completed without evidence.");
  }
  try {
    await writeEvidenceReport(report);
  } catch (error) {
    await cleanupPartialEvidence(evidenceDirectory);
    throw redactError(error, credentials.projectToken);
  }
  return report;
}

type RailwayPreflightSpikeCliProcess = {
  exitCode: number | undefined;
  off(event: NodeJS.Signals, listener: () => void): unknown;
  once(event: NodeJS.Signals, listener: () => void): unknown;
  stderr: { write(value: string): unknown };
  stdout: { write(value: string): unknown };
};

/** Runs the spike command without terminating the process before cleanup. */
export async function runRailwayPreflightSpikeCli(
  input: {
    process?: RailwayPreflightSpikeCliProcess;
    run?: (
      input: RailwayPreflightSpikeInput,
    ) => Promise<RailwayPreflightSpikeEvidenceReport>;
  } = {},
): Promise<void> {
  const cliProcess = input.process ?? process;
  const run = input.run ?? runRailwayPreflightSpike;
  const controller = new AbortController();
  let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
  const onSigint = () => {
    receivedSignal ??= "SIGINT";
    controller.abort(new Error("SIGINT"));
  };
  const onSigterm = () => {
    receivedSignal ??= "SIGTERM";
    controller.abort(new Error("SIGTERM"));
  };
  cliProcess.once("SIGINT", onSigint);
  cliProcess.once("SIGTERM", onSigterm);
  try {
    const report = await run({ signal: controller.signal });
    if (receivedSignal === undefined) {
      cliProcess.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
  } catch (error) {
    if (receivedSignal === undefined) {
      cliProcess.stderr.write(
        `${JSON.stringify({
          error: readRedactedFailureDiagnostic(error),
          event: "railway-preflight-spike-failed",
        })}\n`,
      );
      cliProcess.exitCode = 1;
      return;
    }
  } finally {
    cliProcess.off("SIGINT", onSigint);
    cliProcess.off("SIGTERM", onSigterm);
  }
  cliProcess.stderr.write(
    `Railway preflight spike interrupted by ${receivedSignal}.\n`,
  );
  cliProcess.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
}

function readRailwaySpikeCredentials(environment: RailwaySpikeEnvironment): {
  environmentId: string;
  projectToken: string;
  railwayAgentSession?: string;
  railwayCaller?: string;
} {
  if (environment.RUN_RAILWAY_SANDBOX_SPIKE !== "1") {
    throw new Error(
      "Railway preflight spike requires RUN_RAILWAY_SANDBOX_SPIKE=1.",
    );
  }
  const projectToken = environment.MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN;
  const environmentId = environment.MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID;
  if (projectToken?.trim() === "" || projectToken === undefined) {
    throw new Error(
      "Railway preflight spike requires MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN.",
    );
  }
  if (environmentId?.trim() === "" || environmentId === undefined) {
    throw new Error(
      "Railway preflight spike requires MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID.",
    );
  }
  const railwayAgentSession = nonEmpty(environment.RAILWAY_AGENT_SESSION);
  const railwayCaller = nonEmpty(environment.RAILWAY_CALLER);
  return {
    environmentId,
    projectToken,
    ...(railwayAgentSession === undefined ? {} : { railwayAgentSession }),
    ...(railwayCaller === undefined ? {} : { railwayCaller }),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function fixtureUploads() {
  return ["package-lock.json", "package.json", "server.mjs"].map(
    (filename) => ({
      destinationPath: `/workspace/${filename}`,
      sourcePath: `${fixtureDirectory}${filename}`,
    }),
  );
}

function createFixtureManifest(workspaceId: string): PreparationManifest {
  return {
    assumptions: ["Railway spike fixture binds only to loopback."],
    createdFiles: [],
    demoCommand: "node server.mjs",
    dependencyInstall: "not-required",
    diffArtifactId: "railway-spike-fixture",
    existingDemoEvidence: ["Checked-in localhost fixture."],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "railway-spike://localhost-app",
    risks: ["Railway is an opt-in canary only."],
    scriptGenerationContext: [],
    setupSummary: "Run the checked-in loopback fixture in the Railway canary.",
    status: "reused-existing-demo",
    url: localFixtureUrl,
    workspaceId,
  };
}

function preflightDependencies(
  dependencies: RailwayPreflightSpikeDependencies,
  browserValidator: BrowserValidator,
): DemoRuntimePreflightDependencies {
  return {
    browserValidator,
    nodeReleaseCatalog:
      dependencies.nodeReleaseCatalog ??
      submittedCodeKnownGoodNodeReleaseCatalog,
    sandboxRunner:
      dependencies.sandboxRunner ??
      new PreparedWorkspaceSandboxRunner({ releaseWorkspaceOnCleanup: false }),
  };
}

function assertCanaryPreflight(
  result: DemoRuntimePreflightResult,
  screenshot: BrowserValidationOutput["screenshot"],
): void {
  if (result.status !== "succeeded") {
    throw new Error(
      `Railway preflight spike failed: ${result.failureReason ?? "unknown failure"}`,
    );
  }
  if (
    result.localUrl !== localFixtureUrl ||
    result.browserUrl !== localFixtureUrl
  ) {
    throw new Error(
      "Railway preflight spike did not validate the loopback URL.",
    );
  }
  if (result.previewUrl !== undefined) {
    throw new Error(
      "Railway preflight spike must not create a public preview.",
    );
  }
  if (
    screenshot?.mimeType !== "image/png" ||
    screenshot.path !== transferredScreenshotPath ||
    screenshot.sizeBytes === undefined ||
    screenshot.sizeBytes <= 0
  ) {
    throw new Error(
      "Railway preflight spike did not transfer PNG screenshot proof to the preparation workspace.",
    );
  }
}

function redactedEvidenceReport(input: {
  credentials: { environmentId: string; projectToken: string };
  persistedScreenshot: PersistedScreenshotEvidence;
  result: DemoRuntimePreflightResult;
  workspaceId: string;
}): RailwayPreflightSpikeEvidenceReport {
  return {
    browserUrl: input.result.browserUrl ?? localFixtureUrl,
    evidenceDirectory: input.persistedScreenshot.evidenceDirectory,
    localUrl: input.result.localUrl ?? localFixtureUrl,
    logs: input.result.logs.map((log) => redactText(log, input.credentials)),
    publicPreviewCreated: false,
    reportPath: join(
      input.persistedScreenshot.evidenceDirectory,
      "report.json",
    ),
    screenshot: {
      mimeType: "image/png",
      path: input.persistedScreenshot.path,
      sha256: input.persistedScreenshot.sha256,
      sizeBytes: input.persistedScreenshot.sizeBytes,
    },
    status: "succeeded",
    templateRevision: railwaySpikeTemplateRecipe.revision,
    pinnedToolVersions: {
      node: railwaySpikeTemplateRecipe.node.version,
      npm: railwaySpikeTemplateRecipe.node.npmVersion,
      playwright: railwaySpikeTemplateRecipe.playwright.version,
    },
    warnings: input.result.warnings.map((warning) =>
      redactText(warning, input.credentials),
    ),
    workspaceId: input.workspaceId,
  };
}

async function writeEvidenceReport(
  report: RailwayPreflightSpikeEvidenceReport,
): Promise<void> {
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
}

function readRedactedErrorMetadata(
  error: unknown,
  projectToken: string,
): { message: string; name: string } {
  const redacted = redactError(error, projectToken);
  return { message: redacted.message, name: redacted.name };
}

type PersistedScreenshotEvidence = {
  evidenceDirectory: string;
  path: string;
  sha256: `sha256:${string}`;
  sizeBytes: number;
};

async function persistScreenshotEvidence(input: {
  evidenceRootDirectory: string;
  screenshot: BrowserValidationOutput["screenshot"];
  signal?: AbortSignal;
  workspace: PreparationWorkspaceHandle["workspace"];
}): Promise<PersistedScreenshotEvidence> {
  if (
    input.screenshot === undefined ||
    input.workspace.downloadFiles === undefined
  ) {
    throw new Error(
      "Railway preflight spike cannot persist screenshot evidence.",
    );
  }
  await mkdir(input.evidenceRootDirectory, { recursive: true });
  const evidenceDirectory = await mkdtemp(
    join(input.evidenceRootDirectory, "makeademo-railway-preflight-"),
  );
  const path = join(evidenceDirectory, "browser.png");
  try {
    await input.workspace.downloadFiles(
      [{ destinationPath: path, sourcePath: input.screenshot.path }],
      {
        maxBytes: 10 * 1024 * 1024,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    const bytes = await readFile(path);
    if (
      bytes.length !== input.screenshot.sizeBytes ||
      bytes.length < pngSignature.length ||
      !bytes.subarray(0, pngSignature.length).equals(pngSignature)
    ) {
      throw new Error(
        "Railway preflight spike persisted invalid PNG screenshot evidence.",
      );
    }
    return {
      evidenceDirectory,
      path,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      sizeBytes: bytes.length,
    };
  } catch (error) {
    await cleanupPartialEvidence(evidenceDirectory);
    throw error;
  }
}

async function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(readAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw readAbortError(signal);
}

function readAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Railway preflight spike was aborted.", "AbortError");
}

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function cleanupPartialEvidence(
  evidenceDirectory: string | undefined,
): Promise<void> {
  if (evidenceDirectory !== undefined) {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
}

class EvidenceCapturingBrowserValidator implements BrowserValidator {
  output: BrowserValidationOutput | undefined;

  constructor(private readonly validator: BrowserValidator) {}

  async validate(
    input: Parameters<BrowserValidator["validate"]>[0],
  ): Promise<BrowserValidationOutput> {
    this.output = await this.validator.validate(input);
    return this.output;
  }
}

function redactError(error: unknown, projectToken: string): Error {
  const credentials = { environmentId: "", projectToken };
  const redacted = redactErrorValue(error, credentials, new WeakSet<object>());
  return redacted instanceof Error
    ? redacted
    : new Error(redactText(String(redacted), credentials));
}

const circularDiagnosticMarker = "[circular]";

function redactErrorValue(
  value: unknown,
  credentials: { environmentId: string; projectToken: string },
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return circularDiagnosticMarker;
    seen.add(value);
  }
  if (value instanceof AggregateError) {
    const redacted = new AggregateError(
      value.errors.map((nestedError) =>
        redactErrorValue(nestedError, credentials, seen),
      ),
      redactText(value.message, credentials),
    );
    redacted.name = value.name;
    copyRedactedLifecycleMetadata(value, redacted, credentials, seen);
    if (value.cause !== undefined) {
      redacted.cause = redactErrorValue(value.cause, credentials, seen);
    }
    return redacted;
  }
  if (value instanceof Error) {
    const redacted = new Error(redactText(value.message, credentials));
    redacted.name = value.name;
    copyRedactedLifecycleMetadata(value, redacted, credentials, seen);
    if (value.cause !== undefined) {
      redacted.cause = redactErrorValue(value.cause, credentials, seen);
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactErrorValue(entry, credentials, seen));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveDiagnosticKey(key)
          ? "[redacted]"
          : redactErrorValue(entry, credentials, seen),
      ]),
    );
  }
  return typeof value === "string" ? redactText(value, credentials) : value;
}

function copyRedactedLifecycleMetadata(
  source: Error,
  target: Error,
  credentials: { environmentId: string; projectToken: string },
  seen: WeakSet<object>,
): void {
  const sourceMetadata = source as unknown as Record<string, unknown>;
  const targetMetadata = target as unknown as Record<string, unknown>;
  for (const key of [
    "cleanup",
    "elapsedMs",
    "id",
    "lastStatus",
    "phase",
    "resource",
    "resourceId",
    "sandboxId",
    "status",
  ]) {
    if (sourceMetadata[key] !== undefined) {
      targetMetadata[key] = redactErrorValue(
        sourceMetadata[key],
        credentials,
        seen,
      );
    }
  }
}

function readRedactedFailureDiagnostic(
  value: unknown,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  const credentials = { environmentId: "", projectToken: "" };
  if (!(value instanceof Error)) {
    return {
      message: redactText(String(value), credentials),
      name: "Error",
    };
  }
  if (seen.has(value)) {
    return { message: "[circular error]", name: value.name };
  }
  seen.add(value);

  const source = value as unknown as Record<string, unknown>;
  const diagnostic: Record<string, unknown> = {
    message: redactText(value.message, credentials),
    name: value.name,
  };
  copyDiagnosticCleanup(source, diagnostic, credentials);
  copyDiagnosticNumber(source, diagnostic, "elapsedMs");
  copyDiagnosticString(source, diagnostic, "phase", credentials);
  copyDiagnosticString(source, diagnostic, "resource", credentials);

  const resourceId = source.resourceId ?? source.sandboxId ?? source.id;
  if (typeof resourceId === "string") {
    diagnostic.resourceId = redactText(resourceId, credentials);
  }
  const status = source.status ?? source.lastStatus;
  if (typeof status === "string") {
    diagnostic.status = redactText(status, credentials);
  }
  if (value instanceof AggregateError) {
    diagnostic.errors = value.errors.map((nestedError) =>
      readRedactedFailureDiagnostic(nestedError, seen),
    );
  }
  if (value.cause !== undefined) {
    diagnostic.cause = readRedactedFailureDiagnostic(value.cause, seen);
  }
  return diagnostic;
}

function copyDiagnosticCleanup(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  credentials: { environmentId: string; projectToken: string },
): void {
  const cleanup = source.cleanup;
  if (typeof cleanup === "string") {
    target.cleanup = redactText(cleanup, credentials);
  } else if (containsCircularDiagnostic(cleanup)) {
    target.cleanup = circularDiagnosticMarker;
  }
}

function containsCircularDiagnostic(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (value === circularDiagnosticMarker) return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    return Object.values(value).some((entry) =>
      containsCircularDiagnostic(entry, seen),
    );
  } catch {
    return true;
  }
}

function copyDiagnosticString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  credentials: { environmentId: string; projectToken: string },
): void {
  const value = source[key];
  if (typeof value === "string") target[key] = redactText(value, credentials);
}

function copyDiagnosticNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return /token|credential|secret|password|api[_-]?key|authorization|cookie/i.test(
    key,
  );
}

function redactText(
  value: string,
  credentials: { environmentId: string; projectToken: string },
): string {
  const token = credentials.projectToken;
  const withoutDedicatedToken =
    token.length === 0 ? value : value.split(token).join("[redacted]");
  return withoutDedicatedToken
    .replace(
      /(["']?[a-z0-9_-]*(?:token|credentials?|secret|password|api[_-]?key)[a-z0-9_-]*["']?\s*[:=]\s*["']?)[^\s&;,}"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:authorization\s*:\s*)?bearer\s+)[a-z0-9._~+/=-]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?authorization["']?\s*:\s*["']?)(?!\s*bearer\s+\[redacted\])[^&;,}"'\r\n]+/gi,
      "$1[redacted]",
    );
}
