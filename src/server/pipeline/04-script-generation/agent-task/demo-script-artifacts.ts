import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { readPreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { CapturePathRepairInput } from "../../05-capture-path-validation/capture-path-repairer.interface";
import type { DemoScript } from "../../06-footage-capture/demo-script.schema";
import type { DemoScriptPackage } from "../demo-script-package";
import type { AgenticScriptGenerationInput } from "../script-generation-agent.interface";

const makeADemoArtifactDirectory = "/workspace/.makeademo";
const preparationManifestPath = `${makeADemoArtifactDirectory}/preparation-manifest.json`;
export const demoScriptPath = `${makeADemoArtifactDirectory}/demo-script.json`;
const postRepairArtifactReadRetryDelaysMs = [250, 500] as const;

export async function writeRepairSandboxLog(
  logger: PipelineEventLogger,
  input: CapturePathRepairInput,
  entry: Record<string, unknown>,
): Promise<void> {
  const logEntry = {
    ...entry,
    repoUrl: input.repoUrl,
    stage: "capture-path-repair",
    workspaceId: input.preparationManifest.workspaceId,
  };

  try {
    void input.preparationWorkspace?.workspace
      .writeSandboxLog?.(logEntry)
      .catch((error) => {
        warnSandboxLogWriteFailed(logger, logEntry, error);
      });
  } catch (error) {
    warnSandboxLogWriteFailed(logger, logEntry, error);
  }
}

function warnSandboxLogWriteFailed(
  logger: PipelineEventLogger,
  entry: Record<string, unknown>,
  error: unknown,
): void {
  try {
    void logger
      .warn(
        {
          error: readErrorMessage(error),
          event: "sandbox-log-write-failed",
          failedEvent:
            typeof entry.event === "string" ? entry.event : undefined,
          stage: "capture-path-repair",
          workspaceComponent: "sandbox-log",
        },
        "Sandbox progress log write failed.",
      )
      .catch(() => undefined);
  } catch {
    // Preserve Capture Path Repair progress if fallback logging fails.
  }
}

export async function readPostRepairArtifact<
  T extends { reason?: string; status: string },
>(input: {
  artifactName: string;
  input: CapturePathRepairInput;
  logger: PipelineEventLogger;
  read: () => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  const start = Date.now();
  const timeoutMessage = `Post-repair artifact read ${input.artifactName} timed out after ${input.timeoutMs}ms.`;
  await writeRepairSandboxLog(input.logger, input.input, {
    artifact: input.artifactName,
    attempt: input.input.attempt,
    durationMs: 0,
    event: "capture-path-repair.artifact-read.started",
    operation: `post-repair artifact read ${input.artifactName}`,
    timeoutMs: input.timeoutMs,
  });

  const deadline = start + input.timeoutMs;
  let failure: unknown;
  for (
    let readAttempt = 1;
    readAttempt <= postRepairArtifactReadRetryDelaysMs.length + 1;
    readAttempt += 1
  ) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      failure = new Error(timeoutMessage);
      break;
    }

    try {
      const artifact = await withTimeout(
        input.read(),
        remainingMs,
        timeoutMessage,
      );
      const durationMs = Date.now() - start;
      if (artifact.status === "failed") {
        const reason = `Post-repair artifact read ${input.artifactName} failed: ${artifact.reason ?? "unknown artifact read failure"}`;
        await writeRepairSandboxLog(input.logger, input.input, {
          artifact: input.artifactName,
          attempt: input.input.attempt,
          durationMs,
          event: "capture-path-repair.artifact-read.failed",
          operation: `post-repair artifact read ${input.artifactName}`,
          reason,
        });
        return { ...artifact, reason };
      }

      await writeRepairSandboxLog(input.logger, input.input, {
        artifact: input.artifactName,
        attempt: input.input.attempt,
        durationMs,
        event: "capture-path-repair.artifact-read.succeeded",
        operation: `post-repair artifact read ${input.artifactName}`,
      });
      return artifact;
    } catch (error) {
      if (
        readAttempt <= postRepairArtifactReadRetryDelaysMs.length &&
        isTransientDaytonaSocketClosedError(error)
      ) {
        const delayMs =
          postRepairArtifactReadRetryDelaysMs[readAttempt - 1] ?? 0;
        const remainingAfterReadMs = deadline - Date.now();
        if (remainingAfterReadMs > 0) {
          await writeRepairSandboxLog(input.logger, input.input, {
            artifact: input.artifactName,
            attempt: readAttempt,
            delayMs,
            durationMs: Date.now() - start,
            event: "capture-path-repair.artifact-read.retrying",
            nextAttempt: readAttempt + 1,
            operation: `post-repair artifact read ${input.artifactName}`,
            reason: `Transient Daytona socket closure while reading ${input.artifactName}: ${readErrorMessage(error)}`,
          });
          try {
            await withTimeout(
              wait(delayMs),
              remainingAfterReadMs,
              timeoutMessage,
            );
            continue;
          } catch (retryDelayError) {
            failure = retryDelayError;
            break;
          }
        }
      }

      failure = error;
      break;
    }
  }

  try {
    throw failure ?? new Error(timeoutMessage);
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMessage = readErrorMessage(error);
    const reason = errorMessage.includes("timed out after")
      ? errorMessage
      : `Post-repair artifact read ${input.artifactName} failed: ${errorMessage}`;
    const event = errorMessage.includes("timed out after")
      ? "capture-path-repair.artifact-read.timeout"
      : "capture-path-repair.artifact-read.failed";
    await writeRepairSandboxLog(input.logger, input.input, {
      artifact: input.artifactName,
      attempt: input.input.attempt,
      durationMs,
      event,
      operation: `post-repair artifact read ${input.artifactName}`,
      reason,
    });
    return { reason, status: "failed" } as T;
  }
}

function isTransientDaytonaSocketClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("socket connection was closed") ||
    message.includes("socket was closed") ||
    message.includes("socket closed")
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  promise.catch(() => undefined);
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

export function boundedArtifactTimeout(
  timeoutMs: number,
  hardDeadlineAt: number,
): number {
  return Math.max(1, Math.min(timeoutMs, hardDeadlineAt - Date.now()));
}

export async function readScriptPackageArtifact(
  input: Pick<AgenticScriptGenerationInput, "preparationWorkspace">,
  options: { timeoutMs?: number } = {},
): Promise<
  { status: "succeeded"; value: unknown } | { reason: string; status: "failed" }
> {
  const result = await input.preparationWorkspace.workspace.execute(
    `if test -f ${shellQuote(demoScriptPath)}; then cat ${shellQuote(demoScriptPath)}; else exit 1; fi`,
    options,
  );
  if (result.exitCode !== 0) {
    return {
      reason: `Agent task did not write ${demoScriptPath}.`,
      status: "failed",
    };
  }

  try {
    return { status: "succeeded", value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      reason: `Demo Script artifact is not valid JSON: ${readErrorMessage(error)}`,
      status: "failed",
    };
  }
}

export async function readPreparationManifestArtifact(
  input: {
    preparationWorkspace: AgenticScriptGenerationInput["preparationWorkspace"];
  },
  options: { timeoutMs?: number } = {},
): Promise<
  | { status: "succeeded"; value: ReturnType<typeof readPreparationManifest> }
  | { status: "missing" }
  | { reason: string; status: "failed" }
> {
  const result = await input.preparationWorkspace.workspace.execute(
    `if test -f ${shellQuote(preparationManifestPath)}; then cat ${shellQuote(preparationManifestPath)}; else exit 42; fi`,
    options,
  );
  if (result.exitCode === 42) {
    return { status: "missing" };
  }
  if (result.exitCode !== 0) {
    return {
      reason: `Could not read ${preparationManifestPath}: ${result.stderr}`,
      status: "failed",
    };
  }

  try {
    return {
      status: "succeeded",
      value: readPreparationManifest(JSON.parse(result.stdout)),
    };
  } catch (error) {
    return {
      reason: `Preparation Manifest artifact is not valid: ${readErrorMessage(error)}`,
      status: "failed",
    };
  }
}

export function attachPipelineMetadata(
  scriptPackage: DemoScript,
  input: AgenticScriptGenerationInput,
): DemoScriptPackage {
  const exploration = {
    assumptions: input.preparationManifest.assumptions,
    productSurfaces: input.preparationManifest.scriptGenerationContext,
    summary: input.preparationManifest.setupSummary,
  };
  const demoPlan = {
    featureOrder: input.demoBrief.keyProductFeatures,
    narrative: scriptPackage.title,
    risks: input.preparationManifest.risks,
  };

  return {
    ...scriptPackage,
    assumptions: exploration.assumptions,
    demoPlan,
    exploration,
  };
}

