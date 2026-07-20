import { describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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
    const resultPromise = runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      onStdout,
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
        type: "thinking_delta",
        delta: "secret reasoning",
      },
      message: { role: "assistant", content: [] },
    });
    sessions[0]?.emit({
      type: "tool_execution_end",
      toolName: "stage_submit",
      args: { ok: true },
      isError: false,
      result: { content: [] },
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
    expect(result.handoff).toEqual({ ok: true });
    expect(result.providerError).toBeUndefined();
    expect(sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
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
