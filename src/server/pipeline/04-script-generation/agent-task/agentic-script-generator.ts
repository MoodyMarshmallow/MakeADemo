import { basename } from "node:path";
import type { AgentTaskRunner } from "../../../agent-harness/agent-session-runner.interface";
import type { BrowserToolControllerProvider } from "../../../agent-harness/tools/browser/browser-tool-controller-registry";
import { createBrowserStageTools } from "../../../agent-harness/tools/browser/browser-tool-definitions";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";
import { throwIfPipelineDeadlineReached } from "../../00-orchestration/job/pipeline-cancellation";
import { createRepoPreparationAgentWorkspace } from "../../03-repo-preparation/agent-task/repo-preparation-agent-workspace";
import { validateDemoScriptCandidate } from "../demo-script-candidate-validator";
import type { DemoScript } from "../demo-script/demo-script.schema";
import type {
  AgenticScriptGenerationInput,
  ScriptGenerationAgent,
} from "../script-generation-agent.interface";
import {
  boundedArtifactTimeout,
  createDemoScriptCaptureContractPrompt,
  createDemoScriptSchemaPrompt,
  demoScriptPath,
  readDemoScriptArtifact,
  readErrorMessage,
  truncateForPrompt,
} from "./demo-script-artifacts";

const initialArtifactReadTimeoutMs = 60_000;
const initialArtifactReadRetryDelaysMs = [250, 500] as const;
const defaultInactivityTimeoutMs = 600_000;
const defaultHardTimeoutMs = 1_800_000;

export type AgenticScriptGeneratorOptions = {
  /** Supplies stable workspace-scoped browser tools for authorized agent turns. */
  browserToolControllerProvider?: BrowserToolControllerProvider;
  /**
   * Receives non-fatal Script Generation infrastructure
   * events. Implementations must not turn best-effort sandbox audit-log mirror
   * failures into pipeline failures.
   */
  logger?: PipelineEventLogger;
  runner: AgentTaskRunner;
  maxAttempts?: number;
  /** Meaningful agent inactivity limit for each agent task. */
  timeoutMs?: number;
  /** Absolute cap for each public Script Generation call. */
  hardTimeoutMs?: number;
};

export class AgenticScriptGenerator implements ScriptGenerationAgent {
  private readonly logger: PipelineEventLogger;
  private readonly maxAttempts: number;
  private readonly runner: AgentTaskRunner;
  private readonly timeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly browserToolControllerProvider:
    | BrowserToolControllerProvider
    | undefined;

  constructor(options: AgenticScriptGeneratorOptions) {
    this.browserToolControllerProvider = options.browserToolControllerProvider;
    this.logger = options.logger ?? createScriptGenerationLogger();
    this.maxAttempts = options.maxAttempts ?? 3;
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs ?? defaultInactivityTimeoutMs;
    this.hardTimeoutMs = options.hardTimeoutMs ?? defaultHardTimeoutMs;
  }

