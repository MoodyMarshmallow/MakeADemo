import { describe, expect, it, vi } from "vitest";

import type { AgentToolProtocol } from "../agent-session-runner.interface";
import { AgentSessionTimeoutError } from "../agent-session-timeout";
import { OpenCodeAgentSession } from "./opencode-agent-session";

const profile = {
  label: "Test agent",
  modelID: "test-model",
  providerID: "test-provider",
};

describe("OpenCodeAgentSession", () => {
  it("starts an opaque session and resumes the same handle", async () => {
    const commands: string[] = [];
    const runner = new OpenCodeAgentSession();
    const workspace = {
      async execute(command: string) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            sessionID:
              commands.length === 1 ? "session_123" : "session_replaced_456",
            type: "session",
          }),
        };
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
    if (first.session === undefined) throw new Error("Expected a session.");
    const second = await runner.run({
      attempt: 2,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      session: first.session,
      stage: "test",
      taskPrompt: "second",
      workspace,
    });

    expect(first.session).toBeDefined();
    expect(second.session).toBe(first.session);
    expect(commands[1]).toContain("--session 'session_123'");
    if (second.session === undefined) throw new Error("Expected a session.");
    const third = await runner.run({
      attempt: 3,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      session: second.session,
      stage: "test",
      taskPrompt: "third",
      workspace,
    });
    expect(third.session).toBe(first.session);
    expect(commands[2]).toContain("--session 'session_replaced_456'");
  });

  it("cancels exactly once for an accepted completed handoff", async () => {
    const cancelActiveCommands = vi.fn();
    const protocol: AgentToolProtocol<{ target: string }> = {
      decode: (call) =>
        call.name === "stage_submit"
          ? { handoff: { target: "done" }, status: "accepted" }
          : { status: "ignored" },
      interruptOnCompletedHandoff: true,
      trackedNames: ["stage_submit"],
    };
    const runner = new OpenCodeAgentSession();
    const result = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: protocol,
      workspace: {
        cancelActiveCommands,
        async execute(_command, options) {
          options.onStdout?.(
            `${JSON.stringify({
              state: { input: { target: "done" }, status: "completed" },
              tool: "stage_submit",
            })}\n`,
          );
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });

    expect(result.handoff).toEqual({ target: "done" });
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
  });

  it("does not cancel invalid or unrelated completed tools", async () => {
    const cancelActiveCommands = vi.fn();
    const runner = new OpenCodeAgentSession();
    const result = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: {
        decode: () => ({ reason: "invalid", status: "invalid" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: {
        cancelActiveCommands,
        async execute(_command, options) {
          options.onStdout?.(
            `${JSON.stringify({
              state: { input: {}, status: "completed" },
              tool: "stage_submit",
            })}\n`,
          );
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });

    expect(result.handoffError).toBe("invalid");
    expect(cancelActiveCommands).not.toHaveBeenCalled();
  });

  it("returns a later malformed tracked call instead of an earlier handoff", async () => {
    const runner = new OpenCodeAgentSession();
    const result = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: {
        decode: (call) =>
          call.name === "install"
            ? { handoff: { target: "dependencies" }, status: "accepted" }
            : { status: "ignored" },
        trackedNames: ["install", "validate"],
      },
      workspace: {
        async execute(_command, options) {
          options.onStdout?.(
            `${JSON.stringify({ input: { target: "dependencies" }, tool: "install" })}\n`,
          );
          options.onStdout?.(`${JSON.stringify({ tool: "validate" })}\n`);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });

    expect(result.handoff).toBeUndefined();
    expect(result.handoffError).toBe("validate input is missing or malformed");
  });

  it.each([
    ["stderr", "stdout"],
    ["stdout", "stderr"],
  ] as const)(
    "preserves live %s protocol observations over returned %s replay",
    async (liveChannel, returnedChannel) => {
      const runner = new OpenCodeAgentSession();
      const handoffProtocol: AgentToolProtocol<{ target: string }> = {
        decode: (call) =>
          call.name === "stage_submit"
            ? { handoff: { target: "live" }, status: "accepted" }
            : { reason: "returned malformed", status: "invalid" },
        trackedNames: ["stage_submit", "stage_validate"],
      };
      const liveChunk = JSON.stringify({
        state: { input: { target: "live" }, status: "completed" },
        tool: "stage_submit",
      });
      const replayChunk = JSON.stringify({ tool: "stage_validate" });
      const result = await runner.run({
        attempt: 1,
        hardDeadlineAt: Date.now() + 1_000,
        hardTimeoutMs: 1_000,
        inactivityTimeoutMs: 1_000,
        profile,
        stage: "test",
        taskPrompt: "replay-order",
        toolProtocol: handoffProtocol,
        workspace: {
          async execute(_command, options) {
            if (liveChannel === "stderr") options.onStderr?.(`${liveChunk}\n`);
            else options.onStdout?.(`${liveChunk}\n`);
            return {
              exitCode: 0,
              stderr: returnedChannel === "stderr" ? `${replayChunk}\n` : "",
              stdout: returnedChannel === "stdout" ? `${replayChunk}\n` : "",
            };
          },
        },
      });

      expect(result.handoff).toEqual({ target: "live" });
      expect(result.handoffError).toBeUndefined();
    },
  );

  it("continues accepted handoffs when interruption logging throws synchronously", async () => {
    const runner = new OpenCodeAgentSession();
    const result = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "handoff",
      toolProtocol: {
        decode: () => ({ handoff: { target: "done" }, status: "accepted" }),
        interruptOnCompletedHandoff: true,
        trackedNames: ["stage_submit"],
      },
      workspace: {
        cancelActiveCommands: vi.fn(),
        async execute(_command, options) {
          options.onStdout?.(
            `${JSON.stringify({
              state: { input: { target: "done" }, status: "completed" },
              tool: "stage_submit",
            })}\n`,
          );
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        writeSandboxLog() {
          throw new Error("log sink unavailable");
        },
      },
    });

    expect(result.handoff).toEqual({ target: "done" });
  });

  it("recovers a completed handoff from returned output when streaming emitted no chunks", async () => {
    const runner = new OpenCodeAgentSession();
    const result = await runner.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      profile,
      stage: "test",
      taskPrompt: "fallback handoff",
      toolProtocol: {
        decode: (call) =>
          call.name === "stage_submit"
            ? { handoff: { target: "fallback" }, status: "accepted" }
            : { status: "ignored" },
        trackedNames: ["stage_submit"],
      },
      workspace: {
        async execute() {
          const fallbackPayload = JSON.stringify({
            state: { input: { target: "fallback" }, status: "completed" },
            tool: "stage_submit",
          });
          return {
            exitCode: 0,
            stderr: "",
            stdout: `${fallbackPayload}\n`,
          };
        },
      },
    });

    expect(result.handoff).toEqual({ target: "fallback" });
    expect(result.handoffError).toBeUndefined();
  });

  it("cancels a silent turn and preserves timeout metadata", async () => {
    const cancelActiveCommands = vi.fn();
    const runner = new OpenCodeAgentSession();

    await expect(
      runner.run({
        attempt: 1,
        hardDeadlineAt: Date.now() + 20,
        hardTimeoutMs: 20,
        inactivityTimeoutMs: 20,
        profile,
        stage: "test",
        taskPrompt: "silent",
        workspace: {
          cancelActiveCommands,
          async execute() {
            return await new Promise<never>(() => undefined);
          },
        },
      }),
    ).rejects.toBeInstanceOf(AgentSessionTimeoutError);
    expect(cancelActiveCommands).toHaveBeenCalledTimes(1);
  });
});
