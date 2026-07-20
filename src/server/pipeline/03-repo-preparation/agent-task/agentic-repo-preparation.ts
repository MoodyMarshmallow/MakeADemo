import type { AgentSession } from "../../../agent-harness/agent-session";
import type {
  AgentTaskRunResult,
  AgentTaskRunner,
} from "../../../agent-harness/agent-session-runner.interface";
import type { AgentMeaningfulActivity } from "../../../agent-harness/agent-session-timeout";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";
import type { ProjectValidationResult } from "../../05-capture-path-validation/project-runtime-preflight/validation-result";
import { runPlannedDependencyInstallWithNetworkWindow } from "../dependency-install-network-window";
import { evaluateDependencyNetworkRequest } from "../dependency-network-gate";
import {
  type readPreparationManifest,
  validateNativeVisibleInterfaceProvenance,
} from "../preparation-manifest";
import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../preparation-workspace-runner";
import type { PreparationWorkspace } from "../preparation-workspace.interface";
import type {
  RepoPreparationAgent,
  RepoPreparationInput,
} from "../repo-preparation-agent.interface";
import { inspectSubmittedCodeToolchain } from "../submitted-code-toolchain-inspection";
import { createRepoPreparationAgentWorkspace } from "./repo-preparation-agent-workspace";
import {
  type ValidationRequest,
  preparationManifestPath,
  readPreparationManifestFile,
} from "./repo-preparation-artifact-handoff";
import {
  type RepoPreparationControlState,
  createRepoPreparationControlState,
} from "./repo-preparation-control-state";
import {
  createContinueRepoPreparationPrompt,
  createDaytonaRepoPreparationPrompt,
  createDependencyInstallFailurePrompt,
  createValidationFeedbackPrompt,
} from "./repo-preparation-prompt-policy";
import {
  type RepoPreparationCloneDiagnosticsContext,
  bootstrapRepoPreparationWorkspace,
} from "./repo-preparation-workspace-bootstrap";
import { createRepoPreparationStageTools } from "./tools/repo-preparation-stage-tools";
import {
  type RepoPreparationToolHandoff,
  repoPreparationToolProtocol,
} from "./tools/repo-preparation-tool-protocol";

const minimumBackendToolBudgetMs = 100;
const cloneFailureOutputMaxLength = 1_500;
const cloneFailureOutputChannelMaxLength = 750;
const cloneFailureDiagnosticValueMaxLength = 500;
const defaultInactivityTimeoutMs = 600_000;
const defaultHardTimeoutMs = 1_800_000;
const validationRepairAttemptLimit = 8;
const maximumAgentTaskTurns = validationRepairAttemptLimit * 2;
export type AgenticRepoPreparationOptions = {
  /**
   * Non-secret provider configuration copied into clone-failure diagnostics.
   * Values must be stable identifiers only; implementations must not include
   * environment values, API keys, or submitted repository contents here.
   */
  cloneFailureDiagnosticsContext?: RepoPreparationCloneDiagnosticsContext;
  /**
   * Receives non-fatal Repo Preparation infrastructure events. Implementations
   * must preserve the agent's ability to continue when best-effort audit
   * logging fails; this class suppresses logger write failures for that reason.
   */
  logger?: PipelineEventLogger;
  provider: PreparationWorkspaceProvider;
  runner: AgentTaskRunner;
  timeoutMs?: number;
  /** Overall post-setup Repo Preparation agent-task loop cap. */
  hardTimeoutMs?: number;
  validatePreparation?: (input: {
    manifest: ReturnType<typeof readPreparationManifest>;
    workspace: PreparationWorkspaceHandle;
  }) => Promise<ProjectValidationResult>;
};

