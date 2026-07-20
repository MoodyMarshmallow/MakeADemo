import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentTaskEvent } from "../agent-harness/agent-session-runner.interface";
import { createAgentOutputRouter } from "./agent-output";

describe("createAgentOutputRouter", () => {
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
    const privateReasoning = "private reasoning must not be persisted";
    router.agentTasks.onStandard(privateReasoning);
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
      kind: "output",
      length: privateReasoning.length,
    });
    await router.close();

    expect(standard).toEqual(["repo\n", "script\n", privateReasoning]);
    expect(diagnostic).toEqual(["warning\n"]);
    const primaryLog = await readFile(router.primaryAuditLogPath, "utf8");
    const scriptLog = await readFile(
      router.scriptGenerationAuditLogPath,
      "utf8",
    );
    expect(primaryLog).toContain('"eventType":"agent-output.chunk"');
    expect(primaryLog).toContain(`"length":${privateReasoning.length}`);
    expect(primaryLog).not.toContain('"length":7');
    expect(primaryLog).not.toContain('"length":8');
    expect(scriptLog).not.toContain('"length":6');
    expect(scriptLog).not.toContain('"raw"');
    expect(scriptLog).not.toContain(privateReasoning);
    expect(scriptLog).toContain('"eventType":"agent-task.tool-used"');
    expect(scriptLog).toContain('"tool":"read"');
    expect(primaryLog).toContain('"source":"agent-harness"');
  });
});
