import { describe, expect, it, vi } from "vitest";

import type { AgentSessionRunResult } from "./agent-session-runner.interface";
import { AgentSessionTimeoutError } from "./agent-session-timeout";
import { bindAgentTaskRunner } from "./bind-agent-task-runner";
import { classifyProviderFailure } from "./provider-failure-classifier";

describe("bindAgentTaskRunner", () => {
  it.each([
    "401 Unauthorized",
    "invalid API key",
    "The API key is incorrect",
    "authentication failed",
  ])("classifies provider credential rejection: %s", (providerError) => {
    expect(classifyProviderFailure(providerError)).toBe(
      "provider-auth-invalid",
    );
  });

  it.each([
    "rate limit exceeded",
    "temporary upstream failure",
    "request timed out",
  ])("keeps unrelated provider failures generic: %s", (providerError) => {
    expect(classifyProviderFailure(providerError)).toBe("provider");
  });
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
          profile: {
            label: "test",
            modelID: "model",
            providerID: "provider",
            thinkingLevel: "medium",
          },
        },
      );

      const result = await runner.run(taskInput());

      expect(result.failure?.category).toBe(category);
    },
  );

  it("forwards provider hard-deadline extensions through the task seam", async () => {
    const extension = {
      appliedExtensionMs: 2_000,
      hardDeadlineAt: Date.now() + 3_000,
    };
    const run = vi.fn(async (input) => {
      input.onHardDeadlineExtended?.(extension);
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    const onHardDeadlineExtended = vi.fn();
    const runner = bindAgentTaskRunner({ run } as never, {
      profile: {
        label: "test",
        modelID: "model",
        providerID: "provider",
        thinkingLevel: "medium",
      },
    });

    await runner.run({ ...taskInput(), onHardDeadlineExtended });

    expect(onHardDeadlineExtended).toHaveBeenCalledWith(extension);
  });

  it("keeps provider settings in the bound runner and emits semantic output events", async () => {
    const run = vi.fn(async (input): Promise<AgentSessionRunResult> => {
      input.onStdout?.("provider text");
      input.onReasoning?.("inspect the package before editing");
      input.onToolExecution?.({
        args: { path: "package.json" },
        isError: false,
        name: "read",
        status: "started",
      });
      input.onToolExecution?.({
        args: { path: "package.json" },
        isError: false,
        name: "read",
        result: { content: "package contents" },
        status: "completed",
      });
      return {
        exitCode: 0,
        latestToolName: "submit-preparation",
        stderr: "",
        stdout: "",
      };
    });
    const auditEvents: unknown[] = [];
    const outputEvents: unknown[] = [];
    const runner = bindAgentTaskRunner({ run } as never, {
      onEvent: (event) => auditEvents.push(event),
      onOutput: (event) => outputEvents.push(event),
      profile: {
        label: "Script Generation",
        modelID: "model",
        providerID: "provider",
        thinkingLevel: "high",
      },
    });

    const result = await runner.run(taskInput());

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          modelID: "model",
          providerID: "provider",
        }),
      }),
    );
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "standard",
          content: "provider text",
          kind: "output",
          outputType: "assistant",
        }),
        expect.objectContaining({
          content: expect.stringContaining(
            "inspect the package before editing",
          ),
          kind: "output",
          outputType: "reasoning",
        }),
        expect.objectContaining({
          content: expect.stringContaining("[agent tool] read started"),
          kind: "output",
          outputType: "tool",
        }),
        expect.objectContaining({
          content: expect.stringContaining("[agent tool] read completed"),
          kind: "output",
          outputType: "tool",
        }),
        expect.objectContaining({ event: "agent-task.started", kind: "audit" }),
        expect.objectContaining({
          event: "agent-task.finished",
          kind: "audit",
        }),
        expect.objectContaining({
          event: "agent-task.tool-started",
          kind: "audit",
          metadata: expect.objectContaining({ tool: "read" }),
        }),
        expect.objectContaining({
          event: "agent-task.tool-completed",
          kind: "audit",
          metadata: expect.objectContaining({ tool: "read" }),
        }),
      ]),
    );
    expect(auditEvents).toEqual(result.events);
    expect(result.events?.map(eventLabel)).toEqual([
      "agent-task.started",
      "output:assistant:standard",
      "output:reasoning:standard",
      "agent-task.tool-started",
      "output:tool:standard",
      "agent-task.tool-completed",
      "output:tool:standard",
      "agent-task.tool-used",
      "agent-task.finished",
    ]);
    expect(outputEvents).toHaveLength(4);
    expect(outputEvents).toEqual([
      expect.objectContaining({
        message: "provider text",
        outputType: "assistant",
      }),
      expect.objectContaining({ outputType: "reasoning" }),
      expect.objectContaining({ outputType: "tool" }),
      expect.objectContaining({ outputType: "tool" }),
    ]);
    expect(JSON.stringify(outputEvents)).not.toContain("package.json");
    expect(JSON.stringify(outputEvents)).not.toContain("package contents");
  });

  it("normalizes Agent Harness timeouts as task failures", async () => {
    const runner = bindAgentTaskRunner(
      {
        run: async () => {
          throw new AgentSessionTimeoutError(
            {
              activity: { read: () => undefined },
              hardTimeoutMs: 1_000,
              inactivityTimeoutMs: 100,
              label: "test",
            },
            "inactivity",
          );
        },
      } as never,
      {
        profile: {
          label: "test",
          modelID: "model",
          providerID: "provider",
          thinkingLevel: "medium",
        },
      },
    );

    await expect(runner.run(taskInput())).resolves.toMatchObject({
      exitCode: -1,
      failure: { category: "timeout", message: expect.any(String) },
    });
  });

  it("logs tool identity without inspecting arguments or results", async () => {
    const cyclicArgs: Record<string, unknown> = {};
    cyclicArgs.self = cyclicArgs;
    cyclicArgs.privateArgument = "private argument";
    const customInspector = vi.fn(() => {
      throw new Error("formatter exploded");
    });
    const uninspectableResult = {
      privateResult: "private result",
      [Symbol.for("nodejs.util.inspect.custom")]: customInspector,
    };
    const output: string[] = [];
    const runner = bindAgentTaskRunner(
      {
        run: async (input) => {
          input.onToolExecution?.({
            args: cyclicArgs,
            isError: false,
            name: "read",
            status: "started",
          });
          input.onToolExecution?.({
            args: cyclicArgs,
            isError: false,
            name: "read",
            result: uninspectableResult,
            status: "completed",
          });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
      {
        onOutput: (event) => output.push(event.message),
        profile: {
          label: "test",
          modelID: "model",
          providerID: "provider",
          thinkingLevel: "medium",
        },
      },
    );

    await expect(runner.run(taskInput())).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(output).toEqual([
      "\n[agent tool] read started\n",
      "\n[agent tool] read completed\n",
    ]);
    expect(output.join("\n")).not.toContain("private argument");
    expect(output.join("\n")).not.toContain("private result");
    expect(customInspector).not.toHaveBeenCalled();
  });
});

function taskInput() {
  return {
    attempt: 1,
    hardDeadlineAt: Date.now() + 1_000,
    hardTimeoutMs: 1_000,
    inactivityTimeoutMs: 1_000,
    stage: "test",
    taskPrompt: "task",
    workspace: {} as never,
  };
}

function eventLabel(event: unknown): string {
  if (typeof event !== "object" || event === null) return "unknown";
  if ("event" in event && typeof event.event === "string") return event.event;
  if (
    "kind" in event &&
    event.kind === "output" &&
    "outputType" in event &&
    "channel" in event
  ) {
    return `output:${String(event.outputType)}:${String(event.channel)}`;
  }
  return String("kind" in event ? event.kind : "unknown");
}