export class AgenticRepoPreparation implements RepoPreparationAgent {
  private readonly cloneFailureDiagnosticsContext:
    | RepoPreparationCloneDiagnosticsContext
    | undefined;
  private readonly logger: PipelineEventLogger;
  private readonly provider: PreparationWorkspaceProvider;
  private readonly runner: AgentTaskRunner;
  private readonly timeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly validatePreparation:
    | ((input: {
        manifest: ReturnType<typeof readPreparationManifest>;
        workspace: PreparationWorkspaceHandle;
      }) => Promise<ProjectValidationResult>)
    | undefined;

  constructor(options: AgenticRepoPreparationOptions) {
    this.cloneFailureDiagnosticsContext =
      options.cloneFailureDiagnosticsContext;
    this.logger = options.logger ?? createRepoPreparationLogger();
    this.provider = options.provider;
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs ?? defaultInactivityTimeoutMs;
    this.hardTimeoutMs = options.hardTimeoutMs ?? defaultHardTimeoutMs;
    this.validatePreparation = options.validatePreparation;
  }

  async prepare(input: RepoPreparationInput): Promise<RepoPreparationResult> {
    return this.prepareOnce(input);
  }

  private async prepareOnce(
    input: RepoPreparationInput,
  ): Promise<RepoPreparationResult> {
    const handle = await this.provider.create();
    await this.writeSandboxLog(handle.workspace, {
      event: "workspace-created",
      timeoutMs: this.timeoutMs,
      workspaceId: handle.id,
    });
    let result: TimedRunResult<PreparationSetupResult>;
    try {
      result = await raceWithTimeout(
        this.runPreparation(handle, input),
        this.timeoutMs,
      );
    } catch (error) {
      await this.writeSandboxLog(handle.workspace, {
        error: readErrorMessage(error),
        event: "preparation-error",
      });
      await cancelActiveCommandsQuietly(handle);
      await releaseQuietly(handle);
      return {
        assumptions: [],
        blockers: [readErrorMessage(error)],
        status: "failed" as const,
        suggestedChanges: [
          "Retry Repo Preparation in a fresh Daytona workspace.",
        ],
      };
    }

    if (result.status !== "succeeded") {
      await this.writeSandboxLog(handle.workspace, {
        event: "preparation-timeout",
        workspaceId: handle.id,
        ...result,
        reason: result.reason,
      });
      await cancelActiveCommandsQuietly(handle);
      await releaseQuietly(handle);
      return {
        assumptions: [],
        blockers: [result.reason],
        status: "failed" as const,
        suggestedChanges: [
          "Retry Repo Preparation in a fresh Daytona workspace.",
        ],
      };
    }

    if (result.value.status === "ready") {
      let loopResult: AgentTaskLoopResult;
      try {
        loopResult = await this.runAgentTaskLoop(
          handle,
          input,
          result.value.prompt,
          result.value.baselineSourceControlledPaths,
        );
      } catch (error) {
        await this.writeSandboxLog(handle.workspace, {
          error: readErrorMessage(error),
          event: "preparation-error",
        });
        await cancelActiveCommandsQuietly(handle);
        await releaseQuietly(handle);
        return {
          assumptions: [],
          blockers: [readErrorMessage(error)],
          status: "failed" as const,
          suggestedChanges: [
            "Retry Repo Preparation in a fresh Daytona workspace.",
          ],
        };
      }
      if (loopResult.status === "failed") {
        await releaseQuietly(handle);
      }

      return loopResult;
    }

    const setupResult = result.value.result;
    if (setupResult.status === "failed") {
      await releaseQuietly(handle);
    }

    return setupResult;
  }

