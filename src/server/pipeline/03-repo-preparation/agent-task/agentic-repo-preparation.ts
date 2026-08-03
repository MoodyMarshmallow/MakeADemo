import type { AgentSession } from "../../../agent-harness/agent-session";
import type {
  AgentTaskRunResult,
  AgentTaskRunner,
} from "../../../agent-harness/agent-session-runner.interface";
import type { AgentMeaningfulActivity } from "../../../agent-harness/agent-session-timeout";
import type { BrowserToolControllerProvider } from "../../../agent-harness/tools/browser/browser-tool-controller-registry";
import { createBrowserStageTools } from "../../../agent-harness/tools/browser/browser-tool-definitions";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";
import {
  PipelineCancellationError,
  pipelineCancellationFromSignal,
  throwIfPipelineCancelled,
} from "../../00-orchestration/job/pipeline-cancellation";
import {
  type RuntimeNetworkPolicy,
  defaultRuntimeNetworkPolicy,
} from "../../05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";
import { isPipelineInfrastructureFailureKind } from "../../pipeline-infrastructure-failure";
import { classifyDependencyInstallFailure } from "../dependency-install-failure-classifier";
import { runPlannedDependencyInstall } from "../planned-dependency-install";
import {
  type readPreparationManifest,
  validateNativeVisibleInterfaceProvenance,
} from "../preparation-manifest";
import {
  type PreparationWorkspaceInfrastructureDiagnostic,
  readPreparationWorkspaceInfrastructureDiagnostic,
} from "../preparation-workspace-infrastructure.interface";
import { describeDependencyInstallSigkill } from "../preparation-workspace-resource-diagnostics";
import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../preparation-workspace-runner";
import type { PreparationWorkspace } from "../preparation-workspace.interface";
import type {
  RepoPreparationAgent,
  RepoPreparationInput,
} from "../repo-preparation-agent.interface";
import type { RepoPreparationPreflightResult } from "../repo-preparation-preflight.interface";
import {
  SubmittedCodeToolchainRepairRequiredError,
  provisionSubmittedCodeToolchain,
  quiesceSubmittedRuntime,
  syncSubmittedCodeWorkspace,
} from "../submitted-code-execution";
import type { SubmittedCodeNodeReleaseCatalog } from "../submitted-code-node-release-catalog.interface";
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
  createToolchainRepairPrompt,
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
const defaultInactivityTimeoutMs = 600_000;
const defaultHardTimeoutMs = 1_800_000;
const validationRepairAttemptLimit = 8;
const maximumAgentTaskTurns = validationRepairAttemptLimit * 2;
const dependencyInstallDiagnosticMaxBytes = 1_500;
const submittedRuntimeQuiescenceTimeoutMs = 10_000;
export type AgenticRepoPreparationOptions = {
  /** Supplies browser tools only after a failed authoritative browser preflight. */
  browserToolControllerProvider?: BrowserToolControllerProvider;
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
  /** One immutable trusted Node.js release view shared for this Pipeline Job. */
  nodeReleaseCatalog: SubmittedCodeNodeReleaseCatalog;
  provider: PreparationWorkspaceProvider;
  runner: AgentTaskRunner;
  timeoutMs?: number;
  /** Overall post-setup Repo Preparation agent-task loop cap. */
  hardTimeoutMs?: number;
  runRuntimePreflight?: (input: {
    manifest: ReturnType<typeof readPreparationManifest>;
    workspace: PreparationWorkspaceHandle;
  }) => Promise<RepoPreparationPreflightResult>;
  runtimeNetworkPolicy?: RuntimeNetworkPolicy;
};

export class AgenticRepoPreparation implements RepoPreparationAgent {
  private readonly browserToolControllerProvider:
    | BrowserToolControllerProvider
    | undefined;
  private readonly cloneFailureDiagnosticsContext:
    | RepoPreparationCloneDiagnosticsContext
    | undefined;
  private readonly logger: PipelineEventLogger;
  private readonly nodeReleaseCatalog: SubmittedCodeNodeReleaseCatalog;
  private readonly provider: PreparationWorkspaceProvider;
  private readonly runner: AgentTaskRunner;
  private readonly timeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly runRuntimePreflight:
    | ((input: {
        manifest: ReturnType<typeof readPreparationManifest>;
        workspace: PreparationWorkspaceHandle;
      }) => Promise<RepoPreparationPreflightResult>)
    | undefined;
  private readonly runtimeNetworkPolicy: RuntimeNetworkPolicy;

