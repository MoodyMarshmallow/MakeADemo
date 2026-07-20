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
  AgentSessionProfile,
  AgentSessionRunInput,
  AgentSessionRunResult,
  AgentSessionRunner,
  AgentToolDefinition,
} from "../agent-session-runner.interface";
import { AgentSessionTimeoutError } from "../agent-session-timeout";
import { universalAgentSystemPrompt } from "../prompts/universal-agent-system-prompt";
import { createContext7ToolDefinitions } from "../tools/context7-tools";
import { createRemoteCodingToolDefinitions } from "../tools/remote-workspace-tools";
import { createPiStageToolDefinitions } from "./pi-stage-tools";
import {
  parsePiStructuredOutput,
  readPiAssistantText,
  readPiProviderError,
  readPiTextDelta,
  readPiToolExecution,
} from "./pi-event-adapter";
import {
  createPiActivityTracker,
  runWithPiActivityTimeout,
} from "./pi-meaningful-activity-timeout";
import { createPiResourceLoader } from "./pi-resource-loader";

const defaultCwd = "/workspace";
const defaultAgentDirectory = "/tmp/makeademo/pi-agent";
const interruptionSettlementTimeoutMs = 1_000;
const builtinToolNames = ["read", "bash", "edit", "write"] as const;
const context7ToolNames = ["resolve-library-id", "query-docs"] as const;

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
  private modelRuntimePromise: Promise<PiModelRuntime> | undefined;

  constructor(options: PiAgentSessionOptions = {}) {
    this.options = options;
  }

  async run<T = never>(
    input: AgentSessionRunInput<T>,
  ): Promise<AgentSessionRunResult<T>> {
    const retained = await this.getOrCreateSession(input);
    await this.rebindWorkspaceTools(retained, input.workspace);
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
      await retained.providerSession.reconfigureTools([
        ...registeredTools.values(),
      ]);
      retained.registeredTools = registeredTools;
    }
    retained.providerSession.setActiveToolsByName([
      ...retained.baseToolNames,
      ...stageTools.map((tool) => tool.name),
    ]);
    const activity = createPiActivityTracker();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let handoff: T | undefined;
    let handoffError: string | undefined;
    let latestToolName: string | undefined;
    let providerError: string | undefined;
    let interrupted = false;
    let interruptionPromise: Promise<void> | undefined;
    let timeoutError: AgentSessionTimeoutError | undefined;
    const toolArguments = new Map<string, unknown>();

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
      const text = readPiTextDelta(event);
      if (text !== undefined) emit("stdout", text);
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
              !interrupted
            ) {
              interrupted = true;
              interruptionPromise = this.interrupt(
                input,
                retained.providerSession,
                tool.name,
              );
            }
          }
        }
      }
      const eventError = readPiProviderError(event, {
        ignoreAborted: interrupted,
      });
      if (eventError !== undefined) {
        providerError = eventError;
        emit("stderr", eventError);
      }
    };

    const unsubscribe = retained.providerSession.subscribe(processEvent);
    try {
      await runWithPiActivityTimeout({
        activity,
        hardDeadlineAt: input.hardDeadlineAt,
        hardTimeoutMs: input.hardTimeoutMs,
        ...(input.inactivityLabel === undefined
          ? {}
          : { inactivityLabel: input.inactivityLabel }),
        inactivityTimeoutMs: input.inactivityTimeoutMs,
        label: input.profile.label,
        onTimeout: () => {
          interrupted = true;
          interruptionPromise = this.interrupt(
            input,
            retained.providerSession,
            "timeout",
          );
          return interruptionPromise;
        },
        run: () => retained.providerSession.prompt(input.taskPrompt),
      });
    } catch (error) {
      if (!(error instanceof AgentSessionTimeoutError)) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(interrupted && isIntentionalAbortStateError(message))) {
          providerError ??= message;
          emit("stderr", message);
        }
      } else timeoutError = error;
    } finally {
      unsubscribe();
    }

    if (interruptionPromise !== undefined) {
      await settleInterruption(interruptionPromise);
    }
    if (timeoutError !== undefined) throw timeoutError;

    const stateError = retained.providerSession.state.errorMessage;
    if (
      providerError === undefined &&
      stateError !== undefined &&
      !(interrupted && isIntentionalAbortStateError(stateError))
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
  }

  /** Disposes provider resources for one retained opaque session. */
  async dispose(session?: AgentSession): Promise<void> {
    if (session === undefined) {
      for (const retained of this.retainedSessions) {
        retained.providerSession.dispose();
        retained.disposed = true;
      }
      this.retainedSessions.clear();
      await this.options.closeGlobalTools?.();
      return;
    }
    const retained = this.sessions.get(session);
    if (retained === undefined) return;
    retained.providerSession.dispose();
    retained.disposed = true;
    this.retainedSessions.delete(retained);
  }

  private async getOrCreateSession<T>(
    input: AgentSessionRunInput<T>,
  ): Promise<RetainedSession> {
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
    const created = await factory.call(this, {
      agentDir: this.options.agentDir ?? defaultAgentDirectory,
      cwd: this.options.cwd ?? defaultCwd,
      customTools,
      model,
      modelID: input.profile.modelID,
      providerID: input.profile.providerID,
      systemPrompt: this.options.systemPrompt ?? universalAgentSystemPrompt,
      thinkingLevel: input.profile.thinkingLevel,
    });
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
    this.modelRuntimePromise ??= this.configureProviderApiKeys(
      this.options.createModelRuntime?.() ??
        ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
        }),
    );
    return this.modelRuntimePromise;
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
    const settingsManager = SettingsManager.inMemory({
      defaultModel: input.modelID,
      defaultProvider: input.providerID,
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
    let result = await createAgentSession({
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
    return {
      session: {
        abort: () => result.session.abort(),
        dispose: () => result.session.dispose(),
        get isStreaming() {
          return result.session.isStreaming;
        },
        get model() {
          return result.session.model;
        },
        prompt: (text) => result.session.prompt(text),
        reconfigureTools: async (tools) => {
          const previousSession = result.session;
          result = await createAgentSession({
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
          previousSession.dispose();
        },
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

  private async interrupt<T>(
    input: AgentSessionRunInput<T>,
    providerSession: PiSessionLike,
    reason: string,
  ): Promise<void> {
    await Promise.allSettled([
      Promise.resolve().then(() => providerSession.abort()),
      Promise.resolve().then(() => input.workspace.cancelActiveCommands?.()),
    ]);
    try {
      await input.workspace.writeSandboxLog?.({
        attempt: input.attempt,
        event: "pi-interruption.completed",
        reason,
        stage: input.stage,
      });
    } catch {
      // Audit logging is best effort.
    }
  }
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
