import { describe, expect, it, vi } from "vitest";

import {
  ModelRuntime,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AgentSession } from "../agent-session";
import type { AgentSessionProfile } from "../agent-session-runner.interface";
import {
  PiAgentSession,
  type PiSessionFactory,
  type PiSessionLike,
} from "./pi-agent-session";

const profile: AgentSessionProfile = {
  label: "Pi test agent",
  modelID: "test-model",
  providerID: "test-provider",
  thinkingLevel: "high",
};

function createSessionFactory() {
  const sessions: Array<{
    abort: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    model: unknown;
    prompt: ReturnType<typeof vi.fn>;
    reconfigureTools: ReturnType<typeof vi.fn>;
    setActiveToolsByName: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    setThinkingLevel: ReturnType<typeof vi.fn>;
    state: { errorMessage?: string; messages: unknown[] };
    subscribe: ReturnType<typeof vi.fn>;
    emit: (event: unknown) => void;
    listenerCount: () => number;
  }> = [];
  const factory: PiSessionFactory = vi.fn(async ({ modelID }) => {
    const listeners = new Set<(event: unknown) => void>();
    const session = {
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
      get isStreaming() {
        return false;
      },
      model: { id: modelID },
      prompt: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }),
      reconfigureTools: vi.fn(
        async (_tools: readonly ToolDefinition[]) => undefined,
      ),
      setActiveToolsByName: vi.fn(),
      setModel: vi.fn(async (model: unknown) => {
        (session as { model: unknown }).model = model;
      }),
      setThinkingLevel: vi.fn(),
      state: {
        errorMessage: undefined as string | undefined,
        messages: [] as unknown[],
      },
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      emit(event: unknown) {
        for (const listener of listeners) listener(event);
      },
      listenerCount() {
        return listeners.size;
      },
    };
    sessions.push(session as (typeof sessions)[number]);
    return { session: session as PiSessionLike };
  });
  return { factory, sessions };
}

