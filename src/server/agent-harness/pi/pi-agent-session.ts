import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import type { AgentSession } from "../agent-session";
import type {
  AgentHardDeadlineExtension,
  AgentSessionProfile,
  AgentSessionRunInput,
  AgentSessionRunResult,
  AgentSessionRunner,
} from "../agent-session-runner.interface";
import { AgentSessionTimeoutError } from "../agent-session-timeout";
import { universalAgentSystemPrompt } from "../prompts/universal-agent-system-prompt";
import { createContext7ToolDefinitions } from "../tools/context7-tools";
import { createRemoteCodingToolDefinitions } from "../tools/remote-workspace-tools";
import {
  parsePiStructuredOutput,
  readPiAssistantText,
  readPiProviderError,
  readPiReasoningEvent,
  readPiTextDelta,
  readPiToolExecution,
} from "./pi-event-adapter";
import {
  createPiActivityTracker,
  createPiRetryBackoff,
  runWithPiActivityTimeout,
} from "./pi-meaningful-activity-timeout";
import { createPiResourceLoader } from "./pi-resource-loader";
import { createPiStageToolDefinitions } from "./pi-stage-tools";

const defaultCwd = "/workspace";
const defaultAgentDirectory = "/tmp/makeademo/pi-agent";
const interruptionSettlementTimeoutMs = 1_000;
const builtinToolNames = ["read", "bash", "edit", "write"] as const;
const context7ToolNames = ["resolve-library-id", "query-docs"] as const;
const retryPolicy = {
  baseDelayMs: 2_000,
  enabled: true,
  maxRetries: 5,
} as const;
// Reserve enough hard-timeout extension for every provider-owned exponential
// backoff sleep configured above: base * (1 + 2 + ... + 2^(retries - 1)).
const maxRetryTimeoutExtensionMs =
  retryPolicy.baseDelayMs * (2 ** retryPolicy.maxRetries - 1);

/** Minimal provider runtime methods used by the harness. */
export type PiModelRuntime = Pick<ModelRuntime, "getModel"> & {
  setRuntimeApiKey?: (providerID: string, apiKey: string) => Promise<void>;
};

/** Provider session methods retained behind the provider-neutral harness seam. */
export type PiSessionLike = {
  abort: () => Promise<void>;
  dispose: () => void;
  isStreaming?: boolean;
  model?: unknown;
  prompt: (text: string) => Promise<void>;
  /** Rebuilds the provider session with additional tools while retaining history. */
  reconfigureTools?: (tools: readonly ToolDefinition[]) => Promise<void>;
  setActiveToolsByName: (toolNames: string[]) => void;
  setModel: (model: unknown) => Promise<void>;
  setThinkingLevel: (level: AgentSessionProfile["thinkingLevel"]) => void;
  state: { errorMessage?: string; messages?: unknown[] };
  subscribe: (listener: (event: unknown) => void) => () => void;
};

export type PiSessionFactoryInput = {
  agentDir: string;
  cwd: string;
  customTools: readonly ToolDefinition[];
  model: unknown;
  modelID: string;
  providerID: string;
  systemPrompt: string;
  thinkingLevel: AgentSessionProfile["thinkingLevel"];
};

/** Injectable factory keeps seam tests independent of a live model provider. */
export type PiSessionFactory = (
  input: PiSessionFactoryInput,
) => Promise<{ session: PiSessionLike }>;

export type PiAgentSessionOptions = {
  agentDir?: string;
  createModelRuntime?: () => Promise<PiModelRuntime>;
  createSession?: PiSessionFactory;
  /** Injectable Pi SDK creation seam used by the default retained-session adapter. */
  createSdkSession?: typeof createAgentSession;
  cwd?: string;
  /** Harness-owned tools shared by every Pipeline Stage. */
  globalTools?: readonly ToolDefinition[];
  closeGlobalTools?: () => Promise<void> | void;
  modelRuntime?: PiModelRuntime;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /** Backend-only provider credentials; never copied into a Daytona workspace. */
  providerApiKeys?: Readonly<Record<string, string>>;
  resolveModel?: (input: {
    modelID: string;
    providerID: string;
  }) => Promise<unknown>;
  systemPrompt?: string;
  toolTimeoutMs?: number;
  context7ToolTimeoutMs?: number;
};

