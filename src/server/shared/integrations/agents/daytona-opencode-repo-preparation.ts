import { runDependencyInstallWithNetworkWindow } from "../../../pipeline/03-repo-preparation/dependency-install-network-window";
import {
  type readPreparationManifest,
  validateNativeVisibleInterfaceProvenance,
} from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import type {
  RepoPreparationAgent,
  RepoPreparationInput,
} from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import type { ProjectValidationResult } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/validation-result";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../logging/pipeline-event-logger";
import { writeDaytonaOpenCodeActivityLog } from "./daytona-opencode-activity-log";
import {
  type MakeADemoOpenCodeToolName,
  type MakeADemoOpenCodeToolPayload,
  createMakeADemoOpenCodeProtocolTracker,
  parseOpenCodeJsonPayload,
  readOpenCodeProtocolResult,
  tryParseJson,
} from "./makeademo-opencode-tool-protocol";
import {
  type MeaningfulActivity,
  type MeaningfulActivityKind,
  MeaningfulActivityTimeoutError,
  type MeaningfulActivityTracker,
  createMeaningfulActivityTracker,
  runWithMeaningfulActivityTimeout,
} from "./opencode-meaningful-activity-timeout";
import {
  type DependencyInstallRequest,
  type ValidationRequest,
  clearDependencyInstallRequest,
  clearValidationRequest,
  dependencyInstallRequestPath,
  makeADemoArtifactDirectory,
  parseOpenCodeJsonResult,
  preparationManifestPath,
  readDependencyInstallRequest,
  readPreparationManifestFile,
  readPreparationResult,
  readPreparationResultOrParseStdout,
  readValidationRequest,
  readValidationResult,
  writeValidationResult,
} from "./repo-preparation-artifact-handoff";
import {
  createContinueRepoPreparationPrompt,
  createDaytonaRepoPreparationPrompt,
  createDependencyInstallFailurePrompt,
  createValidationFeedbackPrompt,
} from "./repo-preparation-prompt-policy";
import {
  type RepoPreparationCloneDiagnosticsContext,
  bootstrapRepoPreparationWorkspace,
  createRepoPreparationOpenCodeCommand,
  createRepoPreparationOpenCodeEnv,
} from "./repo-preparation-workspace-bootstrap";

const minimumBackendToolBudgetMs = 100;
const cloneFailureOutputMaxLength = 1_500;
const cloneFailureOutputChannelMaxLength = 750;
const cloneFailureDiagnosticValueMaxLength = 500;
const requestArtifactReadMaxTimeoutMs = 5_000;
const requestArtifactReadMinTimeoutMs = 50;
const defaultInactivityTimeoutMs = 600_000;
const defaultHardTimeoutMs = 1_800_000;
const openCodeHardCapGraceMs = 30_000;
export type DaytonaOpenCodeRepoPreparationOptions = {
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
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  provider: PreparationWorkspaceProvider;
  providerID: string;
  timeoutMs?: number;
  /** Overall post-setup Repo Preparation/OpenCode loop cap. */
  hardTimeoutMs?: number;
  validatePreparation?: (input: {
    manifest: ReturnType<typeof readPreparationManifest>;
    workspace: PreparationWorkspaceHandle;
  }) => Promise<ProjectValidationResult>;
};

export class DaytonaOpenCodeRepoPreparation implements RepoPreparationAgent {
  private readonly cloneFailureDiagnosticsContext:
    | RepoPreparationCloneDiagnosticsContext
    | undefined;
  private readonly logger: PipelineEventLogger;
  private readonly modelID: string;
  private readonly onStderr: ((chunk: string) => void) | undefined;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly provider: PreparationWorkspaceProvider;
  private readonly providerID: string;
  private readonly timeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly validatePreparation:
    | ((input: {
        manifest: ReturnType<typeof readPreparationManifest>;
        workspace: PreparationWorkspaceHandle;
      }) => Promise<ProjectValidationResult>)
    | undefined;