  async generateDemoScript(
    input: AgenticScriptGenerationInput,
  ): Promise<DemoScript> {
    const hardDeadlineAt = Math.min(
      Date.now() + this.hardTimeoutMs,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    let prompt = createScriptGenerationPrompt(
      input,
      this.browserToolControllerProvider !== undefined,
    );
    let lastFailure = "Script Generation did not produce a valid Demo Script.";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
      if (Date.now() >= hardDeadlineAt) {
        throw new Error(
          `Script Generation exceeded its hard cap of ${this.hardTimeoutMs}ms.`,
        );
      }
      await writeScriptGenerationSandboxLog(this.logger, input, {
        attempt,
        event: "script-generation.agent-task.started",
        agentSession: input.agentSession,
      });
      await removePreviousDemoScript(input);
      const browserController =
        this.browserToolControllerProvider?.forWorkspace({
          deadlineAt: hardDeadlineAt,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          localUrl: input.preparationManifest.url,
          workspace: input.preparationWorkspace.workspace,
        });
      const result = await (async () => {
        try {
          return await this.runner.run({
            attempt,
            taskPrompt: prompt,
            session: input.agentSession,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            stage: "script-generation",
            hardDeadlineAt,
            inactivityTimeoutMs: this.timeoutMs,
            hardTimeoutMs: this.hardTimeoutMs,
            ...(browserController === undefined
              ? {}
              : { tools: createBrowserStageTools(browserController) }),
            workspace: createRepoPreparationAgentWorkspace(
              input.preparationWorkspace.workspace,
            ),
          });
        } finally {
          await resetBrowserController(browserController);
        }
      })();
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);

      if (result.exitCode !== 0) {
        const retryReason = `Script Generation agent task exited with ${result.exitCode}.`;
        lastFailure = `Script Generation agent task exited with ${result.exitCode}: ${result.failure?.message ?? "agent task failed before artifact validation."}`;
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.agent-task.failed",
          exitCode: result.exitCode,
          level: scriptGenerationAttemptFailureLevel(attempt, this.maxAttempts),
          reason: lastFailure,
        });
        prompt = createScriptGenerationRepairPrompt(
          lastFailure,
          browserController !== undefined,
        );
        await writeScriptGenerationRetryLog(this.logger, input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: retryReason,
        });
        continue;
      }

      const artifact = await readInitialDemoScriptArtifact({
        attempt,
        input,
        logger: this.logger,
        timeoutMs: boundedArtifactTimeout(
          Math.min(initialArtifactReadTimeoutMs, this.timeoutMs),
          hardDeadlineAt,
        ),
      });
      throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
      if (artifact.status === "failed") {
        lastFailure = artifact.reason;
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.artifact.missing",
          level: scriptGenerationAttemptFailureLevel(attempt, this.maxAttempts),
          reason: lastFailure,
        });
        prompt = createScriptGenerationRepairPrompt(
          lastFailure,
          browserController !== undefined,
        );
        await writeScriptGenerationRetryLog(this.logger, input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: lastFailure,
        });
        continue;
      }

      try {
        const demoScript = await validateDemoScriptCandidate(artifact.value);
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.demo-script-candidate.succeeded",
          scriptId: demoScript.scriptId,
        });
        return demoScript;
      } catch (error) {
        lastFailure = readErrorMessage(error);
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.demo-script.invalid",
          level: scriptGenerationAttemptFailureLevel(attempt, this.maxAttempts),
          reason: lastFailure,
        });
        prompt = createScriptGenerationRepairPrompt(
          lastFailure,
          browserController !== undefined,
        );
        await writeScriptGenerationRetryLog(this.logger, input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: lastFailure,
        });
      }
    }

    throw new Error(lastFailure);
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

