import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { screenRepoSecurity } from "../../02-repo-security-screen/repo-security-screen";
import { formatFullPipelineFailure } from "../cli/full-pipeline-failure-output";
import { FullPipelineStageFailure } from "./full-pipeline-runner";
import { PipelineCancellationError } from "./pipeline-cancellation";
import { createMakeADemoPipeline } from "./pipeline-controller";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

describe("MakeADemo Pipeline controller", () => {
  it("loads Repo Security Screen input before it runs a Pipeline Job", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-controller-"));
    const load = vi.fn(async () => ({
      files: [],
      repoStats: { fileCount: 0, sizeBytes: 0 },
    }));
    const dispose = vi.fn(async () => undefined);
    const pipeline = createMakeADemoPipeline({
      dispose,
      pipelineDependencies: rejectingPipelineDependencies(),
      repoSecurityInputLoader: { load },
    });

    try {
      await expect(
        pipeline.run({
          demoBrief: { keyProductFeatures: ["controller seam"] },
          normalizedSupportingDocuments: [],
          repoUrl: "https://github.com/example/controller-seam",
          runOptions: { outputRoot },
          workspaceId: "workspace-controller-seam",
        }),
      ).rejects.toMatchObject({ status: "security-rejected" });

      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: "https://github.com/example/controller-seam",
          shouldReadText: expect.any(Function),
        }),
      );

      await pipeline.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("materializes a cancelled Pipeline Job without opening a Repo Security workspace", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-controller-"));
    const load = vi.fn();
    const cancellation = new AbortController();
    cancellation.abort();
    const pipeline = createMakeADemoPipeline({
      pipelineDependencies: rejectingPipelineDependencies(),
      repoSecurityInputLoader: { load },
    });

    try {
      await expect(
        pipeline.run({
          demoBrief: { keyProductFeatures: ["controller cancellation"] },
          normalizedSupportingDocuments: [],
          repoUrl: "https://github.com/example/controller-cancellation",
          runOptions: { outputRoot, signal: cancellation.signal },
          workspaceId: "workspace-controller-cancellation",
        }),
      ).rejects.toMatchObject({ status: "cancelled" });

      expect(load).not.toHaveBeenCalled();
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("materializes cancellation that arrives while Repo Security input is loading", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-controller-"));
    const cancellation = new AbortController();
    const load = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const pipeline = createMakeADemoPipeline({
      pipelineDependencies: rejectingPipelineDependencies(),
      repoSecurityInputLoader: { load },
    });

    try {
      const running = pipeline.run({
        demoBrief: { keyProductFeatures: ["loading cancellation"] },
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/loading-cancellation",
        runOptions: {
          outputRoot,
          runId: "cancelled-during-repo-security",
          signal: cancellation.signal,
        },
        workspaceId: "workspace-loading-cancellation",
      });
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      cancellation.abort(new PipelineCancellationError("signal"));

      const failure = await running.catch((error: unknown) => error);
      if (!(failure instanceof FullPipelineStageFailure)) {
        throw failure;
      }
      expect(failure).toMatchObject({
        resultPath: join(
          outputRoot,
          "cancelled-during-repo-security",
          "full-pipeline-result.json",
        ),
        status: "cancelled",
      });
      await expect(
        readFile(failure.resultPath, "utf8").then(JSON.parse),
      ).resolves.toMatchObject({
        cancellation: { reason: "signal" },
        status: "cancelled",
      });
      expect(formatFullPipelineFailure(failure)).toContain(
        `Result JSON: ${failure.resultPath}`,
      );
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("materializes Repo Security loading infrastructure failures as durable terminal results", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-controller-"));
    const pipeline = createMakeADemoPipeline({
      pipelineDependencies: rejectingPipelineDependencies(),
      repoSecurityInputLoader: {
        async load() {
          throw new Error("provider connection refused");
        },
      },
      sandboxProvider: "railway",
    });

    try {
      const failure = await pipeline
        .run({
          demoBrief: { keyProductFeatures: ["loading failure"] },
          normalizedSupportingDocuments: [],
          repoUrl: "https://github.com/example/loading-failure",
          runOptions: {
            outputRoot,
            runId: "failed-during-repo-security",
          },
          workspaceId: "workspace-loading-failure",
        })
        .catch((error: unknown) => error);
      if (!(failure instanceof FullPipelineStageFailure)) {
        throw failure;
      }

      expect(failure).toMatchObject({
        stage: "repo-security-screen",
        status: "security-rejected",
      });
      await expect(
        readFile(failure.resultPath, "utf8").then(JSON.parse),
      ).resolves.toMatchObject({
        failure: {
          blockers: [
            "Repo Security Screen input could not be loaded because sandbox infrastructure was unavailable.",
          ],
        },
        sandboxProvider: "railway",
        status: "security-rejected",
      });
      const terminalOutput = formatFullPipelineFailure(failure);
      expect(terminalOutput).toContain(`Result JSON: ${failure.resultPath}`);
      expect(terminalOutput).not.toContain("provider connection refused");
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});

function rejectingPipelineDependencies(): PipelineOrchestratorDependencies {
  return {
    async generateDemoScript() {
      throw new Error("Pipeline must stop at Repo Security Screen.");
    },
    async prepareRepo() {
      throw new Error("Pipeline must stop at Repo Security Screen.");
    },
    screenRepoSecurity,
    async validateCapturePath() {
      throw new Error("Pipeline must stop at Repo Security Screen.");
    },
  };
}