  constructor(options: AgenticRepoPreparationOptions) {
    this.browserToolControllerProvider = options.browserToolControllerProvider;
    this.cloneFailureDiagnosticsContext =
      options.cloneFailureDiagnosticsContext;
    this.logger = options.logger ?? createRepoPreparationLogger();
    this.runtimeNetworkPolicy =
      options.runtimeNetworkPolicy ?? defaultRuntimeNetworkPolicy;
    this.nodeReleaseCatalog = options.nodeReleaseCatalog;
    this.provider = options.provider;
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs ?? defaultInactivityTimeoutMs;
    this.hardTimeoutMs = options.hardTimeoutMs ?? defaultHardTimeoutMs;
    this.runRuntimePreflight = options.runRuntimePreflight;
  }

  async prepare(input: RepoPreparationInput): Promise<RepoPreparationResult> {
    const budget = createPreparationBudget(input);
    try {
      return await this.prepareOnce({ ...input, signal: budget.signal });
    } finally {
      budget.dispose();
    }
  }

  private async prepareOnce(
    input: RepoPreparationInput,
  ): Promise<RepoPreparationResult> {
    const deadlineAt = input.deadlineAt ?? Date.now() + this.hardTimeoutMs;
    this.throwIfCancelled(input, deadlineAt);
    const creation =
      input.preparationWorkspace === undefined
        ? this.provider.create({
            deadlineAt,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
        : Promise.resolve(input.preparationWorkspace);
    let handle: PreparationWorkspaceHandle;
    try {
      handle = await waitForPreparationOperation(creation, input.signal);
    } catch (error) {
      if (pipelineCancellationFromSignal(input.signal) !== undefined) {
        const lateHandle = await creation.catch(() => undefined);
        let releaseInfrastructure =
          readPreparationWorkspaceInfrastructureDiagnostic(error);
        if (lateHandle !== undefined) {
          await cancelActiveCommandsQuietly(lateHandle);
          releaseInfrastructure ??=
            await releaseInfrastructureQuietly(lateHandle);
        }
        if (releaseInfrastructure !== undefined)
          throw preparationCancellationWithCleanup(
            error,
            input.signal,
            releaseInfrastructure,
          );
        throw preparationCancellation(error, input.signal);
      }
      const infrastructure =
        readPreparationWorkspaceInfrastructureDiagnostic(error);
      if (infrastructure !== undefined)
        return preparationInfrastructureFailure(infrastructure);
      throw error;
    }
    try {
      this.throwIfCancelled(input, deadlineAt);
    } catch (error) {
      await cancelActiveCommandsQuietly(handle);
      const releaseInfrastructure = await releaseInfrastructureQuietly(handle);
      if (releaseInfrastructure !== undefined)
        throw preparationCancellationWithCleanup(
          error,
          input.signal,
          releaseInfrastructure,
        );
      throw error;
    }
    await this.writeSandboxLog(handle.workspace, {
      event: "workspace-created",
      timeoutMs: this.timeoutMs,
      workspaceId: handle.id,
    });
    let result: TimedRunResult<PreparationSetupResult>;
    try {
      result = await runSettledPreparationOperation({
        operation: this.runPreparation(handle, input),
        onCancel: () => cancelActiveCommandsQuietly(handle),
        signal: input.signal,
        timeoutMs: Math.max(
          1,
          Math.min(this.timeoutMs, deadlineAt - Date.now()),
        ),
      });
    } catch (error) {
      if (isPreparationCancellation(error, input.signal)) {
        await cancelActiveCommandsQuietly(handle);
        const releaseInfrastructure =
          await releaseInfrastructureQuietly(handle);
        if (releaseInfrastructure !== undefined)
          throw preparationCancellationWithCleanup(
            error,
            input.signal,
            releaseInfrastructure,
          );
        throw preparationCancellation(error, input.signal);
      }
      await this.writeSandboxLog(handle.workspace, {
        error: readErrorMessage(error),
        event: "preparation-error",
      });
      await cancelActiveCommandsQuietly(handle);
      const releaseInfrastructure = await releaseInfrastructureQuietly(handle);
      const infrastructure =
        readPreparationWorkspaceInfrastructureDiagnostic(error) ??
        releaseInfrastructure;
      if (infrastructure !== undefined)
        return preparationInfrastructureFailure(infrastructure);
      return {
        assumptions: [],
        blockers: [readErrorMessage(error)],
        status: "failed" as const,
        suggestedChanges: [
          "Retry Repo Preparation in a fresh Preparation Workspace.",
        ],
      };
    }

    if (result.status !== "succeeded") {
      this.throwIfCancelled(input, deadlineAt);
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
          "Retry Repo Preparation in a fresh Preparation Workspace.",
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
          deadlineAt,
        );
      } catch (error) {
        if (isPreparationCancellation(error, input.signal)) {
          await cancelActiveCommandsQuietly(handle);
          const releaseInfrastructure =
            await releaseInfrastructureQuietly(handle);
          if (releaseInfrastructure !== undefined)
            throw preparationCancellationWithCleanup(
              error,
              input.signal,
              releaseInfrastructure,
            );
          throw preparationCancellation(error, input.signal);
        }
        await this.writeSandboxLog(handle.workspace, {
          error: readErrorMessage(error),
          event: "preparation-error",
        });
        await cancelActiveCommandsQuietly(handle);
        const releaseInfrastructure =
          await releaseInfrastructureQuietly(handle);
        const infrastructure =
          readPreparationWorkspaceInfrastructureDiagnostic(error) ??
          releaseInfrastructure;
        if (infrastructure !== undefined)
          return preparationInfrastructureFailure(infrastructure);
        return {
          assumptions: [],
          blockers: [readErrorMessage(error)],
          status: "failed" as const,
          suggestedChanges: [
            "Retry Repo Preparation in a fresh Preparation Workspace.",
          ],
        };
      }
      if (loopResult.status === "failed") {
        const releaseInfrastructure =
          await releaseInfrastructureQuietly(handle);
        if (releaseInfrastructure !== undefined)
          return preparationInfrastructureFailure(releaseInfrastructure);
      }

      return loopResult;
    }

    const setupResult = result.value.result;
    if (setupResult.status === "failed") {
      const releaseInfrastructure = await releaseInfrastructureQuietly(handle);
      if (releaseInfrastructure !== undefined)
        return preparationInfrastructureFailure(releaseInfrastructure);
    }

    return setupResult;
  }