function scriptGenerationAttemptFailureLevel(
  attempt: number,
  maxAttempts: number,
): "error" | "warn" {
  return attempt < maxAttempts ? "warn" : "error";
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

async function writeScriptGenerationSandboxLog(
  logger: PipelineEventLogger,
  input: AgenticScriptGenerationInput,
  entry: Record<string, unknown>,
): Promise<void> {
  await writeSandboxLogBestEffort({
    entry: {
      ...entry,
      repoUrl: input.repoUrl,
      stage: "script-generation",
      workspaceId: input.preparationManifest.workspaceId,
    },
    logger,
    stage: "script-generation",
    write: (logEntry: Record<string, unknown>) =>
      input.preparationWorkspace.workspace.writeSandboxLog?.(logEntry),
  });
}

async function writeSandboxLogBestEffort(input: {
  entry: Record<string, unknown>;
  logger: PipelineEventLogger;
  stage: string;
  write: (entry: Record<string, unknown>) => Promise<void> | undefined;
}): Promise<void> {
  try {
    void input.write(input.entry)?.catch((error) => {
      warnSandboxLogWriteFailed(input, error);
    });
  } catch (error) {
    warnSandboxLogWriteFailed(input, error);
  }
}

function warnSandboxLogWriteFailed(
  input: {
    entry: Record<string, unknown>;
    logger: PipelineEventLogger;
    stage: string;
  },
  error: unknown,
): void {
  try {
    void input.logger
      .warn(
        {
          error: readErrorMessage(error),
          event: "sandbox-log-write-failed",
          failedEvent:
            typeof input.entry.event === "string"
              ? input.entry.event
              : undefined,
          stage: input.stage,
          workspaceComponent: "sandbox-log",
        },
        "Sandbox progress log write failed.",
      )
      .catch(() => undefined);
  } catch {
    // Preserve Script Generation and Capture Path Repair progress if fallback logging fails.
  }
}

function createScriptGenerationLogger(): PipelineEventLogger {
  return createPipelineEventLogger({
    base: { component: "script-generation-agent" },
    sinks: [
      {
        write(line) {
          process.stderr.write(line);
        },
      },
    ],
  });
}

async function writeScriptGenerationRetryLog(
  logger: PipelineEventLogger,
  input: AgenticScriptGenerationInput,
  retry: { attempt: number; maxAttempts: number; reason: string },
): Promise<void> {
  if (retry.attempt >= retry.maxAttempts) {
    return;
  }

  await writeScriptGenerationSandboxLog(logger, input, {
    attempt: retry.attempt,
    event: "script-generation.retrying",
    level: "warn",
    nextAttempt: retry.attempt + 1,
    reason: retry.reason,
  });
}

async function removePreviousDemoScript(
  input: AgenticScriptGenerationInput,
): Promise<void> {
  await input.preparationWorkspace.workspace.execute(
    `rm -f ${shellQuote(demoScriptPath)}`,
  );
}

async function readInitialDemoScriptArtifact(input: {
  attempt: number;
  input: AgenticScriptGenerationInput;
  logger: PipelineEventLogger;
  timeoutMs: number;
}): Promise<
  { status: "succeeded"; value: unknown } | { reason: string; status: "failed" }
> {
  const startedAt = Date.now();
  const timeoutMessage = `Initial Script Generation artifact read ${demoScriptPath} timed out after ${input.timeoutMs}ms.`;
  await writeScriptGenerationSandboxLog(input.logger, input.input, {
    artifact: basename(demoScriptPath),
    attempt: input.attempt,
    event: "script-generation.artifact-read.started",
    operation: `initial artifact read ${basename(demoScriptPath)}`,
    timeoutMs: input.timeoutMs,
  });

  const deadline = startedAt + input.timeoutMs;
  for (
    let readAttempt = 1;
    readAttempt <= initialArtifactReadRetryDelaysMs.length + 1;
    readAttempt += 1
  ) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(timeoutMessage);
    }

    try {
      const artifact = await withTimeout(
        readDemoScriptArtifact(input.input, { timeoutMs: input.timeoutMs }),
        remainingMs,
        timeoutMessage,
      );
      if (artifact.status === "failed") {
        return artifact;
      }

      await writeScriptGenerationSandboxLog(input.logger, input.input, {
        artifact: basename(demoScriptPath),
        attempt: input.attempt,
        durationMs: Date.now() - startedAt,
        event: "script-generation.artifact-read.succeeded",
        operation: `initial artifact read ${basename(demoScriptPath)}`,
        readAttempt,
      });
      return artifact;
    } catch (error) {
      if (
        readAttempt <= initialArtifactReadRetryDelaysMs.length &&
        isTransientDaytonaSocketClosedError(error)
      ) {
        const delayMs = initialArtifactReadRetryDelaysMs[readAttempt - 1] ?? 0;
        const remainingAfterReadMs = deadline - Date.now();
        if (remainingAfterReadMs > 0) {
          await writeScriptGenerationSandboxLog(input.logger, input.input, {
            artifact: basename(demoScriptPath),
            attempt: readAttempt,
            delayMs,
            durationMs: Date.now() - startedAt,
            event: "script-generation.artifact-read.retrying",
            generationAttempt: input.attempt,
            nextAttempt: readAttempt + 1,
            operation: `initial artifact read ${basename(demoScriptPath)}`,
            readAttempt,
            reason: `Transient Daytona socket closure while reading ${basename(demoScriptPath)}: ${readErrorMessage(error)}`,
          });
          await withTimeout(
            wait(delayMs),
            remainingAfterReadMs,
            timeoutMessage,
          );
          continue;
        }
      }

      throw error;
    }
  }

  throw new Error(timeoutMessage);
}