  private async runPreparation(
    handle: PreparationWorkspaceHandle,
    input: RepoPreparationInput,
  ): Promise<PreparationSetupResult> {
    const bootstrap = await bootstrapRepoPreparationWorkspace({
      ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
      ...(this.cloneFailureDiagnosticsContext === undefined
        ? {}
        : {
            cloneFailureDiagnosticsContext: this.cloneFailureDiagnosticsContext,
          }),
      logger: this.logger,
      repoUrl: input.repoUrl,
      workspace: handle.workspace,
    });
    if (bootstrap.failure !== undefined) {
      return { result: bootstrap.failure, status: "result" };
    }
    const toolchain = await inspectSubmittedCodeToolchain(handle.workspace);
    if (toolchain.mode === "unsupported") {
      await this.writeSandboxLog(handle.workspace, {
        code: toolchain.code,
        event: "submitted-code-toolchain.unsupported",
        reason: toolchain.reason,
      });
      return {
        result: {
          assumptions: [],
          blockers: [
            `Submitted code toolchain is unsupported (${toolchain.code}): ${toolchain.reason}`,
          ],
          status: "failed" as const,
          suggestedChanges: [
            "Use a supported submitted-code toolchain with an immutable lockfile, then retry Repo Preparation.",
          ],
        },
        status: "result",
      };
    }
    handle.toolchainPlan = toolchain.plan;
    await this.writeSandboxLog(handle.workspace, {
      catalogRevision: toolchain.plan.catalogRevision,
      event: "submitted-code-toolchain.catalog-selected",
      ...(toolchain.plan.installBlocker === undefined
        ? {}
        : { installBlockerCode: toolchain.plan.installBlocker.code }),
      nodeVersion: toolchain.plan.node.version,
      ...(toolchain.plan.packageManager === undefined
        ? {}
        : {
            packageManager: `${toolchain.plan.packageManager.name}@${toolchain.plan.packageManager.version}`,
          }),
      projectRoot: toolchain.plan.projectRoot,
    });

    if (handle.workspace.prepareForAgent === undefined) {
      throw new Error(
        "Repo Preparation workspace cannot establish unprivileged agent access.",
      );
    }
    await handle.workspace.prepareForAgent();

    return {
      baselineSourceControlledPaths:
        bootstrap.baselineSourceControlledPaths ?? [],
      prompt: createDaytonaRepoPreparationPrompt(input),
      status: "ready",
    };
  }