type RetainedSession = {
  baseToolNames: readonly string[];
  disposed: boolean;
  registeredTools: Map<string, ToolDefinition>;
  thinkingLevel: AgentSessionProfile["thinkingLevel"];
  modelID: string;
  providerID: string;
  providerSession: PiSessionLike;
  workspace: AgentSessionRunInput["workspace"];
};

/** Executes Pi SDK turns while preserving the opaque Agent Harness session contract. */
export class PiAgentSession implements AgentSessionRunner {
  private readonly options: PiAgentSessionOptions;
  private readonly sessions = new WeakMap<AgentSession, RetainedSession>();
  private readonly retainedSessions = new Set<RetainedSession>();
  private readonly pendingProviderOwnership = new Set<Promise<void>>();
  private readonly releasedProviderSessions = new WeakSet<PiSessionLike>();
  private globallyDisposed = false;
  private globalToolsClosed = false;
  private modelRuntimePromise: Promise<PiModelRuntime> | undefined;

  constructor(options: PiAgentSessionOptions = {}) {
    this.options = options;
  }

  async run<T = never>(
    input: AgentSessionRunInput<T>,
  ): Promise<AgentSessionRunResult<T>> {
    const interruption = createPiRunInterruption(input);
    const setupActivity = createPiActivityTracker();
    try {
      await interruption.throwIfExternallyCancelled();
      const retainedPromise = this.getOrCreateSession(input);
      const lateSessionOwnership = retainedPromise.then(
        async (session) => {
          const providerAbort = interruption.attachProvider(
            session.providerSession,
          );
          if (!interruption.interrupted) return;
          if (providerAbort !== undefined) {
            await settleInterruption(
              Promise.resolve(providerAbort).then(() => undefined),
            );
          }
          this.disposeRetainedSession(session);
        },
        () => undefined,
      );
      interruption.attachCleanup(lateSessionOwnership);
      const retained = await interruption.race(
        runWithPiActivityTimeout({
          activity: setupActivity,
          hardDeadlineAt: input.hardDeadlineAt,
          hardTimeoutMs: input.hardTimeoutMs,
          ...(input.inactivityLabel === undefined
            ? {}
            : { inactivityLabel: input.inactivityLabel }),
          inactivityTimeoutMs: input.inactivityTimeoutMs,
          label: input.profile.label,
          onTimeout: () => interruption.interrupt("timeout"),
          run: () => retainedPromise,
        }),
      );
      interruption.attachProvider(retained.providerSession);
      const workspaceRebind = this.rebindWorkspaceTools(
        retained,
        input.workspace,
      );
      interruption.attachCleanup(workspaceRebind);
      await interruption.race(workspaceRebind);
      const stageTools = createPiStageToolDefinitions(input.tools ?? []);
      const unregisteredTools = stageTools.filter(
        (tool) => !retained.registeredTools.has(tool.name),
      );
      if (unregisteredTools.length > 0) {
        if (retained.providerSession.reconfigureTools === undefined) {
          throw new Error(
            `Pi session cannot register Pipeline Stage tools after creation: ${unregisteredTools
              .map((tool) => tool.name)
              .join(", ")}`,
          );
        }
        const registeredTools = new Map(retained.registeredTools);
        for (const tool of unregisteredTools) {
          registeredTools.set(tool.name, tool);
        }
        const toolReconfiguration = retained.providerSession.reconfigureTools([
          ...registeredTools.values(),
        ]);
        interruption.attachCleanup(toolReconfiguration);
        await interruption.race(toolReconfiguration);
        retained.registeredTools = registeredTools;
      }
      retained.providerSession.setActiveToolsByName([
        ...retained.baseToolNames,
        ...stageTools.map((tool) => tool.name),
      ]);
      await interruption.throwIfExternallyCancelled();
      const activity = createPiActivityTracker();
      const deadlineCeilingAt =
        input.deadlineCeilingAt ?? Number.POSITIVE_INFINITY;
      const retryBackoff = createPiRetryBackoff(
        activity,
        input.hardDeadlineAt,
        deadlineCeilingAt,
      );
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let handoff: T | undefined;
      let handoffError: string | undefined;
      let latestToolName: string | undefined;
      let providerError: string | undefined;
      let cumulativeRetryDelayMs = 0;
      let timeoutError: AgentSessionTimeoutError | undefined;
      const toolArguments = new Map<string, unknown>();
      const reasoningBuffers = new Map<number, string>();

      const flushReasoning = (
        contentIndex: number,
        finalContent?: string,
      ): void => {
        const buffered = reasoningBuffers.get(contentIndex) ?? "";
        reasoningBuffers.delete(contentIndex);
        if (buffered.length === 0 && (finalContent?.length ?? 0) === 0) {
          return;
        }
        if (
          finalContent !== undefined &&
          buffered.trim() === finalContent.trim()
        ) {
          const content = finalContent.trim();
          if (content.length > 0) input.onReasoning?.(content);
          return;
        }
        if (
          finalContent !== undefined &&
          finalContent.length > 0 &&
          finalContent !== buffered &&
          !buffered.endsWith(finalContent)
        ) {
          input.onReasoning?.(
            buffered.length === 0
              ? finalContent
              : `${buffered}\n${finalContent}`,
          );
          return;
        }
        const content = buffered.length > 0 ? buffered : finalContent;
        if (content !== undefined && content.length > 0) {
          input.onReasoning?.(content);
        }
      };
      const flushPendingReasoning = (): void => {
        for (const contentIndex of reasoningBuffers.keys()) {
          flushReasoning(contentIndex);
        }
      };

      const emit = (channel: "stderr" | "stdout", chunk: string) => {
        if (chunk.length === 0) return;
        if (channel === "stdout") {
          stdoutChunks.push(chunk);
          this.options.onStdout?.(chunk);
          input.onStdout?.(chunk);
        } else {
          stderrChunks.push(chunk);
          this.options.onStderr?.(chunk);
          input.onStderr?.(chunk);
        }
      };
      const processEvent = (rawEvent: unknown) => {
        const event = rawEvent as Parameters<typeof readPiTextDelta>[0];
        activity.observe(event.type);
        if (event.type === "auto_retry_start") {
          const requestedDelayMs = Math.max(0, event.delayMs);
          const availableDelayMs = Math.max(
            0,
            Math.min(
              maxRetryTimeoutExtensionMs - cumulativeRetryDelayMs,
              deadlineCeilingAt - input.hardDeadlineAt - cumulativeRetryDelayMs,
            ),
          );
          const appliedDelayMs = Math.min(requestedDelayMs, availableDelayMs);
          cumulativeRetryDelayMs += appliedDelayMs;
          retryBackoff.start({
            hardExtensionMs: appliedDelayMs,
            sleepDelayMs: requestedDelayMs,
          });
          const extension: AgentHardDeadlineExtension = {
            appliedExtensionMs: appliedDelayMs,
            hardDeadlineAt: retryBackoff.hardDeadlineAt(),
          };
          input.onHardDeadlineExtended?.(extension);
          const metadata = {
            appliedDelayMs,
            appliedHardTimeoutExtensionMs: appliedDelayMs,
            appliedInactivityTimeoutExtensionMs: requestedDelayMs,
            attempt: event.attempt,
            capped: appliedDelayMs !== requestedDelayMs,
            cumulativeDelayMs: cumulativeRetryDelayMs,
            delayMs: requestedDelayMs,
            maxAttempts: event.maxAttempts,
            reason: readSafeRetryReason(event.errorMessage),
            requestedDelayMs,
          };
          input.onAudit?.("agent-task.provider-retry", metadata);
        } else if (event.type === "auto_retry_end") {
          retryBackoff.clear();
        }
        const text = readPiTextDelta(event);
        if (text !== undefined) emit("stdout", text);
        const reasoning = readPiReasoningEvent(event);
        if (reasoning?.status === "delta") {
          reasoningBuffers.set(
            reasoning.contentIndex,
            (reasoningBuffers.get(reasoning.contentIndex) ?? "") +
              reasoning.content,
          );
        } else if (reasoning !== undefined) {
          flushReasoning(reasoning.contentIndex, reasoning.content);
        }
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "error"
        ) {
          flushPendingReasoning();
        }
        const tool = readPiToolExecution(event);
        if (tool !== undefined) {
          const toolCallId =
            event.type === "tool_execution_start" ||
            event.type === "tool_execution_end"
              ? event.toolCallId
              : undefined;
          if (toolCallId !== undefined && tool.status === "started") {
            toolArguments.set(toolCallId, tool.args);
          } else if (
            toolCallId !== undefined &&
            tool.status === "completed" &&
            tool.args === undefined
          ) {
            tool.args = toolArguments.get(toolCallId);
          }
          latestToolName = tool.name;
          activity.observe(`tool-${tool.status}`, tool.name);
          input.onToolExecution?.(tool);
          if (
            tool.status === "completed" &&
            !tool.isError &&
            input.toolProtocol !== undefined
          ) {
            const decoded = input.toolProtocol.decode({
              input: tool.args,
              name: tool.name,
              status: "completed",
            });
            if (decoded.status === "invalid") {
              handoff = undefined;
              handoffError = decoded.reason;
            } else if (decoded.status === "accepted") {
              handoff = decoded.handoff;
              handoffError = undefined;
              if (
                input.toolProtocol.interruptOnCompletedHandoff === true &&
                !interruption.interrupted
              ) {
                void interruption.interrupt(tool.name);
              }
            }
          }
        }
        const eventError =
          event.type === "agent_end" && event.willRetry
            ? undefined
            : readPiProviderError(event, {
                ignoreAborted: interruption.interrupted,
              });
        if (eventError !== undefined) {
          flushPendingReasoning();
          providerError = eventError;
          emit("stderr", eventError);
        }
        if (event.type === "agent_end") flushPendingReasoning();
      };

      const unsubscribe = retained.providerSession.subscribe(processEvent);
      try {
        await interruption.race(
          runWithPiActivityTimeout({
            activity,
            backoff: retryBackoff,
            hardDeadlineAt: input.hardDeadlineAt,
            hardTimeoutMs: input.hardTimeoutMs,
            ...(input.inactivityLabel === undefined
              ? {}
              : { inactivityLabel: input.inactivityLabel }),
            inactivityTimeoutMs: input.inactivityTimeoutMs,
            label: input.profile.label,
            onTimeout: () => interruption.interrupt("timeout"),
            run: () => retained.providerSession.prompt(input.taskPrompt),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
        );
      } catch (error) {
        if (interruption.externallyCancelled) throw error;
        if (!(error instanceof AgentSessionTimeoutError)) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            !(interruption.interrupted && isIntentionalAbortStateError(message))
          ) {
            providerError ??= message;
            emit("stderr", message);
          }
        } else timeoutError = error;
      } finally {
        flushPendingReasoning();
        unsubscribe();
      }

      if (interruption.interrupted) await interruption.settle();
      await interruption.throwIfExternallyCancelled();
      if (timeoutError !== undefined) throw timeoutError;

      const stateError = retained.providerSession.state.errorMessage;
      if (
        providerError === undefined &&
        stateError !== undefined &&
        !(interruption.interrupted && isIntentionalAbortStateError(stateError))
      ) {
        providerError = stateError;
      }
      const assistantText = readPiAssistantText(
        retained.providerSession.state.messages ?? [],
      );
      const structuredOutput = parsePiStructuredOutput(assistantText);
      const lastMeaningfulActivity = activity.read();
      return {
        exitCode: providerError === undefined ? 0 : 1,
        ...(handoff === undefined ? {} : { handoff }),
        ...(handoffError === undefined ? {} : { handoffError }),
        ...(latestToolName === undefined ? {} : { latestToolName }),
        ...(lastMeaningfulActivity === undefined
          ? {}
          : { lastMeaningfulActivity }),
        ...(providerError === undefined ? {} : { providerError }),
        session: input.session ?? this.createOpaqueSession(retained),
        stderr: stderrChunks.join(""),
        stdout: stdoutChunks.join(""),
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      };
    } finally {
      interruption.dispose();
    }
  }

  /** Disposes provider resources for one retained opaque session. */
  async dispose(session?: AgentSession): Promise<void> {
    if (session === undefined) {
      this.globallyDisposed = true;
      for (const retained of this.retainedSessions) {
        this.disposeRetainedSession(retained);
      }
      await settleInterruption(
        Promise.allSettled([...this.pendingProviderOwnership]).then(
          () => undefined,
        ),
      );
      for (const retained of this.retainedSessions) {
        this.disposeRetainedSession(retained);
      }
      if (!this.globalToolsClosed) {
        this.globalToolsClosed = true;
        await this.options.closeGlobalTools?.();
      }
      return;
    }
    const retained = this.sessions.get(session);
    if (retained === undefined) return;
    this.disposeRetainedSession(retained);
  }

  private async getOrCreateSession<T>(
    input: AgentSessionRunInput<T>,
  ): Promise<RetainedSession> {
    if (this.globallyDisposed) {
      throw new Error("Pi agent session runner has been disposed.");
    }
    if (input.session !== undefined) {
      const retained = this.sessions.get(input.session);
      if (retained === undefined) {
        throw new Error("AgentSession is not backed by a Pi provider session.");
      }
      if (retained.disposed) {
        throw new Error("AgentSession is backed by a disposed Pi session.");
      }
      const modelChanged =
        retained.modelID !== input.profile.modelID ||
        retained.providerID !== input.profile.providerID;
      if (modelChanged) {
        const model = await this.resolveModel(input.profile);
        await retained.providerSession.setModel(model);
        retained.modelID = input.profile.modelID;
        retained.providerID = input.profile.providerID;
      }
      if (
        modelChanged ||
        retained.thinkingLevel !== input.profile.thinkingLevel
      ) {
        retained.providerSession.setThinkingLevel(input.profile.thinkingLevel);
        retained.thinkingLevel = input.profile.thinkingLevel;
      }
      return retained;
    }

    const model = await this.resolveModel(input.profile);
    const context7ToolTimeoutMs =
      this.options.context7ToolTimeoutMs ?? this.options.toolTimeoutMs;
    const customTools = [
      ...(this.options.globalTools ?? []),
      ...createRemoteCodingToolDefinitions({
        cwd: this.options.cwd ?? defaultCwd,
        ...(this.options.toolTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.toolTimeoutMs }),
        workspace: input.workspace,
      }),
      ...createContext7ToolDefinitions(
        context7ToolTimeoutMs === undefined
          ? {}
          : { timeoutMs: context7ToolTimeoutMs },
      ),
      ...createPiStageToolDefinitions(input.tools ?? []),
    ];
    const factory = this.options.createSession ?? this.createDefaultSession;
    const created = await this.ownProviderCreation(
      Promise.resolve().then(() =>
        factory.call(this, {
          agentDir: this.options.agentDir ?? defaultAgentDirectory,
          cwd: this.options.cwd ?? defaultCwd,
          customTools,
          model,
          modelID: input.profile.modelID,
          providerID: input.profile.providerID,
          systemPrompt: this.options.systemPrompt ?? universalAgentSystemPrompt,
          thinkingLevel: input.profile.thinkingLevel,
        }),
      ),
    );
    const retained: RetainedSession = {
      baseToolNames: [
        ...builtinToolNames,
        ...(this.options.globalTools ?? []).map((tool) => tool.name),
        ...context7ToolNames,
      ],
      disposed: false,
      thinkingLevel: input.profile.thinkingLevel,
      modelID: input.profile.modelID,
      providerID: input.profile.providerID,
      providerSession: created.session,
      workspace: input.workspace,
      registeredTools: new Map(
        customTools.map((tool) => [tool.name, tool] as const),
      ),
    };
    this.retainedSessions.add(retained);
    return retained;
  }

  private disposeRetainedSession(retained: RetainedSession): void {
    if (retained.disposed) return;
    retained.disposed = true;
    this.retainedSessions.delete(retained);
    retained.providerSession.dispose();
  }

  private async ownProviderCreation(
    creation: Promise<{ session: PiSessionLike }>,
  ): Promise<{ session: PiSessionLike }> {
    const owned = creation.then(async (created) => {
      if (!this.globallyDisposed) return created;
      await this.releaseProviderSession(created.session);
      throw new Error("Pi agent session runner has been disposed.");
    });
    return this.trackProviderOperation(owned);
  }

  private trackProviderOperation<Value>(
    operation: Promise<Value>,
  ): Promise<Value> {
    const ownership = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pendingProviderOwnership.add(ownership);
    void ownership.finally(() =>
      this.pendingProviderOwnership.delete(ownership),
    );
    return operation;
  }

  private async releaseProviderSession(session: PiSessionLike): Promise<void> {
    if (this.releasedProviderSessions.has(session)) return;
    this.releasedProviderSessions.add(session);
    await settleInterruption(
      Promise.resolve()
        .then(() => session.abort())
        .then(() => undefined),
    );
    session.dispose();
  }

  private async resolveModel(
    profile: AgentSessionRunInput["profile"],
  ): Promise<unknown> {
    if (this.options.resolveModel !== undefined) {
      return this.options.resolveModel({
        modelID: profile.modelID,
        providerID: profile.providerID,
      });
    }
    const runtime = await this.getModelRuntime();
    const model = runtime.getModel(profile.providerID, profile.modelID);
    if (model === undefined) {
      throw new Error(
        `Pi model ${profile.providerID}/${profile.modelID} is unavailable.`,
      );
    }
    return model;
  }

  private async getModelRuntime(): Promise<PiModelRuntime> {
    if (this.options.modelRuntime !== undefined) {
      this.modelRuntimePromise ??= this.configureProviderApiKeys(
        Promise.resolve(this.options.modelRuntime),
      );
      return this.modelRuntimePromise;
    }
    this.modelRuntimePromise ??=
      this.options.createModelRuntime === undefined
        ? this.createDefaultModelRuntime()
        : this.configureProviderApiKeys(this.options.createModelRuntime());
    return this.modelRuntimePromise;
  }

  private async createDefaultModelRuntime(): Promise<PiModelRuntime> {
    const credentials = new InMemoryCredentialStore();
    for (const [providerID, apiKey] of Object.entries(
      this.options.providerApiKeys ?? {},
    )) {
      await credentials.modify(providerID, async () => ({
        key: apiKey,
        type: "api_key",
      }));
    }
    return ModelRuntime.create({ credentials, modelsPath: null });
  }

  private async configureProviderApiKeys(
    runtimePromise: Promise<PiModelRuntime>,
  ): Promise<PiModelRuntime> {
    const runtime = await runtimePromise;
    if (runtime.setRuntimeApiKey !== undefined) {
      for (const [providerID, apiKey] of Object.entries(
        this.options.providerApiKeys ?? {},
      )) {
        await runtime.setRuntimeApiKey(providerID, apiKey);
      }
    }
    return runtime;
  }

  private async createDefaultSession(
    input: PiSessionFactoryInput,
  ): Promise<{ session: PiSessionLike }> {
    const createSdkSession =
      this.options.createSdkSession ?? createAgentSession;
    const settingsManager = SettingsManager.inMemory({
      defaultModel: input.modelID,
      defaultProvider: input.providerID,
      retry: retryPolicy,
    });
    const resourceLoader = await createPiResourceLoader({
      agentDir: input.agentDir,
      cwd: input.cwd,
      settingsManager,
      systemPrompt: input.systemPrompt,
    });
    const runtime = await this.getModelRuntime();
    const sessionManager = SessionManager.inMemory(input.cwd);
    let currentModel = input.model;
    let currentThinkingLevel = input.thinkingLevel;
    let result = await createSdkSession({
      agentDir: input.agentDir,
      cwd: input.cwd,
      customTools: [...input.customTools],
      model: currentModel as never,
      modelRuntime: runtime as ModelRuntime,
      noTools: "all",
      resourceLoader,
      sessionManager,
      settingsManager,
      thinkingLevel: currentThinkingLevel,
      tools: [
        ...builtinToolNames,
        ...context7ToolNames,
        ...input.customTools.map((tool) => tool.name),
      ],
    });
    let aborted = false;
    let abortPromise: Promise<void> | undefined;
    let disposed = false;
    const abort = () => {
      if (abortPromise === undefined) {
        aborted = true;
        abortPromise = Promise.resolve()
          .then(() => result.session.abort())
          .then(() => undefined);
      }
      return abortPromise;
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      result.session.dispose();
    };
    const reconfigureTools = async (tools: readonly ToolDefinition[]) => {
      const previousSession = result.session;
      const replacement = await createSdkSession({
        agentDir: input.agentDir,
        cwd: input.cwd,
        customTools: [...tools],
        model: currentModel as never,
        modelRuntime: runtime as ModelRuntime,
        noTools: "all",
        resourceLoader,
        sessionManager,
        settingsManager,
        thinkingLevel: currentThinkingLevel,
        tools: [
          ...builtinToolNames,
          ...context7ToolNames,
          ...tools.map((tool) => tool.name),
        ],
      });
      if (aborted) {
        await settleInterruption(
          Promise.resolve()
            .then(() => replacement.session.abort())
            .then(() => undefined),
        );
      }
      if (disposed) {
        replacement.session.dispose();
        return;
      }
      result = replacement;
      previousSession.dispose();
    };
    return {
      session: {
        abort,
        dispose,
        get isStreaming() {
          return result.session.isStreaming;
        },
        get model() {
          return result.session.model;
        },
        prompt: (text) => result.session.prompt(text),
        reconfigureTools: (tools) =>
          this.trackProviderOperation(reconfigureTools(tools)),
        setActiveToolsByName: (toolNames) =>
          result.session.setActiveToolsByName(toolNames),
        setModel: (model) => {
          currentModel = model;
          return result.session.setModel(model as never);
        },
        setThinkingLevel: (level) => {
          currentThinkingLevel = level;
          result.session.setThinkingLevel(level);
        },
        get state() {
          return result.session.state;
        },
        subscribe: (listener) => result.session.subscribe(listener as never),
      },
    };
  }

  private createOpaqueSession(retained: RetainedSession): AgentSession {
    const session = Object.freeze({}) as AgentSession;
    this.sessions.set(session, retained);
    return session;
  }

  private async rebindWorkspaceTools(
    retained: RetainedSession,
    workspace: AgentSessionRunInput["workspace"],
  ): Promise<void> {
    if (retained.workspace === workspace) return;
    if (retained.providerSession.reconfigureTools === undefined) {
      throw new Error(
        "Pi session cannot rebind coding tools to a new Daytona workspace.",
      );
    }
    const registeredTools = new Map(retained.registeredTools);
    for (const name of builtinToolNames) registeredTools.delete(name);
    for (const tool of createRemoteCodingToolDefinitions({
      cwd: this.options.cwd ?? defaultCwd,
      ...(this.options.toolTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.toolTimeoutMs }),
      workspace,
    })) {
      registeredTools.set(tool.name, tool);
    }
    await retained.providerSession.reconfigureTools([
      ...registeredTools.values(),
    ]);
    retained.registeredTools = registeredTools;
    retained.workspace = workspace;
  }
}

