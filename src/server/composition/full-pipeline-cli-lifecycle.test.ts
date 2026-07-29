import { describe, expect, it } from "vitest";

import { PipelineCancellationError } from "../pipeline/00-orchestration/job/pipeline-cancellation";
import {
  addSandboxProviderToTerminalOutput,
  finalizeFullPipelineCli,
  runFullPipelineCliOperation,
} from "./full-pipeline-cli-lifecycle";

describe("full pipeline CLI lifecycle", () => {
  it.each(["succeeded", "failed", "cancelled"])(
    "includes the selected sandbox provider in %s terminal output",
    (status) => {
      const output = addSandboxProviderToTerminalOutput({
        output: `Pipeline ${status}\nResult JSON: /runs/${status}.json\n`,
        sandboxProvider: "railway",
      });

      expect(output).toContain("Sandbox provider: railway");
      expect(output).toContain(`Pipeline ${status}`);
      expect(output.match(/Result JSON:/g)).toHaveLength(1);
    },
  );

  it("emits one Result JSON marker only after output and agent disposal complete", async () => {
    const events: string[] = [];

    await finalizeFullPipelineCli({
      cleanup: async () => {
        events.push("cleanup-started");
        await Promise.resolve();
        events.push("cleanup-finished");
      },
      removeSignalHandlers: () => events.push("handlers-removed"),
      terminalOutput: "Pipeline cancelled\nResult JSON: /runs/result.json\n",
      write: (output) => events.push(`output:${output}`),
    });

    expect(events).toEqual([
      "cleanup-started",
      "cleanup-finished",
      "handlers-removed",
      "output:Pipeline cancelled\nResult JSON: /runs/result.json\n",
    ]);
    expect(events.join("\n").match(/Result JSON:/g)).toHaveLength(1);
  });

  it("materializes pre-Pipeline cancellation after input workspace release and emits its marker after CLI cleanup", async () => {
    const events: string[] = [];
    const terminalOutput = await runFullPipelineCliOperation({
      async materializeCancellation() {
        events.push("cancelled-result-written");
        return "Pipeline cancelled\nResult JSON: /runs/cancelled.json\n";
      },
      async prepare() {
        events.push("input-workspace-released");
        throw new PipelineCancellationError("deadline-exceeded");
      },
      async run() {
        throw new Error("Pipeline must not start with loaded input.");
      },
    });
    await finalizeFullPipelineCli({
      cleanup: async () => {
        events.push("cli-cleanup");
      },
      removeSignalHandlers: () => events.push("handlers-removed"),
      terminalOutput,
      write: (output) => events.push(`output:${output}`),
    });

    expect(events).toEqual([
      "input-workspace-released",
      "cancelled-result-written",
      "cli-cleanup",
      "handlers-removed",
      "output:Pipeline cancelled\nResult JSON: /runs/cancelled.json\n",
    ]);
    expect(events.join("\n").match(/Result JSON:/g)).toHaveLength(1);
  });
});