  private async runAgentTaskLoop(
    handle: PreparationWorkspaceHandle,
    input: RepoPreparationInput,
    initialPrompt: string,
    baselineSourceControlledPaths: string[],
  ): Promise<AgentTaskLoopResult> {
    let prompt = initialPrompt;
    let agentSession: AgentSession | undefined;
    let validationRepairAttempts = 0;
    const controlState = createRepoPreparationControlState({
      readManifest: () =>
        readPreparationManifestFile(handle.workspace, preparationManifestPath),
    });
    const hardDeadlineAt = Date.now() + this.hardTimeoutMs;
    for (let attempt = 0; attempt < maximumAgentTaskTurns; attempt += 1) {
      const initialDeadlineAt = Math.min(
        Date.now() + this.timeoutMs,
        hardDeadlineAt,
      );
      let deadlineAt = initialDeadlineAt;
      if (Date.now() >= hardDeadlineAt) {
        return this.timeoutPreparation(
          handle,
          `Repo Preparation exceeded its hard cap of ${this.hardTimeoutMs}ms.`,
          {
            timeoutKind: "hard-cap",
            hardTimeoutMs: this.hardTimeoutMs,
            inactivityTimeoutMs: this.timeoutMs,
          },
        );
      }
      await this.writeSandboxLog(handle.workspace, {
        attempt: attempt + 1,
        event: "agent-task.started",
        remainingMs: deadlineAt - Date.now(),
      });
      let agentTaskResult: AgentTaskRunResult<RepoPreparationToolHandoff>;
      agentTaskResult = await this.runner.run({
        attempt: attempt + 1,
        hardDeadlineAt,
        hardTimeoutMs: this.hardTimeoutMs,
        inactivityLabel: "Repo Preparation agent",
        inactivityTimeoutMs: this.timeoutMs,
        ...(agentSession === undefined ? {} : { session: agentSession }),
        stage: "repo-preparation",
        taskPrompt: prompt,
        tools: createRepoPreparationStageTools(controlState),
        toolProtocol: repoPreparationToolProtocol,
        workspace: createRepoPreparationAgentWorkspace(handle.workspace),
      });
      if (Date.now() >= hardDeadlineAt) {
        return this.timeoutPreparation(
          handle,
          `Repo Preparation exceeded its hard cap of ${this.hardTimeoutMs}ms.`,
          {
            timeoutKind: "hard-cap",
            hardTimeoutMs: this.hardTimeoutMs,
            inactivityTimeoutMs: this.timeoutMs,
          },
        );
      }
      if (
        Date.now() > initialDeadlineAt &&
        agentTaskResult.lastMeaningfulActivity !== undefined
      ) {
        deadlineAt = Math.min(Date.now() + this.timeoutMs, hardDeadlineAt);
      }
      agentSession = agentTaskResult.session ?? agentSession;
      await this.writeSandboxLog(handle.workspace, {
        attempt: attempt + 1,
        event: "agent-task.finished",
        exitCode: agentTaskResult.exitCode,
        hasAgentSession: agentSession !== undefined,
        ...(agentTaskResult.events === undefined
          ? {}
          : { eventCount: agentTaskResult.events.length }),
      });

      if (agentTaskResult.failure?.category === "timeout") {
        return this.timeoutPreparation(
          handle,
          agentTaskResult.failure.message,
          this.timeoutMetadataForDeadline(hardDeadlineAt),
        );
      }

      if (agentTaskResult.handoffError !== undefined) {
        return toolPayloadProtocolFailure(agentTaskResult.handoffError);
      }

      // Pi executes stage tools directly against this backend-owned state. The
      // handoff adapter is retained only for provider-neutral runners and test
      // doubles that report a completed tool call instead of executing it.
      if (
        agentTaskResult.handoff?.toolName === "makeademo_validate_preparation"
      ) {
        await controlState.requestValidation(agentTaskResult.handoff.input);
      }
      if (
        agentTaskResult.handoff?.toolName ===
          "makeademo_dependency_request_install" ||
        agentTaskResult.handoff?.toolName === "makeademo_install_dependencies"
      ) {
        await controlState.requestDependencyInstall(
          agentTaskResult.handoff.input,
        );
      }

      const validationRequest = controlState.takeValidationRequest();
      if (validationRequest !== undefined) {
        const validationOutcome = await this.processValidationRequest({
          attempt,
          canExecuteRetry: attempt + 1 < maximumAgentTaskTurns,
          agentSession,
          controlState,
          deadlineAt,
          handle,
          input,
          baselineSourceControlledPaths,
          validationRepairAttempts,
          validationRequest,
        });
        if (validationOutcome.status === "retry") {
          validationRepairAttempts += 1;
          prompt = validationOutcome.prompt;
          continue;
        }
        if (validationOutcome.status === "timeout") {
          return this.timeoutPreparation(
            handle,
            validationOutcome.reason,
            this.timeoutMetadataForDeadline(hardDeadlineAt),
          );
        }
        return validationOutcome.result;
      }

      const dependencyRequest = controlState.takeDependencyInstallRequest();
      if (dependencyRequest !== undefined) {
        const dependencyDecision = evaluateDependencyNetworkRequest({
          command: dependencyRequest.command,
          reason: "dependency-install",
        });
        if (dependencyDecision.status === "denied") {
          throw new Error(dependencyDecision.reason);
        }
        await this.writeSandboxLog(handle.workspace, {
          command: dependencyRequest.command,
          event: "dependency-install-requested",
        });
        if (deadlineAt - Date.now() < minimumBackendToolBudgetMs) {
          return backendToolDeadlineFailure("dependency installation");
        }
        const refreshedToolchain = await inspectSubmittedCodeToolchain(
          handle.workspace,
        );
        if (refreshedToolchain.mode === "unsupported") {
          throw new Error(
            `Submitted code toolchain is unsupported (${refreshedToolchain.code}): ${refreshedToolchain.reason}`,
          );
        }
        handle.toolchainPlan = refreshedToolchain.plan;
        const plannedInstall = handle.toolchainPlan;
        if (plannedInstall.install === undefined) {
          const blocker = plannedInstall.installBlocker;
          throw new Error(
            `Submitted code toolchain cannot install dependencies (${blocker?.code ?? "missing_immutable_install"}): ${blocker?.reason ?? "No catalog-owned immutable install is available."}`,
          );
        }
        await this.writeSandboxLog(handle.workspace, {
          event: "dependency-install-catalog-command-selected",
          executedArgv: plannedInstall.install.argv,
          executedExecutable: plannedInstall.install.executable,
          requestedCommand: dependencyRequest.command,
        });
        const installRun = await raceWithTimeout(
          runPlannedDependencyInstallWithNetworkWindow({
            toolchainPlan: plannedInstall,
            workspace: handle.workspace,
          }),
          Math.max(1, deadlineAt - Date.now()),
        );
        if (installRun.status !== "succeeded") {
          return this.timeoutPreparation(
            handle,
            installRun.reason,
            this.timeoutMetadataForDeadline(hardDeadlineAt),
          );
        }
        const installResult = installRun.value;
        await this.writeSandboxLog(handle.workspace, {
          event: "dependency-install-finished",
          exitCode: installResult.exitCode,
          stderrLength: installResult.stderr.length,
          stdoutLength: installResult.stdout.length,
        });
        if (attempt + 1 >= maximumAgentTaskTurns) {
          return {
            assumptions: [],
            blockers: [
              "Repo Preparation reached its total agent-task turn limit after dependency installation.",
            ],
            status: "failed" as const,
            suggestedChanges: [
              "Retry Repo Preparation in a fresh Daytona workspace.",
            ],
          };
        }
        await writeRepoPreparationRetryLog(this.logger, handle.workspace, {
          nextAttempt: attempt + 2,
          reason:
            installResult.exitCode === 0
              ? "dependency-install-completed"
              : "dependency-install-failed",
        });
        prompt =
          installResult.exitCode === 0
            ? createContinueRepoPreparationPrompt(input)
            : createDependencyInstallFailurePrompt(input, installResult);
        continue;
      }

      const preparationResult = controlState.readSubmittedResult();
      if (preparationResult !== undefined) {
        await this.writeSandboxLog(handle.workspace, {
          event: "preparation-result-found",
          status: preparationResult.status,
        });
        const validation = controlState.readValidation()?.validation;
        if (
          preparationResult.status === "succeeded" &&
          validation?.status === "succeeded"
        ) {
          return {
            ...preparationResult,
            ...(agentSession === undefined ? {} : { agentSession }),
            validation,
            workspace: handle,
          };
        }

        return preparationResult;
      }

      const providerAuthFailure = readProviderAuthFailure(agentTaskResult);
      if (providerAuthFailure !== undefined) {
        return providerAuthFailure;
      }

      return agentTaskFailureResult(agentTaskResult.failure?.message);
    }

    return {
      assumptions: [],
      blockers: [
        "Repo Preparation exceeded the validation/dependency repair loop limit.",
      ],
      status: "failed" as const,
      suggestedChanges: [
        "Reduce demo setup complexity or fix validation blockers manually.",
      ],
    };
  }