function workspaceStub() {
  return {
    async execute() {
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  };
}

function createRawPiSdkSession() {
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    isStreaming: false,
    model: { id: "test-model" },
    prompt: vi.fn(async () => undefined),
    setActiveToolsByName: vi.fn(),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    state: { errorMessage: undefined, messages: [] as unknown[] },
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return { result: { session }, session };
}

describe("PiAgentSession", () => {
  it("keeps one opaque handle while resuming and switching models", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const workspace = {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };

    const first = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "first",
      workspace,
    });
    const second = await runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile: { ...profile, modelID: "second-model" },
      ...(first.session === undefined ? {} : { session: first.session }),
      stage: "test",
      taskPrompt: "second",
      workspace,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.setModel).toHaveBeenCalledWith({ id: "second-model" });
    expect(sessions[0]?.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(second.session).toBe(first.session);
    expect(sessions[0]?.prompt).toHaveBeenCalledTimes(2);
  });

  it("activates the official Context7 tools in the real Pi registry", async () => {
    const runner = new PiAgentSession({
      resolveModel: vi.fn(async () => ({ id: "test-model" })),
    });
    const created = await (
      runner as unknown as {
        createDefaultSession: (input: {
          agentDir: string;
          cwd: string;
          customTools: readonly ToolDefinition[];
          model: unknown;
          modelID: string;
          providerID: string;
          systemPrompt: string;
          thinkingLevel: AgentSessionProfile["thinkingLevel"];
        }) => Promise<{
          session: {
            dispose: () => void;
            state: { tools?: Array<{ name: string }> };
          };
        }>;
      }
    ).createDefaultSession({
      agentDir: "/tmp/makeademo/pi-registry-test",
      cwd: "/workspace",
      customTools: [],
      model: { id: "test-model" },
      modelID: "test-model",
      providerID: "test-provider",
      systemPrompt: "test",
      thinkingLevel: "high",
    });

    expect(created.session.state.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["resolve-library-id", "query-docs"]),
    );
    created.session.dispose();
  });

  it("pins the provider retry policy in the isolated Pi settings", async () => {
    const settings = vi.spyOn(SettingsManager, "inMemory");
    const { result } = createRawPiSdkSession();
    const runner = new PiAgentSession({
      createSdkSession: vi.fn(async () => result) as never,
      modelRuntime: {
        getModel: vi.fn(() => ({ id: "test-model" }) as never),
      },
    });

    try {
      await runner.run({
        attempt: 1,
        hardDeadlineAt: Date.now() + 1_000,
        hardTimeoutMs: 1_000,
        inactivityTimeoutMs: 1_000,
        profile,
        stage: "test",
        taskPrompt: "use retry settings",
        workspace: workspaceStub(),
      });

      expect(settings).toHaveBeenCalledWith(
        expect.objectContaining({
          retry: { baseDelayMs: 2_000, enabled: true, maxRetries: 3 },
        }),
      );
    } finally {
      settings.mockRestore();
    }
  });

  it("uses backend provider keys without repeating the model catalog refresh", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const setRuntimeApiKey = vi
      .spyOn(ModelRuntime.prototype, "setRuntimeApiKey")
      .mockImplementation(() => new Promise<void>(() => undefined));
    const base = createSessionFactory();
    const createSession: PiSessionFactory = vi.fn(async (input) => {
      const created = await base.factory(input);
      created.session.prompt = vi.fn(async () => undefined);
      return created;
    });
    const runner = new PiAgentSession({
      createSession,
      providerApiKeys: { openai: "test-openai-key" },
    });

    try {
      await expect(
        runner.run({
          attempt: 1,
          hardDeadlineAt: Date.now() + 1_000,
          hardTimeoutMs: 1_000,
          inactivityTimeoutMs: 100,
          profile: {
            ...profile,
            modelID: "gpt-5.6-terra",
            providerID: "openai",
          },
          stage: "test",
          taskPrompt: "use the configured provider",
          workspace: workspaceStub(),
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(setRuntimeApiKey).not.toHaveBeenCalled();

      const runtime = await (
        runner as unknown as { getModelRuntime: () => Promise<ModelRuntime> }
      ).getModelRuntime();
      await expect(runtime.getAuth("openai")).resolves.toMatchObject({
        auth: { apiKey: "test-openai-key" },
      });
    } finally {
      await runner.dispose();
      setRuntimeApiKey.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("applies thinking-level changes when a retained model stays the same", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const workspace = {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const first = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "first",
      workspace,
    });
    await runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile: { ...profile, thinkingLevel: "low" },
      ...(first.session === undefined ? {} : { session: first.session }),
      stage: "test",
      taskPrompt: "second",
      workspace,
    });

    expect(sessions[0]?.setThinkingLevel).toHaveBeenLastCalledWith("low");
  });

  it("adapts text and tool events and interrupts an accepted handoff", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const cancelActiveCommands = vi.fn();
    const onStdout = vi.fn();
    const onReasoning = vi.fn();
    const onToolExecution = vi.fn();
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      onStdout,
      onReasoning,
      onToolExecution,
      toolProtocol: {
        decode: (call) =>
          call.name === "stage_submit"
            ? { handoff: { ok: true }, status: "accepted" }
            : { status: "ignored" },
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: {
        cancelActiveCommands,
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        content: "inspect the package before editing",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "tool_execution_start",
      toolName: "stage_submit",
      args: { ok: true },
      toolCallId: "call-1",
    });
    sessions[0]?.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      isError: false,
      result: { content: [{ text: "submitted", type: "text" }] },
      toolCallId: "call-1",
    });
    sessions[0]?.emit({
      type: "agent_end",
      messages: [
        {
          content: [],
          errorMessage: "Request was aborted",
          role: "assistant",
          stopReason: "aborted",
        },
      ],
    });
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(onReasoning).toHaveBeenCalledWith(
      "inspect the package before editing",
    );
    expect(onToolExecution).toHaveBeenNthCalledWith(1, {
      args: { ok: true },
      isError: false,
      name: "stage_submit",
      status: "started",
    });
    expect(onToolExecution).toHaveBeenNthCalledWith(2, {
      args: { ok: true },
      isError: false,
      name: "stage_submit",
      result: { content: [{ text: "submitted", type: "text" }] },
      status: "completed",
    });
    expect(result.handoff).toEqual({ ok: true });
    expect(result.providerError).toBeUndefined();
    expect(sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
  });

  it("retains streamed reasoning without duplicating its final summary", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const onReasoning = vi.fn();
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "reasoning",
      onReasoning,
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "raw reasoning",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "summary reasoning",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "normal summary",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 1,
        content: "normal summary",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 2,
        delta: "raw stream ",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 2,
        delta: "summary stream",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 2,
        content: "summary stream",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [] }],
    });

    await resultPromise;

    expect(onReasoning).toHaveBeenCalledTimes(3);
    expect(onReasoning).toHaveBeenNthCalledWith(
      1,
      "raw reasoning\nsummary reasoning",
    );
    expect(onReasoning).toHaveBeenNthCalledWith(2, "normal summary");
    expect(onReasoning).toHaveBeenNthCalledWith(3, "raw stream summary stream");
  });

  it("emits a terminal reasoning summary once when only whitespace differs", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const onReasoning = vi.fn();
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "reasoning summary",
      onReasoning,
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "**Summary**\n\nInspect the package.\n\n\n",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "**Summary**\n\nInspect the package.",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [] }],
    });

    await resultPromise;

    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(onReasoning).toHaveBeenCalledWith(
      "**Summary**\n\nInspect the package.",
    );
  });

  it("flushes an interrupted reasoning block when Pi ends without thinking_end", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const onReasoning = vi.fn();
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "interrupted reasoning",
      onReasoning,
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "partial reasoning",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        },
      ],
    });

    await resultPromise;

    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(onReasoning).toHaveBeenCalledWith("partial reasoning");
  });

  it("settles an already-cancelled task without creating a provider session", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const controller = new AbortController();
    const reason = new Error("benchmark deadline elapsed");
    const cancelActiveCommands = vi.fn();
    controller.abort(reason);

    await expect(
      runner.run({
        attempt: 1,
        hardDeadlineAt: Date.now() + 1_000,
        hardTimeoutMs: 1_000,
        inactivityTimeoutMs: 1_000,
        profile,
        signal: controller.signal,
        stage: "test",
        taskPrompt: "cancelled",
        workspace: { cancelActiveCommands, ...workspaceStub() },
      }),
    ).rejects.toBe(reason);

    expect(factory).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
  });

  it("releases a provider session created after task cancellation and global disposal", async () => {
    const base = createSessionFactory();
    let completeCreation!: () => Promise<void>;
    const createSession: PiSessionFactory = vi.fn(
      (input) =>
        new Promise<{ session: PiSessionLike }>((resolve) => {
          completeCreation = async () =>
            resolve((await base.factory(input)) as { session: PiSessionLike });
        }),
    );
    const runner = new PiAgentSession({
      createSession,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    const reason = new Error("benchmark deadline elapsed");
    let runSettled = false;
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 2_000,
      hardTimeoutMs: 2_000,
      inactivityTimeoutMs: 2_000,
      profile,
      signal: controller.signal,
      stage: "test",
      taskPrompt: "must not start",
      workspace: workspaceStub(),
    });
    const assertion = expect(resultPromise).rejects.toBe(reason);
    void resultPromise.catch(() => {
      runSettled = true;
    });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    controller.abort(reason);
    let disposalSettled = false;
    const disposal = runner.dispose().then(() => {
      disposalSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runSettled).toBe(false);
    expect(disposalSettled).toBe(false);

    await completeCreation();
    await assertion;
    await disposal;
    const session = base.sessions[0];
    if (session === undefined) throw new Error("Expected late Pi session.");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );

    await runner.dispose();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases a replacement Pi session created after task cancellation and global disposal", async () => {
    const initial = createRawPiSdkSession();
    const replacement = createRawPiSdkSession();
    let completeReplacement!: () => void;
    const createSdkSession = vi
      .fn()
      .mockResolvedValueOnce(initial.result)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeReplacement = () => resolve(replacement.result);
          }),
      );
    const runner = new PiAgentSession({
      createSdkSession,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const workspace = workspaceStub();
    const first = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "first",
      workspace,
    });
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    const reason = new Error("benchmark deadline elapsed");
    let runSettled = false;
    const resultPromise = runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 2_000,
      hardTimeoutMs: 2_000,
      inactivityTimeoutMs: 2_000,
      profile,
      ...(first.session === undefined ? {} : { session: first.session }),
      signal: controller.signal,
      stage: "test",
      taskPrompt: "must not start",
      tools: [
        {
          args: {},
          description: "New stage tool",
          execute: async () => "ok",
          name: "new_stage_tool",
        },
      ],
      workspace,
    });
    const assertion = expect(resultPromise).rejects.toBe(reason);
    void resultPromise.catch(() => {
      runSettled = true;
    });
    await vi.waitFor(() => expect(createSdkSession).toHaveBeenCalledTimes(2));

    controller.abort(reason);
    let disposalSettled = false;
    const disposal = runner.dispose().then(() => {
      disposalSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runSettled).toBe(false);
    expect(disposalSettled).toBe(false);

    completeReplacement();
    await assertion;
    await disposal;
    expect(initial.session.abort).toHaveBeenCalledTimes(1);
    expect(initial.session.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.session.abort).toHaveBeenCalledTimes(1);
    expect(replacement.session.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.session.prompt).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );

    await runner.dispose();
    expect(initial.session.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels session setup before a hanging tool reconfiguration can start the provider prompt", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const workspace = workspaceStub();
    const first = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "first",
      workspace,
    });
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected Pi session.");
    let resolveSetup!: () => void;
    session.reconfigureTools.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSetup = resolve;
        }),
    );
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    const reason = new Error("benchmark deadline elapsed");
    const cancelActiveCommands = vi.fn();
    const resultPromise = runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      ...(first.session === undefined ? {} : { session: first.session }),
      signal: controller.signal,
      stage: "test",
      taskPrompt: "must not start",
      tools: [
        {
          args: {},
          description: "New stage tool",
          execute: async () => "ok",
          name: "new_stage_tool",
        },
      ],
      workspace: { cancelActiveCommands, ...workspace },
    });
    await vi.waitFor(() => expect(session.reconfigureTools).toHaveBeenCalled());
    const assertion = expect(resultPromise).rejects.toBe(reason);
    let settled = false;
    void resultPromise.catch(() => {
      settled = true;
    });

    controller.abort(reason);

    await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1));
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    resolveSetup();
    await assertion;
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
    await Promise.resolve();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
  });

  it("cancels a running task once when an external cancellation races a handoff interrupt", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const controller = new AbortController();
    const reason = new Error("benchmark deadline elapsed");
    let resolveAbort!: () => void;
    let resolveCancel!: () => void;
    const abort = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const cancel = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelActiveCommands = vi.fn(() => cancel);
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      signal: controller.signal,
      stage: "test",
      taskPrompt: "cancelled",
      toolProtocol: {
        decode: () => ({ handoff: { ok: true }, status: "accepted" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: { cancelActiveCommands, ...workspaceStub() },
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected Pi session.");
    session.abort.mockImplementation(() => abort);
    session.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      args: { ok: true },
      isError: false,
      result: { content: [] },
      toolCallId: "call-1",
    });
    controller.abort(reason);

    await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1));
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);

    resolveAbort();
    resolveCancel();
    await expect(resultPromise).rejects.toBe(reason);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
    expect(session.listenerCount()).toBe(0);
  });

  it("waits for workspace command cancellation when provider abort rejects the prompt first", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const controller = new AbortController();
    const reason = new Error("benchmark deadline elapsed");
    let rejectPrompt!: (reason: unknown) => void;
    let resolveCancel!: () => void;
    const cancel = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelActiveCommands = vi.fn(() => cancel);
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      signal: controller.signal,
      stage: "test",
      taskPrompt: "cancelled",
      workspace: { cancelActiveCommands, ...workspaceStub() },
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected Pi session.");
    session.prompt.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    session.abort.mockImplementation(async () => {
      rejectPrompt(new Error("request aborted"));
    });
    let settled = false;
    const assertion = expect(resultPromise).rejects.toBe(reason);
    void resultPromise.catch(() => {
      settled = true;
    });

    controller.abort(reason);

    await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1));
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    resolveCancel();
    await assertion;
    expect(session.listenerCount()).toBe(0);
  });

  it("waits for provider abort and workspace cancellation before resolving a handoff", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    let resolveAbort!: () => void;
    let resolveCancel!: () => void;
    const abort = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const cancel = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelActiveCommands = vi.fn(() => cancel);
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: {
        decode: () => ({ handoff: { ok: true }, status: "accepted" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: { cancelActiveCommands, ...workspaceStub() },
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected Pi session.");
    session.abort.mockImplementation(() => abort);
    session.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      args: { ok: true },
      isError: false,
      result: { content: [] },
      toolCallId: "call-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    resolveAbort();
    resolveCancel();
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      handoff: { ok: true },
    });
  });

  it("waits for timeout interruption settlement and preserves the timeout", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    let resolveCancel!: () => void;
    const cancel = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 20,
      profile,
      stage: "test",
      taskPrompt: "timeout",
      workspace: {
        cancelActiveCommands: vi.fn(() => cancel),
        ...workspaceStub(),
      },
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    let settled = false;
    void resultPromise.catch(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    resolveCancel();
    await expect(resultPromise).rejects.toThrow(/timed out/);
  });

  it("times out when initial provider session setup never settles", async () => {
    const cancelActiveCommands = vi.fn();
    const runner = new PiAgentSession({
      createSession: vi.fn(() => new Promise<never>(() => undefined)),
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });

    const result = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityLabel: "Repo Preparation agent",
      inactivityTimeoutMs: 20,
      profile,
      stage: "repo-preparation",
      taskPrompt: "prepare",
      workspace: { cancelActiveCommands, ...workspaceStub() },
    });

    await expect(
      Promise.race([
        result,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("session setup hung")), 1_500),
        ),
      ]),
    ).rejects.toMatchObject({
      name: "AgentSessionTimeoutError",
      timeoutKind: "inactivity",
    });
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging workspace cancellation without losing an accepted handoff", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 2_000,
      hardTimeoutMs: 2_000,
      inactivityTimeoutMs: 2_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: {
        decode: () => ({ handoff: { ok: true }, status: "accepted" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: {
        async cancelActiveCommands() {
          await new Promise<void>(() => undefined);
        },
        ...workspaceStub(),
      },
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      args: { ok: true },
      isError: false,
      result: { content: [] },
      toolCallId: "call-1",
    });

    await expect(
      Promise.race([
        resultPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("interruption hung")), 1_500),
        ),
      ]),
    ).resolves.toMatchObject({ exitCode: 0, handoff: { ok: true } });
  });

  it("suppresses only the provider abort state left by an intentional handoff interrupt", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: {
        decode: () => ({ handoff: { ok: true }, status: "accepted" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      args: { ok: true },
      isError: false,
      result: { content: [] },
      toolCallId: "call-1",
    });
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected Pi session.");
    session.state.errorMessage = "Request was aborted";

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.providerError).toBeUndefined();
  });

  it("recovers from a retryable provider error without retaining a sticky failure", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const audits: Array<Record<string, boolean | number | string>> = [];
    const tools: string[] = [];
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      onAudit: (_event, metadata) => audits.push(metadata),
      onToolExecution: (event) => tools.push(`${event.name}:${event.status}`),
      profile,
      stage: "test",
      taskPrompt: "retry",
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected Pi session.");
    session.emit({
      messages: [
        {
          errorMessage: "rate limit for org_123 at https://example.test",
          role: "assistant",
          stopReason: "error",
        },
      ],
      type: "agent_end",
      willRetry: true,
    });
    session.emit({
      attempt: 1,
      delayMs: 2_000,
      errorMessage: "rate limit for org_123 at https://example.test",
      maxAttempts: 3,
      type: "auto_retry_start",
    });
    session.state.messages = [
      {
        content: [{ text: "recovered", type: "text" }],
        role: "assistant",
      },
    ];
    session.emit({
      attempt: 1,
      success: true,
      type: "auto_retry_end",
    });
    session.emit({
      args: { path: "package.json" },
      toolCallId: "read-once",
      toolName: "read",
      type: "tool_execution_start",
    });
    session.emit({
      isError: false,
      result: { content: [] },
      toolCallId: "read-once",
      toolName: "read",
      type: "tool_execution_end",
    });
    session.emit({
      messages: [{ role: "assistant", stopReason: "stop" }],
      type: "agent_end",
      willRetry: false,
    });

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
    expect(audits).toEqual([
      expect.objectContaining({
        appliedDelayMs: 2_000,
        appliedHardTimeoutExtensionMs: 2_000,
        appliedInactivityTimeoutExtensionMs: 2_000,
        attempt: 1,
        capped: false,
        cumulativeDelayMs: 2_000,
        delayMs: 2_000,
        maxAttempts: 3,
        reason: "rate-limit",
        requestedDelayMs: 2_000,
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain("org_123");
    expect(JSON.stringify(audits)).not.toContain("example.test");
    expect(tools).toEqual(["read:started", "read:completed"]);
  });

  it("cancels immediately during provider backoff without issuing another prompt", async () => {
    const base = createSessionFactory();
    const createSession: PiSessionFactory = vi.fn(async (input) => {
      const created = await base.factory(input);
      created.session.prompt = vi.fn(() => new Promise<void>(() => undefined));
      return created;
    });
    const runner = new PiAgentSession({
      createSession,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const controller = new AbortController();
    const reason = new Error("pipeline cancelled");
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 10_000,
      hardTimeoutMs: 10_000,
      inactivityTimeoutMs: 10_000,
      profile,
      signal: controller.signal,
      stage: "test",
      taskPrompt: "retry",
      workspace: workspaceStub(),
    });
    await vi.waitFor(() =>
      expect(base.sessions[0]?.subscribe).toHaveBeenCalled(),
    );
    base.sessions[0]?.emit({
      attempt: 1,
      delayMs: 2_000,
      errorMessage: "rate limit exceeded",
      maxAttempts: 3,
      type: "auto_retry_start",
    });

    controller.abort(reason);
    base.sessions[0]?.emit({
      attempt: 1,
      finalError: "Retry cancelled",
      success: false,
      type: "auto_retry_end",
    });

    await expect(resultPromise).rejects.toBe(reason);
    expect(base.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(base.sessions[0]?.prompt).toHaveBeenCalledTimes(1);
  });

  it("returns the final provider failure after the retry budget is exhausted", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "retry",
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    const finalError = "429 retry budget exhausted";
    sessions[0]?.emit({
      attempt: 3,
      finalError,
      success: false,
      type: "auto_retry_end",
    });
    sessions[0]?.emit({
      messages: [
        { errorMessage: finalError, role: "assistant", stopReason: "error" },
      ],
      type: "agent_end",
      willRetry: false,
    });

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      providerError: finalError,
    });
  });

  it("accumulates provider-authoritative exponential backoff extensions", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const audits: Array<Record<string, boolean | number | string>> = [];
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      onAudit: (_event, metadata) => audits.push(metadata),
      profile,
      stage: "test",
      taskPrompt: "retry",
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    for (const [attempt, delayMs] of [
      [1, 2_000],
      [2, 4_000],
      [3, 8_000],
    ] as const) {
      sessions[0]?.emit({
        attempt,
        delayMs,
        errorMessage: "temporary upstream failure",
        maxAttempts: 3,
        type: "auto_retry_start",
      });
    }

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
    expect(audits.map((entry) => entry.cumulativeDelayMs)).toEqual([
      2_000, 6_000, 14_000,
    ]);
    expect(audits.map((entry) => entry.reason)).toEqual([
      "transient-provider-failure",
      "transient-provider-failure",
      "transient-provider-failure",
    ]);
  });

  it("caps hard extension at the immutable Pipeline deadline while excluding the full provider sleep", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const hardDeadlineAt = Date.now() + 1_000;
    const audits: Array<Record<string, boolean | number | string>> = [];
    const resultPromise = runner.run({
      attempt: 1,
      deadlineCeilingAt: hardDeadlineAt + 5_000,
      hardDeadlineAt,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      onAudit: (_event, metadata) => audits.push(metadata),
      profile,
      stage: "test",
      taskPrompt: "retry",
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      attempt: 1,
      delayMs: 40_000,
      errorMessage: "rate_limit response 429",
      maxAttempts: 3,
      type: "auto_retry_start",
    });

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
    expect(audits).toEqual([
      expect.objectContaining({
        appliedDelayMs: 5_000,
        appliedHardTimeoutExtensionMs: 5_000,
        appliedInactivityTimeoutExtensionMs: 40_000,
        capped: true,
        cumulativeDelayMs: 5_000,
        reason: "rate-limit",
        requestedDelayMs: 40_000,
      }),
    ]);
  });

  it("preserves a genuine provider error after an intentional handoff interrupt", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: {
        decode: () => ({ handoff: { ok: true }, status: "accepted" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: workspaceStub(),
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      args: { ok: true },
      isError: false,
      result: { content: [] },
      toolCallId: "call-1",
    });
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected Pi session.");
    session.state.errorMessage = "Provider connection failed";

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.providerError).toBe("Provider connection failed");
  });

  it("disposes retained provider sessions", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const workspace = {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const result = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "dispose",
      workspace,
    });
    await runner.dispose(result.session as AgentSession);
    expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    if (result.session === undefined) throw new Error("Expected a session.");
    await expect(
      runner.run({
        attempt: 2,
        hardDeadlineAt: Date.now() + 1_000,
        hardTimeoutMs: 1_000,
        inactivityTimeoutMs: 1_000,
        profile,
        session: result.session,
        stage: "test",
        taskPrompt: "reuse disposed",
        workspace,
      }),
    ).rejects.toThrow("disposed");
  });

  it("does not accept a failed stage tool execution as a handoff", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "failed handoff",
      toolProtocol: {
        decode: () => ({ handoff: { ok: true }, status: "accepted" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: {
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });
    await vi.waitFor(() => expect(sessions[0]?.subscribe).toHaveBeenCalled());
    sessions[0]?.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      args: { ok: true },
      isError: true,
      result: { content: [{ type: "text", text: "write failed" }] },
      toolCallId: "failed-call",
    });

    const result = await resultPromise;

    expect(result.handoff).toBeUndefined();
    expect(sessions[0]?.abort).not.toHaveBeenCalled();
  });

  it("exposes stage tools only for the active Pipeline Stage", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      globalTools: [
        {
          description: "Search",
          execute: vi.fn() as never,
          label: "Search",
          name: "web_search",
          parameters: {} as never,
        },
      ],
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const workspace = {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const first = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "repo-preparation",
      taskPrompt: "prepare",
      tools: [
        {
          args: {},
          description: "Repo Preparation only",
          execute: vi.fn(async () => "done"),
          name: "repo_prepare",
        },
      ],
      workspace,
    });
    await runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      ...(first.session === undefined ? {} : { session: first.session }),
      stage: "script-generation",
      taskPrompt: "write script",
      workspace,
    });

    expect(sessions[0]?.setActiveToolsByName).toHaveBeenLastCalledWith(
      expect.not.arrayContaining(["repo_prepare"]),
    );
    expect(sessions[0]?.setActiveToolsByName).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        "read",
        "bash",
        "edit",
        "write",
        "web_search",
        "resolve-library-id",
        "query-docs",
      ]),
    );
  });

  it("registers tools introduced by a later Pipeline Stage without losing the session", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const workspace = {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const first = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "stage-one",
      taskPrompt: "first",
      tools: [
        {
          args: {},
          description: "First stage tool",
          execute: vi.fn(async () => "first"),
          name: "first_stage_tool",
        },
      ],
      workspace,
    });

    await runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      ...(first.session === undefined ? {} : { session: first.session }),
      stage: "stage-two",
      taskPrompt: "second",
      tools: [
        {
          args: {},
          description: "Second stage tool",
          execute: vi.fn(async () => "second"),
          name: "second_stage_tool",
        },
      ],
      workspace,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.reconfigureTools).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.reconfigureTools).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "first_stage_tool" }),
        expect.objectContaining({ name: "second_stage_tool" }),
      ]),
    );
    expect(sessions[0]?.setActiveToolsByName).toHaveBeenLastCalledWith(
      expect.arrayContaining(["second_stage_tool"]),
    );
  });

  it("rebinds retained coding tools when a resumed stage supplies another workspace", async () => {
    const { factory, sessions } = createSessionFactory();
    const runner = new PiAgentSession({
      createSession: factory,
      resolveModel: vi.fn(async ({ modelID }) => ({ id: modelID })),
    });
    const firstWorkspace = workspaceStub();
    const secondWorkspace = workspaceStub();
    const first = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "stage-one",
      taskPrompt: "first",
      workspace: firstWorkspace,
    });

    await runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      ...(first.session === undefined ? {} : { session: first.session }),
      stage: "stage-two",
      taskPrompt: "second",
      workspace: secondWorkspace,
    });

    expect(sessions[0]?.reconfigureTools).toHaveBeenCalled();
    const latestTools = sessions[0]?.reconfigureTools.mock.calls.at(-1)?.[0] as
      | readonly ToolDefinition[]
      | undefined;
    const remoteRead = latestTools?.find((tool) => tool.name === "read");
    expect(remoteRead).toBeDefined();
  });
});
