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
        providerSecretName: "OPENAI_API_KEY",
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

  it("binds Repo Preparation permissions separately from other agent tasks and routes output by task", async () => {
    const calls: Array<{
      dangerouslySkipPermissions?: boolean;
      profile: { label: string };
    }> = [];
    const repoOutput: string[] = [];
    const sharedOutput: string[] = [];
    const agentSessionRunner: AgentSessionRunner = {
      async run(input) {
        calls.push({
          ...(input.dangerouslySkipPermissions === undefined
            ? {}
            : { dangerouslySkipPermissions: input.dangerouslySkipPermissions }),
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
      providerSecretName: "OPENAI_API_KEY",
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

    expect(calls).toEqual([
      {
        dangerouslySkipPermissions: false,
        profile: { label: "Repo Preparation" },
      },
      {
        dangerouslySkipPermissions: true,
        profile: { label: "Script Generation agent" },
      },
      {
        dangerouslySkipPermissions: true,
        profile: { label: "Capture Path repair agent" },
      },
      {
        dangerouslySkipPermissions: true,
        profile: { label: "Draft Composite review agent" },
      },
    ]);
    expect(repoOutput).toEqual(["provider output"]);
    expect(sharedOutput).toEqual([
      "provider output",
      "provider output",
      "provider output",
    ]);
  });
});