  constructor(options: DaytonaOpenCodeRepoPreparationOptions) {
    this.cloneFailureDiagnosticsContext =
      options.cloneFailureDiagnosticsContext;
    this.logger = options.logger ?? createRepoPreparationLogger();
    this.modelID = options.modelID;
    this.onStderr = options.onStderr;
    this.onStdout = options.onStdout;
    this.provider = options.provider;
    this.providerID = options.providerID;
    this.timeoutMs = options.timeoutMs ?? defaultInactivityTimeoutMs;
    this.hardTimeoutMs = options.hardTimeoutMs ?? defaultHardTimeoutMs;
    this.validatePreparation = options.validatePreparation;
  }

  async prepare(input: RepoPreparationInput): Promise<RepoPreparationResult> {
    const firstRun = await this.prepareOnce(input);
    if (!isProviderSecretReferenceAuthFailure(firstRun)) {
      return firstRun;
    }

    const retryRun = await this.prepareOnce(input);
    return isProviderSecretReferenceAuthFailure(retryRun)
      ? providerSecretReferenceAuthFailureResult()
      : retryRun;
  }

  private async prepareOnce(
    input: RepoPreparationInput,
  ): Promise<RepoPreparationResult | ProviderSecretReferenceAuthFailure> {
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
      let loopResult: OpenCodeLoopResult;
      try {
        loopResult = await this.runOpenCodeLoop(
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
      if (isProviderSecretReferenceAuthFailure(loopResult)) {
        await cancelActiveCommandsQuietly(handle);
        await releaseQuietly(handle);
        return loopResult;
      }
      const parsedResult = parseCommandResult(
        loopResult,
        handle,
        result.value.baselineSourceControlledPaths,
      );
      if (parsedResult.status === "failed") {
        await releaseQuietly(handle);
      }

      return parsedResult;
    }

    const parsedResult = parseCommandResult(result.value.result, handle);
    if (parsedResult.status === "failed") {
      await releaseQuietly(handle);
    }

    return parsedResult;
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

    return {
      baselineSourceControlledPaths:
        bootstrap.baselineSourceControlledPaths ?? [],
      prompt: createDaytonaRepoPreparationPrompt(input),
      status: "ready",
    };
  }

  private async runOpenCodeLoop(
    handle: PreparationWorkspaceHandle,
    input: RepoPreparationInput,
    initialPrompt: string,
    baselineSourceControlledPaths: string[],
  ): Promise<OpenCodeLoopResult> {
    let prompt = initialPrompt;
    let currentSessionID: string | undefined;
    const hardDeadlineAt = Date.now() + this.hardTimeoutMs;
    for (let attempt = 0; attempt < 8; attempt += 1) {
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
        event: "opencode-started",
        remainingMs: deadlineAt - Date.now(),
      });
      const activity = createMeaningfulActivityTracker();
      let openCodeResult: Awaited<ReturnType<typeof this.executeOpenCode>>;
      try {
        openCodeResult = await runWithMeaningfulActivityTimeout(
          () =>
            this.executeOpenCode(handle, {
              attempt: attempt + 1,
              model: `${this.providerID}/${this.modelID}`,
              prompt,
              providerID: this.providerID,
              hardDeadlineAt,
              activity,
              ...(currentSessionID === undefined
                ? {}
                : { sessionID: currentSessionID }),
            }),
          {
            activity,
            hardDeadlineAt,
            hardTimeoutMs: this.hardTimeoutMs,
            inactivityLabel: "Repo Preparation agent",
            inactivityTimeoutMs: this.timeoutMs,
            label: "Repo Preparation",
            onTimeout: () => handle.workspace.cancelActiveCommands?.(),
          },
        );
      } catch (error) {
        if (!(error instanceof MeaningfulActivityTimeoutError)) {
          throw error;
        }
        const last = error.lastMeaningfulActivity;
        return this.timeoutPreparation(handle, error.message, {
          hardTimeoutMs: this.hardTimeoutMs,
          inactivityTimeoutMs: this.timeoutMs,
          ...(last === undefined ? {} : { lastMeaningfulActivity: last }),
          ...(last === undefined
            ? {}
            : {
                lastMeaningfulActivityAt: last.at,
                lastMeaningfulActivityKind: last.kind,
              }),
          ...(last?.tool === undefined
            ? {}
            : { lastMeaningfulActivityTool: last.tool }),
          timeoutKind: error.timeoutKind,
        });
      }
      if (Date.now() > initialDeadlineAt && activity.read() !== undefined) {
        deadlineAt = Math.min(Date.now() + this.timeoutMs, hardDeadlineAt);
      }
      currentSessionID = openCodeResult.sessionID ?? currentSessionID;
      await this.writeSandboxLog(handle.workspace, {
        attempt: attempt + 1,
        event: "opencode-finished",
        exitCode: openCodeResult.exitCode,
        sessionID: currentSessionID,
        stderrLength: openCodeResult.stderr.length,
        stdoutLength: openCodeResult.stdout.length,
      });

      const shouldReadValidationFirst =
        openCodeResult.latestMakeADemoToolPayload?.toolName ===
          "makeademo_validate_preparation" ||
        openCodeResult.latestMakeADemoTool === "makeademo_validate_preparation";
      if (shouldReadValidationFirst) {
        if (openCodeResult.latestMakeADemoToolPayloadError !== undefined) {
          return toolPayloadProtocolFailure(
            openCodeResult.latestMakeADemoToolPayloadError,
          );
        }
        const validationRequest =
          openCodeResult.latestMakeADemoToolPayload?.toolName ===
          "makeademo_validate_preparation"
            ? openCodeResult.latestMakeADemoToolPayload.input
            : undefined;
        if (validationRequest !== undefined) {
          const validationOutcome = await this.processValidationRequest({
            attempt,
            currentSessionID,
            deadlineAt,
            handle,
            input,
            baselineSourceControlledPaths,
            validationRequest,
          });
          if (validationOutcome.status === "retry") {
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

        const validationRequestResult =
          await this.readRequestArtifactWithDeadline({
            artifactName: "validation request",
            deadlineAt,
            eventPrefix: "validation-request-read",
            read: () => readValidationRequest(handle.workspace),
            workspace: handle.workspace,
          });
        if (validationRequestResult.status !== "succeeded") {
          return requestArtifactReadTimeoutFailure(
            "validation request",
            validationRequestResult.timeoutMs,
          );
        }
        if (validationRequestResult.value !== undefined) {
          const validationOutcome = await this.processValidationRequest({
            attempt,
            currentSessionID,
            deadlineAt,
            handle,
            input,
            baselineSourceControlledPaths,
            validationRequest: validationRequestResult.value,
          });
          if (validationOutcome.status === "retry") {
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
      }

      if (openCodeResult.latestMakeADemoToolPayloadError !== undefined) {
        return toolPayloadProtocolFailure(
          openCodeResult.latestMakeADemoToolPayloadError,
        );
      }

      const dependencyInstallRequest =
        openCodeResult.latestMakeADemoToolPayload?.toolName ===
          "makeademo_dependency_request_install" ||
        openCodeResult.latestMakeADemoToolPayload?.toolName ===
          "makeademo_install_dependencies"
          ? openCodeResult.latestMakeADemoToolPayload.input
          : await this.readDependencyInstallRequestWithDeadline(
              handle.workspace,
              deadlineAt,
            );
      if (
        typeof dependencyInstallRequest === "object" &&
        dependencyInstallRequest !== null &&
        "status" in dependencyInstallRequest &&
        dependencyInstallRequest.status === "timed-out"
      ) {
        return requestArtifactReadTimeoutFailure(
          "dependency install request",
          dependencyInstallRequest.timeoutMs,
        );
      }
      const dependencyRequest = dependencyInstallRequest as
        | DependencyInstallRequest
        | undefined;
      if (dependencyRequest !== undefined) {
        await this.writeSandboxLog(handle.workspace, {
          command: dependencyRequest.command,
          event: "dependency-install-requested",
        });
        if (deadlineAt - Date.now() < minimumBackendToolBudgetMs) {
          return backendToolDeadlineFailure("dependency installation");
        }
        const installRun = await raceWithTimeout(
          runDependencyInstallWithNetworkWindow({
            command: dependencyRequest.command,
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
        const clearDependencyInstallRequestRun = await raceWithTimeout(
          clearDependencyInstallRequest(handle.workspace),
          Math.max(1, deadlineAt - Date.now()),
        );
        if (clearDependencyInstallRequestRun.status !== "succeeded") {
          return this.timeoutPreparation(
            handle,
            clearDependencyInstallRequestRun.reason,
          );
        }
        await this.writeSandboxLog(handle.workspace, {
          event: "dependency-install-finished",
          exitCode: installResult.exitCode,
          stderrLength: installResult.stderr.length,
          stdoutLength: installResult.stdout.length,
        });
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

      const validationRequestResult =
        await this.readRequestArtifactWithDeadline({
          artifactName: "validation request",
          deadlineAt,
          eventPrefix: "validation-request-read",
          read: () => readValidationRequest(handle.workspace),
          workspace: handle.workspace,
        });
      if (validationRequestResult.status !== "succeeded") {
        return requestArtifactReadTimeoutFailure(
          "validation request",
          validationRequestResult.timeoutMs,
        );
      }
      const validationRequest = validationRequestResult.value;
      if (validationRequest !== undefined) {
        const validationOutcome = await this.processValidationRequest({
          attempt,
          currentSessionID,
          deadlineAt,
          handle,
          input,
          baselineSourceControlledPaths,
          validationRequest,
        });
        if (validationOutcome.status === "retry") {
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

      const preparationResultRead = await this.readRequestArtifactWithDeadline({
        artifactName: "preparation result",
        deadlineAt,
        eventPrefix: "preparation-result-read",
        read: () => readPreparationResult(handle.workspace),
        workspace: handle.workspace,
      });
      if (preparationResultRead.status !== "succeeded") {
        return requestArtifactReadTimeoutFailure(
          "preparation result",
          preparationResultRead.timeoutMs,
        );
      }
      const preparationResult = preparationResultRead.value;
      if (preparationResult !== undefined) {
        await this.writeSandboxLog(handle.workspace, {
          event: "preparation-result-found",
          status: preparationResult.status,
        });
        const validationResultRead = await this.readRequestArtifactWithDeadline(
          {
            artifactName: "validation result",
            deadlineAt,
            eventPrefix: "validation-result-read",
            read: () => readValidationResult(handle.workspace),
            workspace: handle.workspace,
          },
        );
        if (validationResultRead.status !== "succeeded") {
          return requestArtifactReadTimeoutFailure(
            "validation result",
            validationResultRead.timeoutMs,
          );
        }
        const validation = validationResultRead.value;
        if (
          preparationResult.status === "succeeded" &&
          validation?.status === "succeeded"
        ) {
          return {
            ...preparationResult,
            ...(currentSessionID === undefined
              ? {}
              : { opencodeSessionID: currentSessionID }),
            validation,
          };
        }

        return preparationResult;
      }

      const providerAuthFailure = readProviderAuthFailure(openCodeResult);
      if (providerAuthFailure !== undefined) {
        return isProviderSecretReferenceAuthFailure(providerAuthFailure) &&
          attempt > 0
          ? providerSecretReferenceAuthFailureResult()
          : providerAuthFailure;
      }

      return parseOpenCodeJsonResult(openCodeResult.stdout);
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
  ): Promise<RawPreparationRunResult> {
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

  private async executeOpenCode(
    handle: PreparationWorkspaceHandle,
    input: {
      attempt: number;
      model: string;
      prompt: string;
      providerID: string;
      sessionID?: string;
      hardDeadlineAt: number;
      activity: MeaningfulActivityTracker;
    },
  ): Promise<
    PreparationWorkspaceCommandResult & {
      latestMakeADemoTool?: MakeADemoOpenCodeToolName;
      latestMakeADemoToolPayloadError?: string;
      latestMakeADemoToolPayload?: MakeADemoOpenCodeToolPayload;
      sessionID?: string;
    }
  > {
    const protocol = createMakeADemoOpenCodeProtocolTracker();
    let interruptionRequested = false;
    const requestInterruption = () => {
      if (interruptionRequested) {
        return;
      }
      const completedPayload = protocol.readCompletedPayload();
      if (completedPayload === undefined) {
        return;
      }

      interruptionRequested = true;
      void writePreparationSandboxLog(this.logger, handle.workspace, {
        attempt: input.attempt,
        event: "opencode-interruption.started",
        toolName: completedPayload.toolName,
      });
      let cancellation: Promise<void>;
      try {
        cancellation = Promise.resolve(
          handle.workspace.cancelActiveCommands?.(),
        ).then(() => undefined);
      } catch (error) {
        cancellation = Promise.reject(error);
      }
      void cancellation
        .then(() =>
          writePreparationSandboxLog(this.logger, handle.workspace, {
            attempt: input.attempt,
            event: "opencode-interruption.succeeded",
            toolName: completedPayload.toolName,
          }),
        )
        .catch((error: unknown) =>
          writePreparationSandboxLog(this.logger, handle.workspace, {
            attempt: input.attempt,
            error: readErrorMessage(error),
            event: "opencode-interruption.failed",
            toolName: completedPayload.toolName,
          }),
        )
        .catch(() => {
          // Interruption logging is best effort and must not affect preparation.
        });
    };
    const onStdout = (chunk: string) => {
      input.activity.write("stdout", chunk);
      protocol.write(chunk);
      requestInterruption();
      this.onStdout?.(chunk);
      void writeDaytonaOpenCodeActivityLog(handle.workspace, {
        attempt: input.attempt,
        channel: "stdout",
        raw: chunk,
        stage: "repo-preparation",
      });
    };
    const onStderr = (chunk: string) => {
      input.activity.write("stderr", chunk);
      protocol.write(chunk);
      requestInterruption();
      this.onStderr?.(chunk);
      void writeDaytonaOpenCodeActivityLog(handle.workspace, {
        attempt: input.attempt,
        channel: "stderr",
        raw: chunk,
        stage: "repo-preparation",
      });
    };
    const options = {
      env: createRepoPreparationOpenCodeEnv(),
      onStderr,
      onStdout,
      timeoutMs: Math.max(
        1,
        input.hardDeadlineAt - Date.now() + openCodeHardCapGraceMs,
      ),
    };

    const result = await handle.workspace.execute(
      createRepoPreparationOpenCodeCommand(input),
      options,
    );

    const finalProtocol = readOpenCodeProtocolResult(
      `${result.stdout}\n${result.stderr}`,
    );
    const sessionID = protocol.readSessionID() ?? finalProtocol.sessionID;
    const latestMakeADemoTool = protocol.readTool() ?? finalProtocol.tool;
    const latestMakeADemoToolPayload =
      protocol.readPayload() ?? finalProtocol.payload;
    const latestMakeADemoToolPayloadError =
      protocol.readPayloadError() ?? finalProtocol.payloadError;
    return {
      ...result,
      ...(latestMakeADemoTool === undefined ? {} : { latestMakeADemoTool }),
      ...(latestMakeADemoToolPayloadError === undefined
        ? {}
        : { latestMakeADemoToolPayloadError }),
      ...(latestMakeADemoToolPayload === undefined
        ? {}
        : { latestMakeADemoToolPayload }),
      ...(sessionID === undefined ? {} : { sessionID }),
    };
  }

  private async processValidationRequest(input: {
    attempt: number;
    baselineSourceControlledPaths: string[];
    currentSessionID: string | undefined;
    deadlineAt: number;
    handle: PreparationWorkspaceHandle;
    input: RepoPreparationInput;
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
      status: validation.status,
    });
    const writeValidationResultRun = await raceWithTimeout(
      writeValidationResult(input.handle.workspace, {
        manifest,
        validation,
      }),
      Math.max(1, input.deadlineAt - Date.now()),
    );
    if (writeValidationResultRun.status !== "succeeded") {
      return { reason: writeValidationResultRun.reason, status: "timeout" };
    }
    const clearValidationRequestRun = await raceWithTimeout(
      clearValidationRequest(input.handle.workspace),
      Math.max(1, input.deadlineAt - Date.now()),
    );
    if (clearValidationRequestRun.status !== "succeeded") {
      return { reason: clearValidationRequestRun.reason, status: "timeout" };
    }
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
          ...(input.currentSessionID === undefined
            ? {}
            : { opencodeSessionID: input.currentSessionID }),
          status: "succeeded" as const,
          validation,
          workspace: input.handle,
        },
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

  private async readRequestArtifactWithDeadline<T>(input: {
    artifactName: string;
    deadlineAt: number;
    eventPrefix: string;
    read: () => Promise<T>;
    workspace: PreparationWorkspace;
  }): Promise<
    | { status: "succeeded"; value: T }
    | { status: "timed-out"; timeoutMs: number }
  > {
    const timeoutMs = deriveRequestArtifactReadTimeoutMs(input.deadlineAt);
    await this.writeSandboxLog(input.workspace, {
      artifactName: input.artifactName,
      event: `${input.eventPrefix}.started`,
      remainingMs: input.deadlineAt - Date.now(),
      timeoutMs,
    });

    const result = await raceWithTimeout(input.read(), timeoutMs);
    if (result.status !== "succeeded") {
      await this.writeSandboxLog(input.workspace, {
        artifactName: input.artifactName,
        event: `${input.eventPrefix}.timeout`,
        reason: result.reason,
        remainingMs: input.deadlineAt - Date.now(),
        timeoutMs,
      });
      return { status: "timed-out", timeoutMs };
    }

    await this.writeSandboxLog(input.workspace, {
      artifactName: input.artifactName,
      event: `${input.eventPrefix}.finished`,
      found: result.value !== undefined,
      remainingMs: input.deadlineAt - Date.now(),
      timeoutMs,
    });
    return { status: "succeeded", value: result.value };
  }

  private async readDependencyInstallRequestWithDeadline(
    workspace: PreparationWorkspace,
    deadlineAt: number,
  ): Promise<
    | DependencyInstallRequest
    | undefined
    | { status: "timed-out"; timeoutMs: number }
  > {
    const dependencyInstallRequestResult =
      await this.readRequestArtifactWithDeadline({
        artifactName: "dependency install request",
        deadlineAt,
        eventPrefix: "dependency-install-request-read",
        read: () => readDependencyInstallRequest(workspace),
        workspace,
      });
    if (dependencyInstallRequestResult.status !== "succeeded") {
      return {
        status: "timed-out",
        timeoutMs: dependencyInstallRequestResult.timeoutMs,
      };
    }

    return dependencyInstallRequestResult.value;
  }
}

function parseCommandResult(
  result: RawPreparationRunResult,
  workspace: PreparationWorkspaceHandle,
  baselineSourceControlledPaths?: string[],
) {
  if (!("exitCode" in result)) {
    return result.status === "succeeded"
      ? {
          ...result,
          baselineSourceControlledPaths: baselineSourceControlledPaths ?? [],
          workspace,
        }
      : result;
  }

  if (result.exitCode !== 0) {
    return {
      assumptions: [],
      blockers: [
        `OpenCode exited with ${result.exitCode}: ${[result.stderr, result.stdout].filter((line) => line.length > 0).join("\n")}`,
      ],
      status: "failed" as const,
      suggestedChanges: [
        "Retry Repo Preparation after fixing the OpenCode run failure.",
      ],
    };
  }

  const parsedResult = parseOpenCodeJsonResult(result.stdout);
  if (parsedResult.status === "failed") {
    return parsedResult;
  }

  return {
    ...parsedResult,
    baselineSourceControlledPaths: baselineSourceControlledPaths ?? [],
    workspace,
  };
}

type RawPreparationRunResult =
  | PreparationWorkspaceCommandResult
  | RepoPreparationResult;

type OpenCodeLoopResult =
  | RawPreparationRunResult
  | ProviderSecretReferenceAuthFailure;

type RepoPreparationResult = Awaited<
  ReturnType<RepoPreparationAgent["prepare"]>
>;

type ProviderSecretReferenceAuthFailure = {
  blocker: string;
  status: "provider-secret-reference-auth-failed";
};

type TimedRunResult<T> =
  | { status: "succeeded"; value: T }
  | ({ reason: string; status: "failed" | "timed-out" } & TimeoutMetadata);

type TimeoutMetadata = {
  timeoutKind?: "inactivity" | "hard-cap";
  inactivityTimeoutMs?: number;
  hardTimeoutMs?: number;
  lastMeaningfulActivity?: MeaningfulActivity;
  lastMeaningfulActivityAt?: number;
  lastMeaningfulActivityKind?: MeaningfulActivityKind;
  lastMeaningfulActivityTool?: string;
};

type PreparationSetupResult =
  | {
      baselineSourceControlledPaths: string[];
      prompt: string;
      status: "ready";
    }
  | { result: RawPreparationRunResult; status: "result" };

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

function requestArtifactReadTimeoutFailure(
  artifactName: string,
  timeoutMs: number,
) {
  return {
    assumptions: [],
    blockers: [
      `Repo Preparation timed out reading the ${artifactName} artifact after ${timeoutMs}ms.`,
    ],
    status: "failed" as const,
    suggestedChanges: [
      "Retry Repo Preparation in a fresh Daytona workspace; report this MakeADemo infrastructure failure if it repeats.",
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
  result: PreparationWorkspaceCommandResult,
): ProviderSecretReferenceAuthFailure | RepoPreparationResult | undefined {
  if (result.exitCode === 0) {
    return undefined;
  }

  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const event = tryParseJson(line);
    const message = readProviderInvalidApiKeyMessage(event);
    if (message === undefined) {
      continue;
    }

    return /\bdtn_secr[A-Za-z0-9_*.-]*/.test(message)
      ? {
          blocker:
            "OpenCode provider authentication failed because Daytona supplied a secret reference instead of the provider API key.",
          status: "provider-secret-reference-auth-failed",
        }
      : providerInvalidApiKeyFailureResult();
  }

  return undefined;
}

function readProviderInvalidApiKeyMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  if (event.type !== "error") {
    return undefined;
  }
  const error = event.error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const data = (error as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const errorData = data as Record<string, unknown>;
  if (errorData.statusCode !== 401) {
    return undefined;
  }
  const responseBody =
    typeof errorData.responseBody === "string"
      ? tryParseJson(errorData.responseBody)
      : undefined;
  if (typeof responseBody !== "object" || responseBody === null) {
    return undefined;
  }
  const providerError = (responseBody as Record<string, unknown>).error;
  if (
    typeof providerError !== "object" ||
    providerError === null ||
    (providerError as Record<string, unknown>).code !== "invalid_api_key"
  ) {
    return undefined;
  }

  return typeof errorData.message === "string" ? errorData.message : undefined;
}

function isProviderSecretReferenceAuthFailure(
  result: OpenCodeLoopResult,
): result is ProviderSecretReferenceAuthFailure {
  return (
    "status" in result &&
    result.status === "provider-secret-reference-auth-failed"
  );
}

function providerSecretReferenceAuthFailureResult(): RepoPreparationResult {
  return {
    assumptions: [],
    blockers: [
      "OpenCode provider authentication failed because Daytona supplied a secret reference instead of the provider API key.",
    ],
    status: "failed",
    suggestedChanges: [
      "Retry Repo Preparation after verifying the Daytona provider secret injection.",
    ],
  };
}

function providerInvalidApiKeyFailureResult(): RepoPreparationResult {
  return {
    assumptions: [],
    blockers: [
      "OpenCode provider authentication failed because the provider rejected the configured API key.",
    ],
    status: "failed",
    suggestedChanges: [
      "Verify the configured provider API key before retrying Repo Preparation.",
    ],
  };
}

function deriveRequestArtifactReadTimeoutMs(deadlineAt: number): number {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= minimumBackendToolBudgetMs) {
    return Math.max(1, remainingMs);
  }

  return Math.min(
    requestArtifactReadMaxTimeoutMs,
    Math.max(
      requestArtifactReadMinTimeoutMs,
      remainingMs - minimumBackendToolBudgetMs,
    ),
  );
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
