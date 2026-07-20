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

  it("keeps provider settings in the bound runner and emits semantic output events", async () => {
    const run = vi.fn(async (input): Promise<AgentSessionRunResult> => {
      input.onStdout?.("provider text");
      return {
        exitCode: 0,
        latestToolName: "submit-preparation",
        stderr: "",
        stdout: "",
      };
    });
    const auditEvents: unknown[] = [];
    const runner = bindAgentTaskRunner({ run } as never, {
      onEvent: (event) => auditEvents.push(event),
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
        { channel: "standard", kind: "output", length: 13 },
        expect.objectContaining({ event: "agent-task.started", kind: "audit" }),
        expect.objectContaining({
          event: "agent-task.finished",
          kind: "audit",
        }),
        expect.objectContaining({
          event: "agent-task.tool-used",
          kind: "audit",
          metadata: { tool: "submit-preparation" },
        }),
      ]),
    );
    expect(auditEvents).toEqual(result.events);
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
