import { basename } from "node:path";
import type { AgentTaskRunner } from "../../../agent-harness/agent-session-runner.interface";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";
import { validateDemoScriptCandidate } from "../demo-script-candidate-validator";
import type { DemoScriptPackage } from "../demo-script-package";
import type {
  AgenticScriptGenerationInput,
  ScriptGenerationAgent,
} from "../script-generation-agent.interface";
import {
  attachPipelineMetadata,
  boundedArtifactTimeout,
  createDemoScriptCaptureContractPrompt,
  createScriptPackageSchemaPrompt,
  demoScriptPath,
  readErrorMessage,
  readScriptPackageArtifact,
  truncateForPrompt,
} from "./demo-script-artifacts";

const initialArtifactReadTimeoutMs = 60_000;
const initialArtifactReadRetryDelaysMs = [250, 500] as const;
const defaultInactivityTimeoutMs = 600_000;
const defaultHardTimeoutMs = 1_800_000;

export type AgenticScriptGeneratorOptions = {
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

  constructor(options: AgenticScriptGeneratorOptions) {
    this.logger = options.logger ?? createScriptGenerationLogger();
    this.maxAttempts = options.maxAttempts ?? 3;
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs ?? defaultInactivityTimeoutMs;
    this.hardTimeoutMs = options.hardTimeoutMs ?? defaultHardTimeoutMs;
  }

  async generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<DemoScriptPackage> {
    const hardDeadlineAt = Date.now() + this.hardTimeoutMs;
    let prompt = createScriptGenerationPrompt(input);
    let lastFailure =
      "Script Generation did not produce a valid script package.";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
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
      await removePreviousScriptPackage(input);
      const result = await this.runner.run({
        attempt,
        taskPrompt: prompt,
        session: input.agentSession,
        stage: "script-generation",
        hardDeadlineAt,
        inactivityTimeoutMs: this.timeoutMs,
        hardTimeoutMs: this.hardTimeoutMs,
        workspace: input.preparationWorkspace.workspace,
      });

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
        prompt = createScriptGenerationRepairPrompt(lastFailure);
        await writeScriptGenerationRetryLog(this.logger, input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: retryReason,
        });
        continue;
      }

      const artifact = await readInitialScriptPackageArtifact({
        attempt,
        input,
        logger: this.logger,
        timeoutMs: boundedArtifactTimeout(
          Math.min(initialArtifactReadTimeoutMs, this.timeoutMs),
          hardDeadlineAt,
        ),
      });
      if (artifact.status === "failed") {
        lastFailure = artifact.reason;
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.artifact.missing",
          level: scriptGenerationAttemptFailureLevel(attempt, this.maxAttempts),
          reason: lastFailure,
        });
        prompt = createScriptGenerationRepairPrompt(lastFailure);
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
        return attachPipelineMetadata(demoScript, input);
      } catch (error) {
        lastFailure = readErrorMessage(error);
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.script-package.invalid",
          level: scriptGenerationAttemptFailureLevel(attempt, this.maxAttempts),
          reason: lastFailure,
        });
        prompt = createScriptGenerationRepairPrompt(lastFailure);
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

async function removePreviousScriptPackage(
  input: AgenticScriptGenerationInput,
): Promise<void> {
  await input.preparationWorkspace.workspace.execute(
    `rm -f ${shellQuote(demoScriptPath)}`,
  );
}

async function readInitialScriptPackageArtifact(input: {
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
        readScriptPackageArtifact(input.input, { timeoutMs: input.timeoutMs }),
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
    createScriptPackageSchemaPrompt(),
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

function createScriptGenerationRepairPrompt(reason: string): string {
  return [
    "# MakeADemo Script Generation Repair",
    "",
    `The previous Script Generation output was rejected: ${reason}`,
    `Repair the Demo Script and overwrite ${demoScriptPath}.`,
    "Do not modify app source. Include real user interactions and feature-specific assertions.",
    "",
    createScriptPackageSchemaPrompt(),
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