  private async timeoutPreparation(
    handle: PreparationWorkspaceHandle,
    reason: string,
    timeoutMetadata: TimeoutMetadata = {},
  ): Promise<RepoPreparationResult> {
    await this.writeSandboxLog(handle.workspace, {
      event: "preparation-timeout",
      reason,
      workspaceId: handle.id,
      ...timeoutMetadata,
    });
    await cancelActiveCommandsQuietly(handle);
    return {
      assumptions: [],
      blockers: [reason],
      status: "failed" as const,
      suggestedChanges: [
        "Retry Repo Preparation in a fresh Daytona workspace.",
      ],
    };
  }

  private timeoutMetadataForDeadline(hardDeadlineAt: number): TimeoutMetadata {
    return {
      hardTimeoutMs: this.hardTimeoutMs,
      inactivityTimeoutMs: this.timeoutMs,
      timeoutKind: Date.now() >= hardDeadlineAt ? "hard-cap" : "inactivity",
    };
  }

  private async processValidationRequest(input: {
    attempt: number;
    baselineSourceControlledPaths: string[];
    canExecuteRetry: boolean;
    agentSession: AgentSession | undefined;
    controlState: RepoPreparationControlState;
    deadlineAt: number;
    handle: PreparationWorkspaceHandle;
    input: RepoPreparationInput;
    validationRepairAttempts: number;
    validationRequest: ValidationRequest;
  }): Promise<
    | { prompt: string; status: "retry" }
    | { reason: string; status: "timeout" }
    | {
        result: Awaited<ReturnType<RepoPreparationAgent["prepare"]>>;
        status: "done";
      }
  > {
    await this.writeSandboxLog(input.handle.workspace, {
      event: "preparation-preflight.requested",
      remainingMs: input.deadlineAt - Date.now(),
    });
    if (input.deadlineAt - Date.now() < minimumBackendToolBudgetMs) {
      return {
        result: backendToolDeadlineFailure("preparation preflight"),
        status: "done",
      };
    }
    if (this.validatePreparation === undefined) {
      throw new Error("Repo Preparation validation tool is not configured.");
    }
    const validatePreparation = this.validatePreparation;
    let manifest: ReturnType<typeof readPreparationManifest> | undefined;
    let validation: ProjectValidationResult;
    try {
      const validationRun = await raceWithTimeout(
        (async () => {
          const refreshedToolchain = await inspectSubmittedCodeToolchain(
            input.handle.workspace,
          );
          if (refreshedToolchain.mode === "unsupported") {
            throw new Error(
              `Submitted code toolchain is unsupported (${refreshedToolchain.code}): ${refreshedToolchain.reason}`,
            );
          }
          input.handle.toolchainPlan = refreshedToolchain.plan;
          manifest = await readPreparationManifestFile(
            input.handle.workspace,
            input.validationRequest.manifestPath,
          );
          validateNativeVisibleInterfaceProvenance(
            manifest,
            input.baselineSourceControlledPaths,
          );
          return await validatePreparation({
            manifest,
            workspace: input.handle,
          });
        })(),
        Math.max(1, input.deadlineAt - Date.now()),
      );
      if (validationRun.status !== "succeeded") {
        return { reason: validationRun.reason, status: "timeout" };
      }
      validation = validationRun.value;
    } catch (error) {
      validation = createValidationHandoffFailure(readErrorMessage(error));
    }
    await this.writeSandboxLog(input.handle.workspace, {
      failureReason: validation.failureReason,
      event: "preparation-preflight.finished",
      level: validation.status === "failed" ? "warn" : "info",
      status: validation.status,
    });
    input.controlState.recordValidation({ manifest, validation });
    const nonRetryablePreflightFailure =
      readNonRetryablePreflightFailure(validation);
    if (nonRetryablePreflightFailure !== undefined) {
      await this.writeSandboxLog(input.handle.workspace, {
        event: "preparation-preflight.non-retryable-failure",
        failureReason: nonRetryablePreflightFailure,
      });
      return {
        result: {
          assumptions: [],
          blockers: [nonRetryablePreflightFailure],
          status: "failed" as const,
          suggestedChanges: [
            "Report this MakeADemo infrastructure failure instead of asking the app preparation agent to repair the submitted repo.",
          ],
        },
        status: "done",
      };
    }
    if (validation.status === "succeeded" && manifest !== undefined) {
      await this.writeSandboxLog(input.handle.workspace, {
        event: "preparation-auto-succeeded-after-preflight",
        status: validation.status,
      });
      return {
        result: {
          manifest,
          ...(input.agentSession === undefined
            ? {}
            : { agentSession: input.agentSession }),
          status: "succeeded" as const,
          validation,
          workspace: input.handle,
        },
        status: "done",
      };
    }
    if (
      input.validationRepairAttempts >= validationRepairAttemptLimit ||
      !input.canExecuteRetry
    ) {
      return {
        result: validationRepairExhaustedFailure(validation),
        status: "done",
      };
    }
    await writeRepoPreparationRetryLog(this.logger, input.handle.workspace, {
      nextAttempt: input.attempt + 2,
      reason: readRetryReason(validation.failureReason),
    });
    return {
      prompt: createValidationFeedbackPrompt({
        manifest,
        manifestPath: input.validationRequest.manifestPath,
        remainingBudgetMs: Math.max(0, input.deadlineAt - Date.now()),
        validation,
      }),
      status: "retry",
    };
  }