export function createCapturePathRepairPrompt(
  input: CapturePathRepairInput,
): string {
  return [
    "# MakeADemo Capture Path Repair",
    "",
    "Capture Path Validation failed for the Demo Script you generated.",
    "Repair the prepared workspace, the Demo Script, or both. The backend will rerun full Capture Path Validation after this attempt.",
    "",
    "## Hard Requirements",
    `- Overwrite ${demoScriptPath} with the repaired Demo Script JSON before finishing.`,
    "- The demoPlaywrightScript must import `{ setup, scene }` from `./makeademo-capture-sdk`.",
    "- Every `scene(id, async ({ page, expect }) => { ... })` must end with at least one visible Playwright locator assertion such as `await expect(page.getByText('Saved')).toBeVisible()`, `await expect(page.locator('#invoice-table')).toContainText('INV-2049')`, or `await expect(page.locator('[data-testid=\"status\"]')).toHaveText('Paid')`.",
    "- Primitive assertions like `expect(await locator.innerText()).toBe(...)` do not satisfy the visible assertion contract; pair any DOM reads with a final Playwright locator assertion.",
    `- If you change the prepared app command, URL, assumptions, risks, or workspace-change summary, update ${preparationManifestPath}.`,
    "- Keep Playwright interactions deterministic and use only the provided `baseUrl` variable in Playwright scripts.",
    "- Do not add Scene durations, raw video recording, custom marker writers, or timestamps.",
    ...createDemoScriptCaptureContractPrompt(),
    "- Do not run final Footage Capture. You may run fast local checks if useful.",
    "",
    "## Failure Evidence",
    "```json",
    truncateForPrompt(
      JSON.stringify(
        {
          attempt: input.attempt,
          failure: input.failure,
          currentScriptId: input.demoScriptPackage.scriptId,
        },
        null,
        2,
      ),
    ),
    "```",
    input.failure.diagnosticsLogPath === undefined
      ? "No Capture Path diagnostics log path was returned. Use the structured failure evidence above."
      : `Before editing, read the Capture Path diagnostics log at ${input.failure.diagnosticsLogPath}. It contains verbose validation stdout/stderr excerpts and is written inside the prepared workspace for agent inspection.`,
    "",
    "## Current Preparation Manifest",
    "```json",
    JSON.stringify(input.preparationManifest, null, 2),
    "```",
    "",
    "## Current Demo Script",
    "```json",
    truncateForPrompt(JSON.stringify(input.demoScriptPackage, null, 2)),
    "```",
    "",
    createScriptPackageSchemaPrompt(),
  ].join("\n");
}

export function createScriptPackageSchemaPrompt(): string {
  return [
    "## Required Demo Script Shape",
    "The artifact must be one JSON object with every required top-level field present.",
    "Use this exact shape, replacing example strings and scripts with repo-specific content:",
    "```json",
    JSON.stringify(
      {
        audio: { enabled: true, music: { id: "clean" } },
        demoPlaywrightScript:
          "import { setup, scene } from './makeademo-capture-sdk';\n\nawait setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });\nawait scene('scene_requested_feature', async ({ page, expect }) => {\n  await page.getByRole('button', { name: /example/i }).click();\n  await expect(page.getByText(/result/i)).toBeVisible();\n});",
        format: "16:9",
        presentation: {
          music: { enabled: true, trackId: "clean" },
          textOverlays: [
            {
              content: "Show the requested feature",
              font: "Inter",
              position: "bottom-left",
              sceneId: "scene_requested_feature",
              size: "medium",
            },
          ],
          transitions: [],
        },
        scenes: [
          {
            description:
              "Show the requested feature with real UI interactions.",
            expectedVisibleOutcome: "The feature result is visible.",
            id: "scene_requested_feature",
          },
        ],
        scriptId: "script_unique_demo_id",
        title: "Concise demo title",
        version: 1,
      },
      null,
      2,
    ),
    "```",
    "Top-level `scriptId`, `title`, `format`, `version`, `demoPlaywrightScript`, non-empty `scenes`, and `presentation` are mandatory on every attempt.",
    "Each Scene must include `id`, `description`, and `expectedVisibleOutcome`. Do not include `durationSeconds` on recorded Scenes.",
  ].join("\n");
}

export function createDemoScriptCaptureContractPrompt(): string[] {
  return [
    "- Only use the MakeADemo Capture SDK: import `{ setup, scene }` from `./makeademo-capture-sdk` and write interactions inside those callbacks.",
    "- Do not use real-time network access in the Demo Script. Do not call `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `page.request`, `page.waitForRequest`, `page.waitForResponse`, `page.route`, `page.unroute`, or Node network modules such as `http`, `https`, `net`, or `dns`.",
    "- Use the prepared app through the provided `baseUrl`, deterministic user-visible interactions, and Playwright locator assertions. Do not inspect app internals, mutate app state with injected JavaScript, or depend on network request timing.",
    "- Every Scene step must be executable against the prepared app and must finish with a visible locator assertion proving the expected outcome.",
  ];
}

export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncateForPrompt(value: string, maxLength = 20_000): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