function createScriptGenerationPrompt(
  input: AgenticScriptGenerationInput,
  browserToolsEnabled: boolean,
): string {
  return [
    "# MakeADemo Script Generation",
    "",
    "Repo Preparation has produced a deterministic prepared workspace in this same agent session.",
    "Do not modify application source, package files, lockfiles, or runtime setup during Script Generation.",
    `Write exactly one artifact: ${demoScriptPath}.`,
    "",
    "## Goal",
    "Explore the prepared repo enough to create a Demo Script with one continuous Playwright flow for the requested features.",
    "Use your existing session context from preparation, but inspect relevant routes, components, fixtures, and docs when needed.",
    ...(browserToolsEnabled
      ? [
          "Browser tools are available for the prepared app. Inspect after navigating or making major page changes before using accessibility references.",
        ]
      : []),
    "",
    "## Hard Requirements",
    "- Output JSON matching the capture-ready Demo Script schema.",
    "- The demoPlaywrightScript must import `{ setup, scene }` from `./makeademo-capture-sdk`.",
    "- Every demonstrated feature must have a declared Scene with an expected visible outcome.",
    "- Playwright scripts must use the provided `baseUrl` variable, not hardcoded preview URLs.",
    "- Demonstrate real user flows with route changes, clicks, fills, presses, selectOption calls, or feature-specific assertions.",
    "- Put login, seeding, navigation, and setup outside on-camera Scenes unless that setup is the feature being demonstrated.",
    "- Do not provide Scene durations. Timing comes from Footage Capture.",
    "- Do not use Playwright `recordVideo`, custom marker writers, or agent-authored timestamps.",
    ...createDemoScriptCaptureContractPrompt(),
    "- Do not emit placeholder scripts that only load the page, wait, smoke-check body text, or set inert DOM attributes.",
    "- Keep scripts deterministic and short enough for capture.",
    "- Do not call Repo Preparation tools. Do not request dependency installs. Do not run preparation preflight or Capture Path Validation.",
    "",
    "## Artifact Path",
    demoScriptPath,
    "",
    createDemoScriptSchemaPrompt(),
    "",
    "## Pipeline Context",
    "```json",
    truncateForPrompt(
      JSON.stringify(createScriptGenerationContext(input), null, 2),
    ),
    "```",
  ].join("\n");
}

function createScriptGenerationContext(input: AgenticScriptGenerationInput) {
  return {
    demoBrief: input.demoBrief,
    normalizedSupportingDocuments: input.normalizedSupportingDocuments.map(
      (document) => ({
        sourceArtifactId: document.sourceArtifactId,
        sourceFileName: document.sourceFileName,
        normalizedText: truncateForPrompt(document.normalizedText, 6_000),
      }),
    ),
    preparationManifest: input.preparationManifest,
    repoUrl: input.repoUrl,
  };
}

function createScriptGenerationRepairPrompt(
  reason: string,
  browserToolsEnabled: boolean,
): string {
  return [
    "# MakeADemo Script Generation Repair",
    "",
    `The previous Script Generation output was rejected: ${reason}`,
    `Repair the Demo Script and overwrite ${demoScriptPath}.`,
    "Do not modify app source. Include real user interactions and feature-specific assertions.",
    ...(browserToolsEnabled
      ? [
          "Use a fresh browser inspection after navigating or making major page changes before using accessibility references.",
        ]
      : []),
    "",
    createDemoScriptSchemaPrompt(),
  ].join("\n");
}

async function resetBrowserController(
  controller:
    | ReturnType<BrowserToolControllerProvider["forWorkspace"]>
    | undefined,
): Promise<void> {
  try {
    await controller?.reset();
  } catch {
    // Browser cleanup is best effort and must not replace the stage outcome.
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