  private async writeSandboxLog(
    workspace: PreparationWorkspace,
    event: Record<string, unknown>,
  ): Promise<void> {
    await writePreparationSandboxLog(this.logger, workspace, event);
  }
}

type AgentTaskLoopResult = RepoPreparationResult;

type RepoPreparationResult = Awaited<
  ReturnType<RepoPreparationAgent["prepare"]>
>;

type TimedRunResult<T> =
  | { status: "succeeded"; value: T }
  | ({ reason: string; status: "failed" | "timed-out" } & TimeoutMetadata);

type TimeoutMetadata = {
  timeoutKind?: "inactivity" | "hard-cap";
  inactivityTimeoutMs?: number;
  hardTimeoutMs?: number;
  lastMeaningfulActivity?: AgentMeaningfulActivity;
  lastMeaningfulActivityAt?: number;
  lastMeaningfulActivityTool?: string;
};

type PreparationSetupResult =
  | {
      baselineSourceControlledPaths: string[];
      prompt: string;
      status: "ready";
    }
  | { result: RepoPreparationResult; status: "result" };

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimedRunResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve({
        reason: `Repo Preparation agent timed out after ${timeoutMs}ms.`,
        status: "timed-out",
      });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          resolve({ status: "succeeded", value });
        }
      },
      (error: unknown) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
  });
}

