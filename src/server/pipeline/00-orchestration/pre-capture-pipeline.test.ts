import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { RepoPreparationAgent } from "../03-repo-preparation/repo-preparation-agent.interface";
import type { ScriptGenerationAgent } from "../04-script-generation/script-generation-agent.interface";
import type { CapturePathRepairer } from "../05-capture-path-validation/capture-path-repairer.interface";
import type { BrowserValidator } from "../05-capture-path-validation/project-runtime-preflight/browser-validator.interface";
import type { SandboxRunner } from "../05-capture-path-validation/project-runtime-preflight/sandbox-runner.interface";
import { parseDemoScript } from "../06-footage-capture/demo-script.schema";
import { runPipelineJob } from "./pipeline-orchestrator";
import { createPreCapturePipelineDependencies } from "./pre-capture-pipeline";

describe("createPreCapturePipelineDependencies", () => {
  it("wires the runnable pipeline through Script Generation", async () => {
    const repoPreparationAgent: RepoPreparationAgent = {
      async prepare() {
        return {
          baselineSourceControlledPaths: ["src/App.tsx"],
          manifest: {
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
            status: "created-new-demo",
            url: "http://localhost:3000",
            workspaceId: "workspace_123",
          },
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
      createPreCapturePipelineDependencies({
        browserValidator,
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
      expect(parseDemoScript(result.demoScriptPackage).scriptId).toBe(
        "generated-makeademo-script",
      );
      expect(result.demoScriptPackage.scenes[0]).toMatchObject({
        expectedVisibleOutcome: "The validation result is visible.",
        humanReadableDescription: "Demonstrate validation.",
        id: "scene-validation",
      });
    }
  });

  it("wires Capture Path Validation repair through an explicit repair agent", async () => {
    const scriptGenerationAgent: ScriptGenerationAgent = {
      async generateScriptPackage() {
        return scriptPackage("script_initial");
      },
    };
    const capturePathRepairer: CapturePathRepairer = {
      async repairCapturePathFailure(input) {
        return {
          preparationManifest: input.preparationManifest,
          demoScriptPackage: scriptPackage("script_repaired"),
        };
      },
    };

    const dependencies = createPreCapturePipelineDependencies({
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
        preparationManifest: manifest(),
        repoUrl: "https://github.com/example/app",
        demoScriptPackage: scriptPackage("script_initial"),
      }),
    ).resolves.toMatchObject({
      demoScriptPackage: { scriptId: "script_repaired" },
    });
  });
});

function manifest() {
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
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

function scriptPackage(scriptId: string) {
  return {
    assumptions: [],
    demoPlan: {
      featureOrder: ["validation"],
      narrative: "Demo it",
      risks: [],
    },
    demoPlaywrightScript:
      "await scene('scene_validation', async () => { await page.goto(baseUrl); });",
    exploration: { assumptions: [], productSurfaces: [], summary: "" },
    format: "16:9",
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