function createPiRunInterruption<T>(input: AgentSessionRunInput<T>) {
  let providerSession: PiSessionLike | undefined;
  let providerAbort: Promise<unknown> | undefined;
  let workspaceCancellation: Promise<unknown> | undefined;
  let audit: Promise<void> | undefined;
  let interruptionReason: string | undefined;
  let externallyCancelled = false;
  let externalCancellationReason: unknown;
  let rejectExternalCancellation: ((reason: unknown) => void) | undefined;
  const cleanups = new Set<Promise<unknown>>();
  const externalCancellation = new Promise<never>((_resolve, reject) => {
    rejectExternalCancellation = reject;
  });
  void externalCancellation.catch(() => undefined);

  const startProviderAbort = () => {
    if (providerSession === undefined || providerAbort !== undefined) return;
    const activeProvider = providerSession;
    providerAbort = Promise.resolve().then(() => activeProvider.abort());
    void providerAbort.catch(() => undefined);
  };
  const startWorkspaceCancellation = () => {
    workspaceCancellation ??= Promise.resolve().then(() =>
      input.workspace.cancelActiveCommands?.(),
    );
    void workspaceCancellation.catch(() => undefined);
  };
  const currentInterruption = async (): Promise<void> => {
    await Promise.allSettled([
      ...[providerAbort, workspaceCancellation, audit].filter(
        (operation): operation is Promise<unknown> => operation !== undefined,
      ),
      ...cleanups,
    ]);
  };
  const interrupt = (reason: string): Promise<void> => {
    interruptionReason ??= reason;
    startWorkspaceCancellation();
    startProviderAbort();
    audit ??= currentInterruption().then(async () => {
      try {
        await input.workspace.writeSandboxLog?.({
          attempt: input.attempt,
          event: "pi-interruption.completed",
          reason: interruptionReason,
          stage: input.stage,
        });
      } catch {
        // Audit logging is best effort.
      }
    });
    return currentInterruption();
  };
  const settle = async () => {
    const providerAtStart = providerAbort;
    await settleInterruption(currentInterruption());
    if (providerAbort !== providerAtStart) {
      await settleInterruption(currentInterruption());
    }
  };
  const interruptForExternalCancellation = () => {
    if (externallyCancelled) return;
    externallyCancelled = true;
    externalCancellationReason = input.signal?.reason;
    void interrupt("signal");
    void settle().then(() => {
      rejectExternalCancellation?.(externalCancellationReason);
    });
  };
  input.signal?.addEventListener("abort", interruptForExternalCancellation, {
    once: true,
  });
  if (input.signal?.aborted === true) interruptForExternalCancellation();

  const throwIfExternallyCancelled = async () => {
    if (!externallyCancelled) return;
    await settle();
    throw externalCancellationReason;
  };

  return {
    attachProvider(session: PiSessionLike) {
      if (providerSession !== undefined && providerSession !== session) {
        throw new Error("Agent task cannot attach more than one Pi session.");
      }
      providerSession = session;
      if (interruptionReason !== undefined) startProviderAbort();
      return providerAbort;
    },
    attachCleanup(cleanup: Promise<unknown>) {
      const settled = cleanup.then(
        () => undefined,
        () => undefined,
      );
      cleanups.add(settled);
      void settled.finally(() => cleanups.delete(settled));
    },
    dispose() {
      input.signal?.removeEventListener(
        "abort",
        interruptForExternalCancellation,
      );
    },
    get externallyCancelled() {
      return externallyCancelled;
    },
    get interrupted() {
      return interruptionReason !== undefined;
    },
    interrupt,
    async race<Value>(operation: Promise<Value>): Promise<Value> {
      await throwIfExternallyCancelled();
      try {
        return await Promise.race([operation, externalCancellation]);
      } catch (error) {
        if (!externallyCancelled) throw error;
        await settle();
        throw externalCancellationReason;
      }
    },
    settle,
    throwIfExternallyCancelled,
  };
}

async function settleInterruption(interruption: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    interruption.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, interruptionSettlementTimeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function isIntentionalAbortStateError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return [
    "aborted",
    "agent aborted",
    "request aborted",
    "request was aborted",
  ].includes(normalized);
}

function readSafeRetryReason(
  errorMessage: string,
): "rate-limit" | "transient-provider-failure" {
  return /rate[_ -]?limit|too many requests|\b429\b/i.test(errorMessage)
    ? "rate-limit"
    : "transient-provider-failure";
}