async function releaseQuietly(
  handle: PreparationWorkspaceHandle,
): Promise<void> {
  try {
    await handle.release();
  } catch {
    // Preserve the original Repo Preparation failure.
  }
}

async function cancelActiveCommandsQuietly(
  handle: PreparationWorkspaceHandle,
): Promise<void> {
  try {
    await handle.workspace.cancelActiveCommands?.();
  } catch {
    // Preserve the timeout failure while still letting the caller return.
  }
}

async function writePreparationSandboxLog(
  logger: PipelineEventLogger,
  workspace: PreparationWorkspace,
  event: Record<string, unknown>,
): Promise<void> {
  const eventName =
    typeof event.event === "string" ? event.event : "repo-preparation.debug";
  try {
    void workspace
      .writeSandboxLog?.({
        ...event,
        event: eventName,
        stage: "repo-preparation",
      })
      ?.catch((error) => {
        warnPreparationSandboxLogWriteFailed(logger, eventName, error);
      });
  } catch (error) {
    warnPreparationSandboxLogWriteFailed(logger, eventName, error);
  }
}

async function writePreparationSandboxLogDurable(
  logger: PipelineEventLogger,
  workspace: PreparationWorkspace,
  event: Record<string, unknown>,
): Promise<void> {
  const eventName =
    typeof event.event === "string" ? event.event : "repo-preparation.debug";
  try {
    await workspace.writeSandboxLog?.({
      ...event,
      event: eventName,
      stage: "repo-preparation",
    });
  } catch (error) {
    warnPreparationSandboxLogWriteFailed(logger, eventName, error);
  }
}

function warnPreparationSandboxLogWriteFailed(
  logger: PipelineEventLogger,
  eventName: string,
  error: unknown,
): void {
  try {
    void logger
      .warn(
        {
          error: readErrorMessage(error),
          event: "sandbox-log-write-failed",
          failedEvent: eventName,
          stage: "repo-preparation",
          workspaceComponent: "sandbox-log",
        },
        "Repo Preparation sandbox log write failed.",
      )
      .catch(() => {
        // Preserve Repo Preparation progress if the fallback logger also fails.
      });
  } catch {
    // Preserve Repo Preparation progress if the fallback logger also fails.
  }
}

