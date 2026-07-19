import { describe, expect, it, vi } from "vitest";

import type { AgentSessionRunResult } from "./agent-session-runner.interface";
import { bindAgentTaskRunner } from "./bind-agent-task-runner";

describe("bindAgentTaskRunner", () => {
  it.each([
    ["invalid API key", "invalid_api_key", "provider-auth-invalid"],
    [
      "secret reference",
      "provider-secret-reference",
      "provider-auth-secret-reference",
    ],
    ["generic provider failure", "rate limit exceeded", "provider"],
  ])(
    "classifies %s evidence without over-reporting authentication failures",
    async (_label, providerError, category) => {
      const runner = bindAgentTaskRunner(
        {
          run: async () => ({
            exitCode: 1,
            providerError,
            stderr: "",
            stdout: "",
          }),
        } as never,
        {
          classifyProviderFailure: (message) => {
            if (message.includes("provider-secret-reference"))
              return "provider-auth-secret-reference" as const;
            if (message.includes("invalid_api_key"))
              return "provider-auth-invalid" as const;
            return "provider" as const;
          },
          dangerouslySkipPermissions: true,
          profile: { label: "test", modelID: "model", providerID: "provider" },
        },
      );

      const result = await runner.run({
        attempt: 1,
        hardDeadlineAt: Date.now() + 1000,
        hardTimeoutMs: 1000,
        inactivityTimeoutMs: 1000,
        stage: "test",
        taskPrompt: "task",
        workspace: {} as never,
      });

      expect(result.failure?.category).toBe(category);
    },
  );

  it("keeps provider settings in the bound runner and out of task input", async () => {
    const run = vi.fn(
      async (input): Promise<AgentSessionRunResult> => ({
        ...(() => {
          input.onStdout?.("provider text");
          return {};
        })(),
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          dangerouslySkipPermissions: input.dangerouslySkipPermissions,
          modelID: input.profile.modelID,
          providerID: input.profile.providerID,
        }),
      }),
    );
    const runner = bindAgentTaskRunner({ run } as never, {
      dangerouslySkipPermissions: true,
      profile: {
        label: "Script Generation",
        modelID: "model",
        providerID: "provider",
      },
    });

    const taskInput = {
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      stage: "script-generation",
      taskPrompt: "bounded task",
      workspace: {} as never,
    };
    const result = await runner.run(taskInput);

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        dangerouslySkipPermissions: true,
        profile: expect.objectContaining({
          modelID: "model",
          providerID: "provider",
        }),
      }),
    );
    expect(result).not.toHaveProperty("stdout");
    expect(result.events).toEqual(
      expect.arrayContaining([
        { channel: "standard", kind: "output", length: 13 },
        expect.objectContaining({ event: "agent-task.started", kind: "audit" }),
        expect.objectContaining({
          event: "agent-task.finished",
          kind: "audit",
        }),
      ]),
    );
  });

  it("prepares a scoped workspace once before the first task execution", async () => {
    const order: string[] = [];
    const workspace = {} as never;
    const run = vi.fn(async (): Promise<AgentSessionRunResult> => {
      order.push("run");
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    const runner = bindAgentTaskRunner({ run } as never, {
      dangerouslySkipPermissions: true,
      prepareWorkspace: async ({
        timeoutMs,
        toolScope,
        workspace: preparedWorkspace,
      }) => {
        expect(toolScope).toBe("repo-preparation");
        expect(preparedWorkspace).toBe(workspace);
        expect(timeoutMs).toBe(1_000);
        order.push("prepare");
      },
      profile: { label: "test", modelID: "model", providerID: "provider" },
    });
    const input = {
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      stage: "repo-preparation",
      taskPrompt: "task",
      toolScope: "repo-preparation",
      workspace,
    };

    await runner.run(input);
    await runner.run({ ...input, attempt: 2 });

    expect(order).toEqual(["prepare", "run", "run"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("normalizes inactivity timeout while preparing a workspace and cancels active commands", async () => {
    vi.useFakeTimers();
    try {
      const cancelActiveCommands = vi.fn(() =>
        Promise.reject(new Error("cancel failed")),
      );
      const workspace = { cancelActiveCommands } as never;
      const run = vi.fn(
        async (): Promise<AgentSessionRunResult> => ({
          exitCode: 0,
          stderr: "",
          stdout: "",
        }),
      );
      const runner = bindAgentTaskRunner({ run } as never, {
        dangerouslySkipPermissions: true,
        prepareWorkspace: async () => new Promise<void>(() => undefined),
        profile: { label: "test", modelID: "model", providerID: "provider" },
      });
      const task = runner.run({
        attempt: 1,
        hardDeadlineAt: Date.now() + 1_000,
        hardTimeoutMs: 1_000,
        inactivityTimeoutMs: 20,
        stage: "repo-preparation",
        taskPrompt: "task",
        toolScope: "repo-preparation",
        workspace,
      });

      await vi.advanceTimersByTimeAsync(20);
      const result = await task;

      expect(result.failure).toMatchObject({
        category: "timeout",
        message: expect.stringContaining("inactivity"),
      });
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "agent-task.timeout",
            metadata: { timeoutKind: "inactivity" },
          }),
        ]),
      );
      expect(cancelActiveCommands).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the hard-cap category when workspace preparation reaches the hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const cancelActiveCommands = vi.fn();
      const workspace = { cancelActiveCommands } as never;
      const run = vi.fn(
        async (): Promise<AgentSessionRunResult> => ({
          exitCode: 0,
          stderr: "",
          stdout: "",
        }),
      );
      const runner = bindAgentTaskRunner({ run } as never, {
        dangerouslySkipPermissions: true,
        prepareWorkspace: async () => new Promise<void>(() => undefined),
        profile: { label: "test", modelID: "model", providerID: "provider" },
      });
      const task = runner.run({
        attempt: 1,
        hardDeadlineAt: Date.now() + 20,
        hardTimeoutMs: 20,
        inactivityTimeoutMs: 100,
        stage: "repo-preparation",
        taskPrompt: "task",
        toolScope: "repo-preparation",
        workspace,
      });

      await vi.advanceTimersByTimeAsync(20);
      const result = await task;

      expect(result.failure).toMatchObject({
        category: "timeout",
        message: expect.stringContaining("hard cap"),
      });
      expect(cancelActiveCommands).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries workspace preparation after a failed setup without marking the workspace prepared", async () => {
    const workspace = {} as never;
    const prepareWorkspace = vi
      .fn<(input: { toolScope: string; timeoutMs: number }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("setup failed"))
      .mockResolvedValue(undefined);
    const run = vi.fn(
      async (): Promise<AgentSessionRunResult> => ({
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
    );
    const runner = bindAgentTaskRunner({ run } as never, {
      dangerouslySkipPermissions: true,
      prepareWorkspace: async (input) => prepareWorkspace(input),
      profile: { label: "test", modelID: "model", providerID: "provider" },
    });
    const input = {
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      stage: "repo-preparation",
      taskPrompt: "task",
      toolScope: "repo-preparation",
      workspace,
    };

    await expect(runner.run(input)).rejects.toThrow("setup failed");
    await expect(runner.run({ ...input, attempt: 2 })).resolves.toMatchObject({
      exitCode: 0,
    });

    expect(prepareWorkspace).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
  });
});
