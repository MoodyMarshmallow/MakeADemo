import { describe, expect, it, vi } from "vitest";

import type { AgentSessionRunner } from "../agent-harness/agent-session-runner.interface";
import { runPipelineJob } from "../pipeline/00-orchestration/job/pipeline-orchestrator";
import type { PreparationWorkspaceHandle } from "../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { RepoPreparationAgent } from "../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { submittedCodeKnownGoodNodeReleaseCatalog } from "../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { parseDemoScript } from "../pipeline/04-script-generation/demo-script/demo-script.schema";
import type { ScriptGenerationAgent } from "../pipeline/04-script-generation/script-generation-agent.interface";
import type { CapturePathRepairer } from "../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import type { BrowserValidator } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/browser-validator.interface";
import type { SandboxRunner } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/sandbox-runner.interface";
import { resolveProductionAgentModelConfig } from "./production-agent-model-config";
import {
  createDaytonaFreshCaptureStatePreparer,
  createProductionPipeline,
  createProductionPipelineDependencies,
} from "./production-pipeline";

describe("production Pipeline assembly", () => {
  it("assembles the full Pipeline surface around injected Agent Harness runners without network work", async () => {
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn(() => {
      throw new Error(
        "Production Pipeline construction must not make a network request.",
      );
    });
    const dispose = vi.fn(async () => undefined);
    const agentSessionRunner: AgentSessionRunner = {
      dispose,
      async run() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    try {
      const pipeline = createProductionPipeline({
        agentModel: resolveProductionAgentModelConfig({
          modelID: "gpt-5.6",
          providerID: "openai",
        }),
        agentSessionRunner,
        daytonaApiKey: "test-daytona-api-key",
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(Object.keys(pipeline).sort()).toEqual([
        "disposeAgentSessions",
        "pipelineDependencies",
        "prepareFreshCaptureState",
        "repoSecurityInputLoader",
        "reviewDraftComposite",
      ]);
      expect(pipeline.pipelineDependencies).toMatchObject({
        generateDemoScript: expect.any(Function),
        prepareRepo: expect.any(Function),
        screenRepoSecurity: expect.any(Function),
        validateCapturePath: expect.any(Function),
      });
      expect(pipeline.prepareFreshCaptureState).toEqual(expect.any(Function));
      expect(pipeline.repoSecurityInputLoader).toBeDefined();
      expect(pipeline.reviewDraftComposite).toEqual(expect.any(Function));

      await pipeline.disposeAgentSessions();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs Repo Preparation, Script Generation, and Capture Path Validation through the Pipeline Job", async () => {
    const repoPreparationAgent: RepoPreparationAgent = {
      async prepare() {
        return {
          baselineSourceControlledPaths: ["src/App.tsx"],
          manifest: preparationManifest(),
          status: "succeeded",
          workspace: preparationWorkspaceHandle(),
        };
      },
    };
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          logs: ["demo running"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return {
          interactable: true,
          logs: ["browser loaded"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }, { path: "bun.lock" }],
          repoStats: { fileCount: 2, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      createProductionPipelineDependencies({
        browserValidator,
        nodeReleaseCatalog: submittedCodeKnownGoodNodeReleaseCatalog,
        repoPreparationAgent,
        sandboxRunner,
        sceneValidator: {
          async validateScene() {
            return {
              logs: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene-validation"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene-validation"}',
                "scene dry run passed",
              ],
              status: "succeeded",
            };
          },
        },
      }),
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(parseDemoScript(result.demoScript).scriptId).toBe(
        "generated-makeademo-script",
      );
      expect(result.demoScript.scenes[0]).toMatchObject({
        expectedVisibleOutcome: "The validation result is visible.",
        humanReadableDescription: "Demonstrate validation.",
        id: "scene-validation",
      });
    }
  });

  it("supplies a fresh deterministic state before Footage Capture", async () => {
    const preparationWorkspace = preparationWorkspaceHandle();
    const prepareFreshCaptureState = createDaytonaFreshCaptureStatePreparer(
      async ({
        preparationManifest: manifest,
        preparationWorkspace: workspace,
      }) => {
        expect(manifest).toEqual(preparationManifest());
        expect(workspace).toBe(preparationWorkspace);
        return { browserUrl: "https://fresh-preview.example.test/" };
      },
    );

    await expect(
      prepareFreshCaptureState({
        attempt: 1,
        browserUrl: "https://preview.example.test/",
        preparedDemo: succeededPreparedDemo(preparationWorkspace),
      }),
    ).resolves.toEqual({ browserUrl: "https://fresh-preview.example.test/" });
  });

  it("makes Capture Path repair available to the Pipeline Job", async () => {
    const scriptGenerationAgent: ScriptGenerationAgent = {
      async generateDemoScript() {
        return createDemoScript("script_initial");
      },
    };
    const capturePathRepairer: CapturePathRepairer = {
      async repairCapturePathFailure(input) {
        return {
          preparationManifest: input.preparationManifest,
          demoScript: createDemoScript("script_repaired"),
        };
      },
    };

    const dependencies = createProductionPipelineDependencies({
      nodeReleaseCatalog: submittedCodeKnownGoodNodeReleaseCatalog,
      repoPreparationAgent: {
        async prepare() {
          throw new Error("not used");
        },
      },
      sandboxRunner: {
        async runValidation() {
          throw new Error("not used");
        },
      },
      capturePathRepairer,
      scriptGenerationAgent,
    });

    await expect(
      dependencies.repairCapturePathFailure?.({
        attempt: 1,
        failure: {
          blockedNetworkAttempts: [],
          failedSceneId: "scene_feed",
          failureReason: "Missing button",
          logs: ["locator failed"],
          status: "failed",
          warnings: [],
        },
        preparationManifest: preparationManifest(),
        repoUrl: "https://github.com/example/app",
        demoScript: createDemoScript("script_initial"),
      }),
    ).resolves.toMatchObject({
      demoScript: { scriptId: "script_repaired" },
    });
  });
});

function preparationManifest() {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    nativeVisibleInterface: {
      nativeStartupAttempts: ["npm run dev"],
      sourceControlledUiPaths: ["src/App.tsx"],
    },
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId: "workspace_123",
  };
}

function preparationWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async execute(command) {
        if (command === "makeademo-inspect-submitted-code-toolchain") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              candidates: [
                {
                  files: {
                    "package.json": JSON.stringify({
                      engines: { node: "22" },
                      packageManager: "pnpm@11.13.0",
                    }),
                    "pnpm-lock.yaml": "",
                  },
                  projectRoot: ".",
                },
              ],
            }),
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async uploadFiles() {},
    },
  };
}

function succeededPreparedDemo(
  preparationWorkspace: PreparationWorkspaceHandle,
) {
  const demoScript = createDemoScript("script_test");

  return {
    demoScript,
    capturePathValidation: {
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test/",
      logs: [],
      status: "succeeded" as const,
      warnings: [],
    },
    preparationManifest: preparationManifest(),
    preparationWorkspace,
    status: "succeeded" as const,
  };
}

function createDemoScript(scriptId: string) {
  return {
    demoPlaywrightScript:
      "await scene('scene_validation', async () => { await page.goto(baseUrl); });",
    format: "16:9" as const,
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Validation is visible.",
        humanReadableDescription: "Show validation.",
        id: "scene_validation",
      },
    ],
    scriptId,
    title: "Demo",
    version: 1,
  };
}
