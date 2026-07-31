import { describe, expect, it, vi } from "vitest";

import type {
  AgentSessionRunner,
  AgentTaskEvent,
} from "../agent-harness/agent-session-runner.interface";
import { createProductionAgentHarness } from "./production-agent-harness";
import { resolveProductionAgentModelConfig } from "./production-agent-model-config";

describe("createProductionAgentHarness", () => {
  it("assembles only Agent Harness runners and session cleanup without starting network work", () => {
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn(() => {
      throw new Error("Harness construction must not make a network request.");
    });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    try {
      const harness = createProductionAgentHarness({
        agentModel: resolveProductionAgentModelConfig({
          modelID: "gpt-5.6",
          providerID: "openai",
        }),
        openaiApiKey: "test-openai-api-key",
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(Object.keys(harness).sort()).toEqual([
        "agentTaskRunners",
        "disposeAgentSessions",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("binds agent profiles and routes output by task", async () => {
    const calls: Array<{ profile: { label: string } }> = [];
    const repoOutput: string[] = [];
    const sharedOutput: string[] = [];
    const dispose = vi.fn(async () => undefined);
    const agentSessionRunner: AgentSessionRunner = {
      dispose,
      async run(input) {
        calls.push({
          profile: { label: input.profile.label },
        });
        input.onStdout?.("provider output");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const harness = createProductionAgentHarness({
      agentSessionRunner,
      agentModel: resolveProductionAgentModelConfig({
        modelID: "gpt-5.6",
        providerID: "openai",
      }),
      onAgentStandard: (chunk) => sharedOutput.push(chunk),
      onRepoPreparationStandard: (chunk) => repoOutput.push(chunk),
    });

    const taskInput = {
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      stage: "test",
      taskPrompt: "task",
      workspace: {} as never,
    };
    await harness.agentTaskRunners.repoPreparation.run(taskInput);
    await harness.agentTaskRunners.scriptGeneration.run(taskInput);
    await harness.agentTaskRunners.capturePathRepair.run(taskInput);
    await harness.agentTaskRunners.draftCompositeReview.run(taskInput);
    await harness.disposeAgentSessions();

    expect(calls).toEqual([
      {
        profile: { label: "Repo Preparation" },
      },
      {
        profile: { label: "Script Generation agent" },
      },
      {
        profile: { label: "Capture Path repair agent" },
      },
      {
        profile: { label: "Draft Composite review agent" },
      },
    ]);
    expect(repoOutput).toEqual(["provider output"]);
    expect(sharedOutput).toEqual([
      "provider output",
      "provider output",
      "provider output",
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("classifies provider credential failures for every production task runner", async () => {
    const agentSessionRunner: AgentSessionRunner = {
      async run() {
        return {
          exitCode: 1,
          providerError: "401 Unauthorized",
          stderr: "",
          stdout: "",
        };
      },
    };
    const harness = createProductionAgentHarness({
      agentSessionRunner,
      agentModel: resolveProductionAgentModelConfig({
        modelID: "gpt-5.6",
        providerID: "openai",
      }),
    });
    const taskInput = {
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      stage: "test",
      taskPrompt: "task",
      workspace: {} as never,
    };

    for (const runner of Object.values(harness.agentTaskRunners)) {
      await expect(runner.run(taskInput)).resolves.toMatchObject({
        failure: { category: "provider-auth-invalid" },
      });
    }
  });

  it("keeps unrelated provider failures generic for every production task runner", async () => {
    const agentSessionRunner: AgentSessionRunner = {
      async run() {
        return {
          exitCode: 1,
          providerError: "rate limit exceeded",
          stderr: "",
          stdout: "",
        };
      },
    };
    const harness = createProductionAgentHarness({
      agentSessionRunner,
      agentModel: resolveProductionAgentModelConfig({
        modelID: "gpt-5.6",
        providerID: "openai",
      }),
    });
    const taskInput = {
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      stage: "test",
      taskPrompt: "task",
      workspace: {} as never,
    };

    for (const runner of Object.values(harness.agentTaskRunners)) {
      await expect(runner.run(taskInput)).resolves.toMatchObject({
        failure: { category: "provider" },
      });
    }
  });

  it("warns the production logger about provider retries without replacing the caller event sink", async () => {
    const events: AgentTaskEvent[] = [];
    const warn = vi.fn(async () => undefined);
    const agentSessionRunner: AgentSessionRunner = {
      async run(input) {
        input.onAudit?.("agent-task.provider-retry", {
          appliedDelayMs: 2_000,
          providerError: "do-not-log-this",
          reason: "rate-limit",
        });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const harness = createProductionAgentHarness({
      agentModel: resolveProductionAgentModelConfig({
        modelID: "gpt-5.6",
        providerID: "openai",
      }),
      agentSessionRunner,
      logger: { warn },
      onAgentEvent: (event) => events.push(event),
    });

    await harness.agentTaskRunners.scriptGeneration.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 1_000,
      hardTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
      stage: "script-generation",
      taskPrompt: "task",
      workspace: {} as never,
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "agent-task.provider-retry",
          kind: "audit",
        }),
      ]),
    );
    expect(warn).toHaveBeenCalledWith(
      {
        event: "agent-task.provider-retry",
        metadata: { appliedDelayMs: 2_000, reason: "rate-limit" },
      },
      "Agent provider retry extended its hard deadline.",
    );
  });
});