  private async runPreparation(
    handle: PreparationWorkspaceHandle,
    input: RepoPreparationInput,
  ): Promise<PreparationSetupResult> {
    throwIfPipelineCancelled(input.signal);
    const baselineSourceControlledPaths =
      input.baselineSourceControlledPaths ??
      (await bootstrapRepoPreparationWorkspace({
        commitSha: input.commitSha,
        ...(this.cloneFailureDiagnosticsContext === undefined
          ? {}
          : {
              cloneFailureDiagnosticsContext:
                this.cloneFailureDiagnosticsContext,
            }),
        logger: this.logger,
        repoUrl: input.repoUrl,
        workspace: handle.workspace,
      }));
    throwIfPipelineCancelled(input.signal);
    if (
      !Array.isArray(baselineSourceControlledPaths) &&
      baselineSourceControlledPaths.failure !== undefined
    ) {
      return {
        result: baselineSourceControlledPaths.failure,
        status: "result",
      };
    }
    const baseline = Array.isArray(baselineSourceControlledPaths)
      ? baselineSourceControlledPaths
      : baselineSourceControlledPaths.baselineSourceControlledPaths;
    const toolchain = await inspectSubmittedCodeToolchain(
      handle.workspace,
      this.nodeReleaseCatalog,
    );
    throwIfPipelineCancelled(input.signal);
    let toolchainAdvisory: { code: string; reason: string } | undefined;
    if (toolchain.mode === "unsupported") {
      await this.writeSandboxLog(handle.workspace, {
        code: toolchain.code,
        event: "submitted-code-toolchain.unsupported",
        level: "warn",
        reason: toolchain.reason,
      });
      toolchainAdvisory = {
        code: toolchain.code,
        reason: toolchain.reason,
      };
    } else {
      handle.toolchainPlan = toolchain.plan;
      if (toolchain.plan.installBlocker !== undefined) {
        toolchainAdvisory = {
          code: toolchain.plan.installBlocker.code,
          reason: toolchain.plan.installBlocker.reason,
        };
      }
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
    }

    if (handle.workspace.prepareForAgent === undefined) {
      throw new Error(
        "Repo Preparation workspace cannot establish unprivileged agent access.",
      );
    }
    await handle.workspace.prepareForAgent();
    throwIfPipelineCancelled(input.signal);

    return {
      baselineSourceControlledPaths: baseline,
      prompt: createDaytonaRepoPreparationPrompt(input, {
        runtimeNetworkPolicy: this.runtimeNetworkPolicy,
        ...(toolchainAdvisory === undefined ? {} : { toolchainAdvisory }),
      }),
      status: "ready",
    };
  }

