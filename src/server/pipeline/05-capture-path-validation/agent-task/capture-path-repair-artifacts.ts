import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { readPreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import {
  createDemoScriptCaptureContractPrompt,
  createDemoScriptSchemaPrompt,
  demoScriptPath,
  readErrorMessage,
  truncateForPrompt,
} from "../../04-script-generation/agent-task/demo-script-artifacts";
import type { CapturePathRepairInput } from "../capture-path-repairer.interface";

const makeADemoArtifactDirectory = "/workspace/.makeademo";
const preparationManifestPath = `${makeADemoArtifactDirectory}/preparation-manifest.json`;
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

export async function readPreparationManifestArtifact(
  input: {
    preparationWorkspace: PreparationWorkspaceHandle;
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

export function createCapturePathRepairPrompt(
  input: CapturePathRepairInput,
  browserToolsEnabled = false,
): string {
  return [
    "# MakeADemo Capture Path Repair",
    "",
    "Capture Path Validation failed for the Demo Script you generated.",
    "Repair the prepared workspace, the Demo Script, or both. The backend will rerun full Capture Path Validation after this attempt.",
    ...(browserToolsEnabled
      ? [
          "Browser tools are available for the validated local app. Inspect after navigating or making major page changes before using accessibility references.",
        ]
      : []),
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
          currentScriptId: input.demoScript.scriptId,
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
    truncateForPrompt(JSON.stringify(input.demoScript, null, 2)),
    "```",
    "",
    createDemoScriptSchemaPrompt(),
  ].join("\n");
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
