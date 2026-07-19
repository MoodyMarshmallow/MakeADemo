import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAgentOutputRouter } from "./agent-output";

describe("createAgentOutputRouter", () => {
  it("routes decoded standard output while preserving task-scoped audit logs", async () => {
    const runDirectory = await mkdtemp(join(tmpdir(), "makeademo-output-"));
    const standard: string[] = [];
    const diagnostic: string[] = [];
    const router = createAgentOutputRouter({
      runDirectory,
      writeDiagnostic: (chunk) => diagnostic.push(chunk),
      writeStandard: (text) => standard.push(text),
    });

    router.repoPreparation.onStandard('{"type":"text","text":"repo"}\n');
    router.agentTasks.onDiagnostic("warning\n");
    router.agentTasks.onStandard('{"type":"text","text":"script"}\n');
    await router.close();

    expect(standard).toEqual(["repo\n", "script\n"]);
    expect(diagnostic).toEqual(["warning\n"]);
    const primaryLog = await readFile(router.primaryAuditLogPath, "utf8");
    const scriptLog = await readFile(
      router.scriptGenerationAuditLogPath,
      "utf8",
    );
    expect(primaryLog).toContain('"raw":"warning"');
    expect(scriptLog).toContain('"raw":"warning"');
    expect(scriptLog).toContain(
      '"raw":"{\\"type\\":\\"text\\",\\"text\\":\\"script\\"}"',
    );
    expect(scriptLog).not.toContain(
      '"raw":"{\\"type\\":\\"text\\",\\"text\\":\\"repo\\"}"',
    );
  });
});