  private async runAgentTaskLoop(
    handle: PreparationWorkspaceHandle,
    input: RepoPreparationInput,
    initialPrompt: string,
    baselineSourceControlledPaths: string[],
    initialHardDeadlineAt: number,
  ): Promise<AgentTaskLoopResult> {
    let hardDeadlineAt = initialHardDeadlineAt;
    let prompt = initialPrompt;
    let repairLocalUrl: string | undefined;
    let agentSession: AgentSession | undefined;
    let validationRepairAttempts = 0;
    const controlState = createRepoPreparationControlState({
      baselineSourceControlledPaths,
      readManifest: () =>
        readPreparationManifestFile(handle.workspace, preparationManifestPath),
    });
    for (let attempt = 0; attempt < maximumAgentTaskTurns; attempt += 1) {
      const initialDeadlineAt = Math.min(
        Date.now() + this.timeoutMs,
        hardDeadlineAt,
      );
      let deadlineAt = initialDeadlineAt;
      if (Date.now() >= hardDeadlineAt) {
        if (input.deadlineAt === undefined) {
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
        throw new PipelineCancellationError("deadline-exceeded");
      }
      throwIfPipelineCancelled(input.signal);
      await this.writeSandboxLog(handle.workspace, {
        attempt: attempt + 1,
        event: "agent-task.started",
        remainingMs: deadlineAt - Date.now(),
      });
      let agentTaskResult: AgentTaskRunResult<RepoPreparationToolHandoff>;
      const turnHardDeadlineAt = hardDeadlineAt;
      const browserController =
        repairLocalUrl === undefined
          ? undefined
          : this.browserToolControllerProvider?.forWorkspace({
              deadlineAt: hardDeadlineAt,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              localUrl: repairLocalUrl,
              workspace: handle.workspace,
            });
      const onHardDeadlineExtended = ({
        hardDeadlineAt: extendedAt,
      }: { hardDeadlineAt: number }) => {
        hardDeadlineAt = Math.max(
          hardDeadlineAt,
          Math.min(extendedAt, input.deadlineAt ?? Number.POSITIVE_INFINITY),
        );
        browserController?.updateContext({
          deadlineAt: hardDeadlineAt,
          localUrl: repairLocalUrl ?? "",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      };
      agentTaskResult = await (async () => {
        try {
          return await this.runner.run({
            attempt: attempt + 1,
            ...(input.deadlineAt === undefined
              ? {}
              : { deadlineCeilingAt: input.deadlineAt }),
            onHardDeadlineExtended,
            hardDeadlineAt,
            hardTimeoutMs: this.hardTimeoutMs,
            inactivityLabel: "Repo Preparation agent",
            inactivityTimeoutMs: this.timeoutMs,
            ...(agentSession === undefined ? {} : { session: agentSession }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            stage: "repo-preparation",
            taskPrompt:
              browserController === undefined
                ? prompt
                : `${prompt}\n\nBrowser tools are available for the failed local preflight URL. Inspect after navigating or making major page changes before using accessibility references.`,
            tools: [
              ...createRepoPreparationStageTools(controlState),
              ...(browserController === undefined
                ? []
                : createBrowserStageTools(browserController)),
            ],
            toolProtocol: repoPreparationToolProtocol,
            workspace: createRepoPreparationAgentWorkspace(handle.workspace),
          });
        } finally {
          await resetBrowserController(browserController);
        }
      })();
      if (Date.now() >= hardDeadlineAt) {
        if (input.deadlineAt === undefined) {
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
        throw new PipelineCancellationError("deadline-exceeded");
      }
      throwIfPipelineCancelled(input.signal);
      if (hardDeadlineAt > turnHardDeadlineAt) {
        deadlineAt = Math.min(Date.now() + this.timeoutMs, hardDeadlineAt);
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
          repairLocalUrl = validationOutcome.localUrl;
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
        const dependencyDeadlineAt = Math.min(
          Date.now() + this.timeoutMs,
          hardDeadlineAt,
        );
        await this.writeSandboxLog(handle.workspace, {
          event: "dependency-install-requested",
        });
        if (dependencyDeadlineAt - Date.now() < minimumBackendToolBudgetMs) {
          return backendToolDeadlineFailure("dependency installation");
        }
        let dependencyOperationCancelled = false;
        const throwIfDependencyOperationCancelled = () => {
          if (dependencyOperationCancelled) {
            throw new Error("Dependency installation was cancelled.");
          }
          throwIfPipelineCancelled(input.signal);
        };
        const installRun = await runSettledPreparationOperation({
          operation: (async () => {
            const refreshedToolchain = await inspectSubmittedCodeToolchain(
              handle.workspace,
              this.nodeReleaseCatalog,
            );
            throwIfDependencyOperationCancelled();
            if (refreshedToolchain.mode === "unsupported") {
              return {
                code: refreshedToolchain.code,
                reason: refreshedToolchain.reason,
                status: "repair" as const,
              };
            }
            handle.toolchainPlan = refreshedToolchain.plan;
            const plannedInstall = handle.toolchainPlan;
            if (plannedInstall.install === undefined) {
              const blocker = plannedInstall.installBlocker;
              return {
                code: blocker?.code ?? "missing_immutable_install",
                reason:
                  blocker?.reason ??
                  "No catalog-owned immutable install is available.",
                status: "repair" as const,
              };
            }
            await this.writeSandboxLog(handle.workspace, {
              declaredPackageManagerIntegrity:
                plannedInstall.packageManager?.corepackHash !== undefined,
              event: "dependency-install-catalog-command-selected",
              executedArgv: plannedInstall.install.argv,
              executedExecutable: plannedInstall.install.executable,
              installProfile: "bounded",
              packageManager:
                plannedInstall.packageManager === undefined
                  ? "none"
                  : `${plannedInstall.packageManager.name}@${plannedInstall.packageManager.version}`,
            });
            throwIfDependencyOperationCancelled();
            try {
              await provisionSubmittedCodeToolchain(
                handle.workspace,
                plannedInstall,
              );
            } catch (error) {
              if (error instanceof SubmittedCodeToolchainRepairRequiredError) {
                return {
                  code: error.code,
                  reason: error.message,
                  status: "repair" as const,
                };
              }
              throw error;
            }
            throwIfDependencyOperationCancelled();
            if (repairLocalUrl !== undefined) {
              await quiesceSubmittedRuntime(handle.workspace, {
                port: readLocalRuntimePort(repairLocalUrl),
                timeoutMs: submittedRuntimeQuiescenceTimeoutMs,
              });
              repairLocalUrl = undefined;
            }
            throwIfDependencyOperationCancelled();
            await syncSubmittedCodeWorkspace(handle.workspace);
            throwIfDependencyOperationCancelled();
            return {
              result: await runPlannedDependencyInstall({
                toolchainPlan: plannedInstall,
                workspace: handle.workspace,
              }),
              status: "installed" as const,
            };
          })(),
          onCancel: () => {
            dependencyOperationCancelled = true;
            return cancelActiveCommandsQuietly(handle);
          },
          signal: input.signal,
          timeoutLabel: "Repo Preparation dependency installation",
          timeoutMs: Math.max(1, dependencyDeadlineAt - Date.now()),
        });
        if (input.deadlineAt === undefined) {
          throwIfPipelineCancelled(input.signal);
        } else {
          this.throwIfCancelled(input, hardDeadlineAt);
        }
        if (installRun.status !== "succeeded") {
          return this.timeoutPreparation(
            handle,
            installRun.reason,
            this.timeoutMetadataForDeadline(hardDeadlineAt),
          );
        }
        if (installRun.value.status === "repair") {
          await this.writeSandboxLog(handle.workspace, {
            code: installRun.value.code,
            event: "dependency-install-toolchain-repair-required",
            level: "warn",
            reason: installRun.value.reason,
          });
          if (attempt + 1 >= maximumAgentTaskTurns) {
            return {
              assumptions: [],
              blockers: [
                `Submitted code toolchain still requires repair (${installRun.value.code}): ${installRun.value.reason}`,
              ],
              status: "failed" as const,
              suggestedChanges: [
                "Repair the submitted toolchain metadata, then retry Repo Preparation.",
              ],
            };
          }
          prompt = createToolchainRepairPrompt(input, installRun.value);
          continue;
        }
        const installResult = installRun.value.result;
        const installedToolchainPlan = handle.toolchainPlan;
        if (installedToolchainPlan === undefined) {
          throw new Error(
            "Dependency installation completed without a resolved toolchain plan.",
          );
        }
        await this.writeSandboxLog(handle.workspace, {
          event: "dependency-install-finished",
          exitCode: installResult.exitCode,
          stderrLength: installResult.stderr.length,
          stdoutLength: installResult.stdout.length,
        });
        const installFailure = classifyDependencyInstallFailure({
          plan: installedToolchainPlan,
          result: installResult,
        });
        if (installFailure !== undefined) {
          await this.writeSandboxLog(handle.workspace, {
            ...installFailure,
            event: "dependency-install.repository-node-incompatible",
            level: "error",
          });
          return {
            assumptions: [],
            blockers: [
              "A repository dependency rejects the selected catalog Node runtime.",
            ],
            failureKind: installFailure.failureKind,
            status: "failed" as const,
            suggestedChanges: [
              "Align the repository's Node engine constraints and dependency versions, then retry Repo Preparation.",
            ],
          };
        }
        if (installResult.exitCode === 137) {
          const failureKind = "dependency-install-sigkill" as const;
          const resourceDiagnostics = installResult.resourceDiagnostics;
          await this.writeSandboxLog(handle.workspace, {
            event: failureKind,
            exitCode: installResult.exitCode,
            failureKind,
            interpretation: describeDependencyInstallSigkill(
              resourceDiagnostics,
              "agent",
            ),
            ...(resourceDiagnostics === undefined
              ? {}
              : { resourceDiagnostics }),
            level: "error",
            stderrTail: boundUtf8Tail(
              installResult.stderr,
              dependencyInstallDiagnosticMaxBytes,
            ),
            stdoutTail: boundUtf8Tail(
              installResult.stdout,
              dependencyInstallDiagnosticMaxBytes,
            ),
          });
          return {
            assumptions: [],
            blockers: [
              `Dependency installation ended with SIGKILL (exit 137); ${describeDependencyInstallSigkill(resourceDiagnostics, "agent").replace(/^SIGKILL observed; /, "")}`,
            ],
            failureKind,
            ...(resourceDiagnostics === undefined
              ? {}
              : { resourceDiagnostics }),
            status: "failed" as const,
            suggestedChanges: [
              "Inspect provider metrics and sandbox logs to identify the SIGKILL source before choosing a recovery, then retry Repo Preparation.",
            ],
          };
        }
        if (attempt + 1 >= maximumAgentTaskTurns) {
          return {
            assumptions: [],
            blockers: [
              "Repo Preparation reached its total agent-task turn limit after dependency installation.",
            ],
            status: "failed" as const,
            suggestedChanges: [
              "Retry Repo Preparation in a fresh Preparation Workspace.",
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
        const runtimePreflight =
          controlState.readValidation()?.runtimePreflight;
        if (
          preparationResult.status === "succeeded" &&
          runtimePreflight?.status === "succeeded"
        ) {
          return {
            ...preparationResult,
            ...(agentSession === undefined ? {} : { agentSession }),
            baselineSourceControlledPaths,
            runtimePreflight,
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
        "Retry Repo Preparation in a fresh Preparation Workspace.",
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
    | { localUrl?: string; prompt: string; status: "retry" }
    | { reason: string; status: "timeout" }
    | {
        result: Awaited<ReturnType<RepoPreparationAgent["prepare"]>>;
        status: "done";
      }
  > {
    this.throwIfCancelled(
      input.input,
      input.input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
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
    if (this.runRuntimePreflight === undefined) {
      throw new Error("Repo Preparation validation tool is not configured.");
    }
    const runRuntimePreflight = this.runRuntimePreflight;
    let manifest: ReturnType<typeof readPreparationManifest> | undefined;
    let runtimePreflight: RepoPreparationPreflightResult;
    try {
      const validationRun = await runSettledPreparationOperation({
        operation: (async () => {
          manifest = await readPreparationManifestFile(
            input.handle.workspace,
            input.validationRequest.manifestPath,
          );
          validateNativeVisibleInterfaceProvenance(
            manifest,
            input.baselineSourceControlledPaths,
          );
          return await runRuntimePreflight({
            manifest,
            workspace: input.handle,
          });
        })(),
        onCancel: () => cancelActiveCommandsQuietly(input.handle),
        signal: input.input.signal,
        timeoutMs: Math.max(1, input.deadlineAt - Date.now()),
      });
      this.throwIfCancelled(
        input.input,
        input.input.deadlineAt ?? Number.POSITIVE_INFINITY,
      );
      if (validationRun.status !== "succeeded") {
        return { reason: validationRun.reason, status: "timeout" };
      }
      runtimePreflight = validationRun.value;
    } catch (error) {
      if (isPreparationCancellation(error, input.input.signal)) {
        throw preparationCancellation(error, input.input.signal);
      }
      runtimePreflight = createRuntimePreflightHandoffFailure(
        readErrorMessage(error),
      );
    }
    await this.writeSandboxLog(input.handle.workspace, {
      failureReason: runtimePreflight.failureReason,
      event: "preparation-preflight.finished",
      level: runtimePreflight.status === "failed" ? "warn" : "info",
      status: runtimePreflight.status,
    });
    input.controlState.recordValidation({ manifest, runtimePreflight });
    if (isPipelineInfrastructureFailureKind(runtimePreflight.failureKind)) {
      const failureReason = `Preparation preflight failed with a non-retryable MakeADemo infrastructure failure: ${runtimePreflight.failureReason ?? runtimePreflight.failureKind}`;
      await this.writeSandboxLog(input.handle.workspace, {
        event: "preparation-preflight.non-retryable-failure",
        failureReason,
      });
      return {
        result: {
          assumptions: [],
          blockers: [failureReason],
          failureKind: runtimePreflight.failureKind,
          ...(runtimePreflight.resourceDiagnostics === undefined
            ? {}
            : {
                resourceDiagnostics: runtimePreflight.resourceDiagnostics,
              }),
          runtimePreflight,
          status: "failed" as const,
          suggestedChanges: [
            "Report this MakeADemo infrastructure failure instead of asking the app preparation agent to repair the submitted repo.",
          ],
        },
        status: "done",
      };
    }
    if (runtimePreflight.status === "succeeded" && manifest !== undefined) {
      await this.writeSandboxLog(input.handle.workspace, {
        event: "preparation-auto-succeeded-after-preflight",
        status: runtimePreflight.status,
      });
      return {
        result: {
          baselineSourceControlledPaths: input.baselineSourceControlledPaths,
          manifest,
          ...(input.agentSession === undefined
            ? {}
            : { agentSession: input.agentSession }),
          status: "succeeded" as const,
          runtimePreflight,
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
        result: runtimePreflightRepairExhaustedFailure(runtimePreflight),
        status: "done",
      };
    }
    await writeRepoPreparationRetryLog(this.logger, input.handle.workspace, {
      nextAttempt: input.attempt + 2,
      reason: readRetryReason(runtimePreflight.failureReason),
    });
    const localUrl = runtimePreflight.localUrl ?? manifest?.url;
    return {
      ...(localUrl === undefined ? {} : { localUrl }),
      prompt: createValidationFeedbackPrompt({
        manifest,
        manifestPath: input.validationRequest.manifestPath,
        remainingBudgetMs: Math.max(0, input.deadlineAt - Date.now()),
        runtimePreflight,
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

  private throwIfCancelled(input: RepoPreparationInput, deadlineAt: number) {
    throwIfPipelineCancelled(input.signal);
    if (Date.now() >= deadlineAt) {
      throw new PipelineCancellationError("deadline-exceeded");
    }
  }
}

async function resetBrowserController(
  controller:
    | ReturnType<BrowserToolControllerProvider["forWorkspace"]>
    | undefined,
): Promise<void> {
  try {
    await controller?.reset();
  } catch {
    // Browser cleanup is best effort and must not replace Repo Preparation.
  }
}

type AgentTaskLoopResult = RepoPreparationResult;

type RepoPreparationResult = Awaited<
  ReturnType<RepoPreparationAgent["prepare"]>
>;

function boundUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] ?? 0) >> 6 === 2) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

function readLocalRuntimePort(localUrl: string): number {
  const url = new URL(localUrl);
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

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

function waitForPreparationOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let cancellationStarted = false;
    const abort = () => {
      cancellationStarted = true;
      void operation.then(
        () => reject(preparationCancellation(undefined, signal)),
        (error: unknown) => {
          const infrastructure =
            readPreparationWorkspaceInfrastructureDiagnostic(error);
          reject(
            infrastructure === undefined
              ? preparationCancellation(undefined, signal)
              : preparationCancellationWithCleanup(
                  error,
                  signal,
                  infrastructure,
                ),
          );
        },
      );
    };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal?.removeEventListener("abort", abort);
        if (!cancellationStarted) resolve(value);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        if (!cancellationStarted) reject(error);
      },
    );
  });
}

function runSettledPreparationOperation<T>(input: {
  onCancel: () => Promise<void>;
  operation: Promise<T>;
  signal: AbortSignal | undefined;
  timeoutLabel?: string;
  timeoutMs: number;
}): Promise<TimedRunResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancellationStarted = false;
    let operationSettled = false;
    let resolveOperationSettlement: (() => void) | undefined;
    const operationSettlement = new Promise<void>((resolve) => {
      resolveOperationSettlement = resolve;
    });
    const finishCancellation = async (kind: "signal" | "timeout") => {
      if (cancellationStarted || settled) return;
      cancellationStarted = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      while (!operationSettled) {
        await input.onCancel().catch(() => undefined);
        if (operationSettled) break;
        await Promise.race([
          operationSettlement,
          waitForPreparationCancellationCadence(),
        ]);
      }
      await input.operation.catch(() => undefined);
      settled = true;
      if (kind === "signal") {
        reject(preparationCancellation(undefined, input.signal));
      } else {
        resolve({
          reason: `${input.timeoutLabel ?? "Repo Preparation agent"} timed out after ${input.timeoutMs}ms.`,
          status: "timed-out",
        });
      }
    };
    const abort = () => void finishCancellation("signal");
    const timeout = setTimeout(
      () => void finishCancellation("timeout"),
      input.timeoutMs,
    );
    if (input.signal?.aborted === true) {
      abort();
    } else {
      input.signal?.addEventListener("abort", abort, { once: true });
    }
    input.operation.then(
      (value) => {
        operationSettled = true;
        resolveOperationSettlement?.();
        if (cancellationStarted || settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
        resolve({ status: "succeeded", value });
      },
      (error: unknown) => {
        operationSettled = true;
        resolveOperationSettlement?.();
        if (cancellationStarted || settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function waitForPreparationCancellationCadence(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function createPreparationBudget(input: RepoPreparationInput): {
  dispose: () => void;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(preparationCancellation(undefined, input.signal));
  input.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (input.signal?.aborted === true) abortFromParent();
  const timeout =
    input.deadlineAt === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new PipelineCancellationError("deadline-exceeded"),
            ),
          Math.max(0, input.deadlineAt - Date.now()),
        );
  return {
    dispose() {
      if (timeout !== undefined) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
  };
}

function isPreparationCancellation(
  error: unknown,
  signal: AbortSignal | undefined,
) {
  return error instanceof PipelineCancellationError || signal?.aborted === true;
}

function preparationCancellation(
  error: unknown,
  signal: AbortSignal | undefined,
): PipelineCancellationError {
  if (error instanceof PipelineCancellationError) return error;
  return (
    pipelineCancellationFromSignal(signal) ??
    new PipelineCancellationError("signal")
  );
}

function preparationCancellationWithCleanup(
  error: unknown,
  signal: AbortSignal | undefined,
  infrastructure: PreparationWorkspaceInfrastructureDiagnostic,
): PipelineCancellationError {
  return new PipelineCancellationError(
    preparationCancellation(error, signal).reason,
    {
      preparationWorkspaceInfrastructureDiagnostic: infrastructure,
    },
  );
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

async function releaseInfrastructureQuietly(
  handle: PreparationWorkspaceHandle,
): Promise<PreparationWorkspaceInfrastructureDiagnostic | undefined> {
  try {
    await handle.release();
    return undefined;
  } catch (error) {
    return readPreparationWorkspaceInfrastructureDiagnostic(error);
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

function runtimePreflightRepairExhaustedFailure(
  runtimePreflight: RepoPreparationPreflightResult,
): RepoPreparationResult {
  const failureReason = readRetryReason(runtimePreflight.failureReason);
  return {
    assumptions: [],
    blockers: [failureReason],
    status: "failed",
    suggestedChanges:
      runtimePreflight.warnings.length === 0
        ? [
            "Repair the reported validation failure before retrying Repo Preparation.",
          ]
        : runtimePreflight.warnings,
    runtimePreflight,
  };
}

function preparationInfrastructureFailure(
  infrastructure: PreparationWorkspaceInfrastructureDiagnostic,
): RepoPreparationResult {
  return {
    assumptions: [],
    blockers: [
      "Repo Preparation could not complete because sandbox infrastructure was unavailable.",
      `Preparation Workspace infrastructure failed during ${infrastructure.phase.replaceAll("-", " ")}.`,
    ],
    failureKind: "sandbox-infrastructure-failed",
    infrastructure,
    status: "failed",
    suggestedChanges: [
      "Retry Repo Preparation later. Report this MakeADemo infrastructure failure if it repeats.",
    ],
  };
}

function backendToolDeadlineFailure(toolName: string) {
  return {
    assumptions: [],
    blockers: [
      `Repo Preparation ran out of time before ${toolName} could start.`,
    ],
    status: "failed" as const,
    suggestedChanges: [
      "Retry Repo Preparation with a fresh Preparation Workspace or a longer preparation timeout.",
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
      "Retry Repo Preparation in a fresh Preparation Workspace; report this MakeADemo tool protocol failure if it repeats.",
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

function agentTaskFailureResult(
  message = "Agent task failed.",
): RepoPreparationResult {
  return {
    assumptions: [],
    blockers: [message],
    status: "failed",
    suggestedChanges: [
      "Retry Repo Preparation in a fresh Preparation Workspace; report this MakeADemo agent failure if it repeats.",
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

function createRuntimePreflightHandoffFailure(
  reason: string,
): RepoPreparationPreflightResult {
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
