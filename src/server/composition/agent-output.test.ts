import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentTaskEvent } from "../agent-harness/agent-session-runner.interface";
import { createAgentOutputRouter } from "./agent-output";

describe("createAgentOutputRouter", () => {
  it("surfaces audit persistence failures when closing", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "makeademo-output-"));
    const runDirectory = join(tempDirectory, "run-directory-file");
    await writeFile(runDirectory, "not a directory");
    const router = createAgentOutputRouter({
      runDirectory,
      writeDiagnostic: () => undefined,
      writeStandard: () => undefined,
    });

    router.agentTasks.onEvent({
      event: "agent-task.started",
      kind: "audit",
    });

    await expect(router.close()).rejects.toMatchObject({
      code: expect.stringMatching(/EEXIST|ENOTDIR/),
    });
  });

  it("routes semantic output while preserving task-scoped audit logs", async () => {
    const runDirectory = await mkdtemp(join(tmpdir(), "makeademo-output-"));
    const standard: string[] = [];
    const diagnostic: string[] = [];
    const router = createAgentOutputRouter({
      runDirectory,
      writeDiagnostic: (chunk) => diagnostic.push(chunk),
      writeStandard: (text) => standard.push(text),
    });

    router.repoPreparation.onStandard("repo\n");
    router.agentTasks.onDiagnostic("warning\n");
    router.agentTasks.onStandard("script\n");
    const providerReasoning = "inspect the package before editing";
    router.agentTasks.onStandard(providerReasoning);
    const taskEvent: AgentTaskEvent = {
      event: "agent-task.tool-used",
      kind: "audit",
      metadata: {
        modelID: "gpt-5.6-terra",
        stage: "script-generation",
        tool: "read",
      },
    };
    router.agentTasks.onEvent(taskEvent);
    router.agentTasks.onEvent({
      channel: "standard",
      content: "script\n",
      kind: "output",
      length: "script\n".length,
      outputType: "assistant",
    });
    router.agentTasks.onEvent({
      channel: "diagnostic",
      content: "warning\n",
      kind: "output",
      length: "warning\n".length,
      outputType: "diagnostic",
    });
    router.agentTasks.onEvent({
      channel: "standard",
      content: providerReasoning,
      kind: "output",
      length: providerReasoning.length,
      outputType: "reasoning",
    });
    router.agentTasks.onEvent({
      channel: "standard",
      content: toolOutput,
      kind: "output",
      length: toolOutput.length,
      outputType: "tool",
    });
    router.agentTasks.onEvent({
      event: "agent-task.provider-retry",
      kind: "audit",
      metadata: {
        appliedDelayMs: 2_000,
        attempt: 1,
        capped: false,
        cumulativeDelayMs: 2_000,
        delayMs: 2_000,
        maxAttempts: 3,
        reason: "rate-limit",
        requestedDelayMs: 2_000,
      },
    });
    await router.close();

    expect(standard).toEqual(["repo\n", "script\n", providerReasoning]);
    expect(diagnostic).toEqual(["warning\n"]);
    const primaryLog = await readFile(router.primaryAuditLogPath, "utf8");
    const scriptLog = await readFile(
      router.scriptGenerationAuditLogPath,
      "utf8",
    );
    expect(primaryLog).toContain('"eventType":"agent-output.chunk"');
    expect(primaryLog).toContain(`"length":${providerReasoning.length}`);
    expect(readOutputTypes(primaryLog)).toEqual([
      "assistant",
      "diagnostic",
      "reasoning",
      "tool",
    ]);
    expect(readOutputTypes(scriptLog)).toEqual([
      "assistant",
      "diagnostic",
      "reasoning",
      "tool",
    ]);
    expect(scriptLog).toContain(providerReasoning);
    expect(scriptLog).toContain('"content":"script\\n"');
    expect(scriptLog).toContain('"outputType":"assistant"');
    expect(scriptLog).toContain('"content":"warning\\n"');
    expect(scriptLog).toContain('"outputType":"diagnostic"');
    expect(scriptLog).toContain('"outputType":"reasoning"');
    expect(scriptLog).toContain("[agent tool] read completed");
    expect(scriptLog).not.toContain("package.json");
    expect(scriptLog).not.toContain("package contents");
    expect(scriptLog).toContain('"outputType":"tool"');
    expect(scriptLog).toContain('"eventType":"agent-task.tool-used"');
    expect(scriptLog).toContain('"tool":"read"');
    expect(primaryLog).toContain('"source":"agent-harness"');
    expect(primaryLog).toContain('"eventType":"agent-task.provider-retry"');
    expect(primaryLog).toContain('"level":"warn"');
    const retryWarning = primaryLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.eventType === "agent-task.provider-retry");
    expect(retryWarning).toMatchObject({
      eventType: "agent-task.provider-retry",
      level: "warn",
      metadata: {
        appliedDelayMs: 2_000,
        capped: false,
        reason: "rate-limit",
      },
    });
    expect(JSON.stringify(retryWarning)).not.toMatch(
      /org_|https?:|credential|token/i,
    );
  });
});

const toolOutput = "\n[agent tool] read completed\n";

function readOutputTypes(log: string): unknown[] {
  return log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.eventType === "agent-output.chunk")
    .map((entry) => entry.outputType);
}
