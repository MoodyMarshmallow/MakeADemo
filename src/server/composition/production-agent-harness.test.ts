import { describe, expect, it, vi } from "vitest";

import type { AgentSessionRunner } from "../agent-harness/agent-session-runner.interface";
import { createProductionAgentHarness } from "./production-agent-harness";
import { resolveProductionAgentModelConfig } from "./production-agent-model-config";

describe("createProductionAgentHarness", () => {
  it("assembles explicit Pipeline agent dependencies without starting network work", () => {
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
        daytonaApiKey: "test-daytona-api-key",
        openaiApiKey: "test-openai-api-key",
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(harness.repoPreparationAgent).toBeDefined();
      expect(harness.repoSecurityProvider).toBeDefined();
      expect(harness.scriptGenerationAgent).toBeDefined();
      expect(harness.capturePathRepairer).toBeDefined();
      expect(harness.preCaptureDependencies.repairCapturePathFailure).toEqual(
        expect.any(Function),
      );
      expect(harness.reviewDraftComposite).toEqual(expect.any(Function));
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
      daytonaApiKey: "test-daytona-api-key",
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
      daytonaApiKey: "test-daytona-api-key",
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
      daytonaApiKey: "test-daytona-api-key",
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
});