async function writeRepoPreparationRetryLog(
  logger: PipelineEventLogger,
  workspace: PreparationWorkspace,
  input: { nextAttempt: number; reason: string },
): Promise<void> {
  await writePreparationSandboxLog(logger, workspace, {
    event: "repo-preparation.retrying",
    level: "warn",
    nextAttempt: input.nextAttempt,
    reason: input.reason,
  });
}

function createRepoPreparationLogger(): PipelineEventLogger {
  return createPipelineEventLogger({
    base: { component: "repo-preparation-agent" },
    sinks: [
      {
        write(line) {
          process.stderr.write(line);
        },
      },
    ],
  });
}

function readRetryReason(reason: string | undefined): string {
  return reason === undefined || reason.trim().length === 0
    ? "validation-failed"
    : reason;
}

function validationRepairExhaustedFailure(
  validation: ProjectValidationResult,
): RepoPreparationResult {
  const failureReason = readRetryReason(validation.failureReason);
  return {
    assumptions: [],
    blockers: [failureReason],
    status: "failed",
    suggestedChanges:
      validation.warnings.length === 0
        ? [
            "Repair the reported validation failure before retrying Repo Preparation.",
          ]
        : validation.warnings,
    validation,
  };
}

function readNonRetryablePreflightFailure(
  validation: ProjectValidationResult,
): string | undefined {
  if (validation.failureKind !== "submitted-code-workspace-sync-failed") {
    return undefined;
  }

  return `Preparation preflight failed with a non-retryable MakeADemo infrastructure failure: ${validation.failureReason ?? validation.failureKind}`;
}

function backendToolDeadlineFailure(toolName: string) {
  return {
    assumptions: [],
    blockers: [
      `Repo Preparation ran out of time before ${toolName} could start.`,
    ],
    status: "failed" as const,
    suggestedChanges: [
      "Retry Repo Preparation with a fresh Daytona workspace or a longer preparation timeout.",
    ],
  };
}

function toolPayloadProtocolFailure(reason: string) {
  return {
    assumptions: [],
    blockers: [
      `Repo Preparation MakeADemo tool payload protocol error: ${reason}`,
    ],
    status: "failed" as const,
    suggestedChanges: [
      "Retry Repo Preparation in a fresh Daytona workspace; report this MakeADemo tool protocol failure if it repeats.",
    ],
  };
}

function readProviderAuthFailure(
  result: Pick<AgentTaskRunResult, "failure">,
): RepoPreparationResult | undefined {
  return result.failure?.category === "provider-auth-invalid"
    ? providerInvalidApiKeyFailureResult()
    : undefined;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function agentTaskFailureResult(
  message = "Agent task failed.",
): RepoPreparationResult {
  return {
    assumptions: [],
    blockers: [message],
    status: "failed",
    suggestedChanges: [
      "Retry Repo Preparation in a fresh Daytona workspace; report this MakeADemo agent failure if it repeats.",
    ],
  };
}

function providerInvalidApiKeyFailureResult(): RepoPreparationResult {
  return {
    assumptions: [],
    blockers: [
      "Agent provider authentication failed because the provider rejected the configured API key.",
    ],
    status: "failed",
    suggestedChanges: [
      "Verify the configured provider API key before retrying Repo Preparation.",
    ],
  };
}

function createValidationHandoffFailure(
  reason: string,
): ProjectValidationResult {
  return {
    blockedNetworkAttempts: [],
    failureReason: `Preparation manifest handoff is invalid: ${reason}`,
    logs: [
      "MakeADemo could not run preparation preflight because the preparation manifest handoff was invalid.",
      `Manifest path: ${preparationManifestPath}`,
      `Error: ${reason}`,
    ],
    status: "failed",
    warnings: [],
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
