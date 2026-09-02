import { writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type {
  AgentSessionRunInput,
  AgentSessionRunner,
  AgentTaskRunner,
} from "../agent-harness/agent-session-runner.interface";
import {
  type PipelineOrchestratorDependencies,
  runPipelineJob,
} from "../pipeline/00-orchestration/job/pipeline-orchestrator";
import { createPreparedApplicationIdentityEvidenceLedger } from "../pipeline/03-prepared-application-identity-review/prepared-application-identity-evidence";
import {
  createApplicationIdentityBaseline,
  createPreparedWorkspaceDiff,
} from "../pipeline/03-repo-preparation/application-identity-evidence";
import type { PreparationWorkspaceHandle } from "../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { RepoPreparationAgent } from "../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { submittedCodeKnownGoodNodeReleaseCatalog } from "../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { parseDemoScript } from "../pipeline/04-script-generation/demo-script/demo-script.schema";
import type { ScriptGenerationAgent } from "../pipeline/04-script-generation/script-generation-agent.interface";
import type { CapturePathRepairer } from "../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import type { BrowserValidator } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/browser-validator.interface";
import type { SandboxRunner } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/sandbox-runner.interface";
import { createPreparedAccessibilitySnapshot } from "../pipeline/05-capture-path-validation/demo-runtime-preflight/validation-evidence";
import { createProductionAgentHarness } from "./production-agent-harness";
import { resolveProductionAgentModelConfig } from "./production-agent-model-config";
import {
  createDaytonaFreshCaptureStatePreparer,
  createProductionPipeline,
  createProductionPipelineDependencies,
  resolveProductionRuntimeNetworkPolicy,
  toRepoPreparationPreflightResult,
} from "./production-pipeline";

describe("production Pipeline assembly", () => {
  it("allows public runtime egress for Daytona sandboxes", () => {
    expect(resolveProductionRuntimeNetworkPolicy()).toBe("unrestricted-public");
  });

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
        sandbox: {
          apiKey: "test-daytona-api-key",
        },
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(Object.keys(pipeline).sort()).toEqual(["dispose", "run"]);
      expect(pipeline.run).toEqual(expect.any(Function));

      await pipeline.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs Prepared Application Identity Review with a distinct fresh profile and only its stage tools", async () => {
    const calls: Array<{
      executionMode: string | undefined;
      profileLabel: string;
      session: unknown;
      stage: string;
      toolNames: string[];
    }> = [];
    const agentSessionRunner: AgentSessionRunner = {
      async run(input) {
        calls.push({
          executionMode: input.executionMode,
          profileLabel: input.profile.label,
          session: input.session,
          stage: input.stage,
          toolNames: input.tools?.map((tool) => tool.name) ?? [],
        });
        const handoff =
          await submitPassingPreparedApplicationIdentityReview(input);
        return {
          exitCode: 0,
          handoff,
          stderr: "",
          stdout: "",
          structuredOutput: { ignored: true },
        };
      },
    };
    const harness = createProductionAgentHarness({
      agentModel: resolveProductionAgentModelConfig({
        modelID: "gpt-5.6",
        providerID: "openai",
      }),
      agentSessionRunner,
    });
    const dependencies = createProductionPipelineDependencies({
      nodeReleaseCatalog: submittedCodeKnownGoodNodeReleaseCatalog,
      preparedApplicationIdentityReviewRunner:
        harness.agentTaskRunners.preparedApplicationIdentityReview,
      repoPreparationAgent: {
        async prepare() {
          throw new Error("not used");
        },
      },
      repoSecurityReviewer: approvingRepoSecurityReviewer(),
      sandboxRunner: {
        async runValidation() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      dependencies.reviewPreparedApplicationIdentity(
        preparedApplicationIdentityReviewInput(),
      ),
    ).resolves.toMatchObject({ status: "succeeded", verdict: "pass" });
    expect(calls).toEqual([
      {
        executionMode: "stage-tools-transient",
        profileLabel: "Prepared Application Identity review agent",
        session: undefined,
        stage: "prepared-application-identity-review",
        toolNames: [
          "inspect_pinned_source",
          "search_pinned_source_paths",
          "search_pinned_ui_identity",
          "read_prepared_identity_evidence",
          "makeademo_submit_identity_review",
        ],
      },
    ]);
  });

  it("preserves preflight visual evidence for Prepared Application Identity Review", () => {
    const result = toRepoPreparationPreflightResult({
      accessibilitySnapshot: {
        omittedChars: 12,
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sizeBytes: 24,
        text: "Native app accessibility",
        truncated: true,
      },
      blockedNetworkAttempts: [],
      logs: [],
      screenshot: {
        mimeType: "image/png",
        path: "/workspace/.makeademo/validation-screenshot.png",
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sizeBytes: 1_024,
      },
      status: "succeeded",
      warnings: [],
    });

    expect(result).toMatchObject({
      accessibilitySnapshot: {
        omittedChars: 12,
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sizeBytes: 24,
        text: "Native app accessibility",
        truncated: true,
      },
      screenshot: {
        mimeType: "image/png",
        path: "/workspace/.makeademo/validation-screenshot.png",
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sizeBytes: 1_024,
      },
    });
  });

  it("runs Repo Preparation, Script Generation, and Capture Path Validation through the Pipeline Job", async () => {
    const repoPreparationAgent: RepoPreparationAgent = {
      async prepare() {
        const diff = preparedWorkspaceDiff();
        return {
          applicationIdentityBaseline: applicationIdentityBaseline(),
          manifest: {
            ...preparationManifest(),
            diffArtifactId: diff.artifactId,
          },
          preparedWorkspaceDiff: diff,
          runtimePreflight: succeededRepoPreparationPreflight(),
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
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        preparationWorkspace: preparationWorkspaceHandle(),
        repoSecurity: { scannerReports: [] },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      createProductionPipelineDependencies({
        browserValidator,
        nodeReleaseCatalog: submittedCodeKnownGoodNodeReleaseCatalog,
        preparedApplicationIdentityReviewRunner:
          passingPreparedApplicationIdentityReviewRunner(),
        repoPreparationAgent,
        repoSecurityReviewer: approvingRepoSecurityReviewer(),
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
      preparedApplicationIdentityReviewRunner:
        passingPreparedApplicationIdentityReviewRunner(),
      repoPreparationAgent: {
        async prepare() {
          throw new Error("not used");
        },
      },
      repoSecurityReviewer: approvingRepoSecurityReviewer(),
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
    mockingPlan: {
      boundaries: [],
      fixturePaths: [],
      loadedPlaybooks: [],
      nativeUiRoots: ["src/App.tsx"],
      plannedPresentationChanges: [],
    },
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

function applicationIdentityBaseline() {
  return createApplicationIdentityBaseline({
    pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
    repoUrl: "https://github.com/example/app",
    sourceControlledPaths: ["src/App.tsx"],
    sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
  });
}

function preparedWorkspaceDiff() {
  return createPreparedWorkspaceDiff({
    createdPaths: [],
    deletedPaths: [],
    modifiedPaths: [],
    patch: "",
  });
}

function succeededRepoPreparationPreflight() {
  return {
    accessibilitySnapshot: createPreparedAccessibilitySnapshot(
      "Native application heading and validation control",
    ),
    blockedNetworkAttempts: [],
    logs: ["browser loaded"],
    screenshot: {
      mimeType: "image/png" as const,
      path: "/workspace/.makeademo/validation-screenshot.png",
      sha256:
        "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
      sizeBytes: identityScreenshotBytes.length,
    },
    status: "succeeded" as const,
    warnings: [],
  };
}

function passingPreparedApplicationIdentityReviewRunner(): AgentTaskRunner {
  return {
    async run(input) {
      const handoff =
        await submitPassingPreparedApplicationIdentityReview(input);
      return {
        exitCode: 0,
        handoff,
        structuredOutput: { ignored: true },
      };
    },
  };
}

function preparedApplicationIdentityReviewInput() {
  const diff = preparedWorkspaceDiff();
  return {
    evidenceLedger: createPreparedApplicationIdentityEvidenceLedger({
      applicationIdentityBaseline: applicationIdentityBaseline(),
      evidence: [
        {
          content: JSON.stringify({
            mimeType: "image/png",
            path: "/workspace/.makeademo/validation-screenshot.png",
            sha256:
              "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
            sizeBytes: identityScreenshotBytes.length,
          }),
          id: "prepared:screenshot",
          kind: "prepared-screenshot",
        },
        {
          content: "Native application heading and navigation are visible.",
          id: "prepared:accessibility",
          kind: "accessibility-snapshot",
        },
      ],
      mockedBoundaries: [],
      preparedWorkspaceDiff: diff,
    }),
    preparationManifest: {
      ...preparationManifest(),
      diffArtifactId: diff.artifactId,
    },
    preparationWorkspace: preparationWorkspaceHandle(),
  };
}

function preparationWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async capturePreparedWorkspaceDiff() {
        return preparedWorkspaceDiff();
      },
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
      async executeReadOnlyCommand() {
        return {
          exitCode: 0,
          stderr: "",
          stdout: Array.from(
            { length: 20 },
            (_, index) => `export const nativeLine${index + 1} = true;`,
          ).join("\n"),
        };
      },
      async downloadFiles(files) {
        await Promise.all(
          files.map(({ destinationPath }) =>
            writeFile(destinationPath, identityScreenshotBytes),
          ),
        );
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async uploadFiles() {},
    },
  };
}

const identityScreenshotBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function inspectPreparedApplicationIdentityEvidence(
  input: Pick<AgentSessionRunInput, "tools">,
): Promise<void> {
  const sourceTool = input.tools?.find(
    ({ name }) => name === "inspect_pinned_source",
  );
  const evidenceTool = input.tools?.find(
    ({ name }) => name === "read_prepared_identity_evidence",
  );
  if (sourceTool === undefined || evidenceTool === undefined) {
    throw new Error("Identity review tools were not supplied.");
  }
  await sourceTool.execute({
    endLine: "20",
    path: "src/App.tsx",
    startLine: "1",
  });
  for (const evidenceId of evidenceTool.args.evidenceId?.values ?? []) {
    await evidenceTool.execute({ evidenceId });
  }
}

async function submitPassingPreparedApplicationIdentityReview<T>(
  input: Pick<AgentSessionRunInput<T>, "toolProtocol" | "tools">,
): Promise<T> {
  await inspectPreparedApplicationIdentityEvidence(input);
  const decision = {
    explanation: "The prepared application retains its pinned native surface.",
    mockedBoundaries: [],
    nativeSurfacesRendered: ["src/App.tsx"],
    replacementEvidence: [],
    sourceCitations: [{ endLine: 20, path: "src/App.tsx", startLine: 1 }],
    verdict: "pass",
  };
  const submitTool = input.tools?.find(
    ({ name }) => name === "makeademo_submit_identity_review",
  );
  if (submitTool === undefined || input.toolProtocol === undefined) {
    throw new Error("Identity review submission protocol was not supplied.");
  }
  await submitTool.execute(decision);
  const decoded = input.toolProtocol.decode({
    input: decision,
    name: submitTool.name,
    status: "completed",
  });
  if (decoded.status !== "accepted") {
    throw new Error("Identity review submission was not accepted.");
  }
  return decoded.handoff;
}

function succeededPreparedDemo(
  preparationWorkspace: PreparationWorkspaceHandle,
) {
  const demoScript = createDemoScript("script_test");
  const manifest = preparationManifest();
  const diff = preparedWorkspaceDiff();

  return {
    demoScript,
    capturePathValidation: {
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test/",
      logs: [],
      status: "succeeded" as const,
      warnings: [],
    },
    identityEvidenceSource: {
      applicationIdentityBaseline: applicationIdentityBaseline(),
      manifest,
      preparedWorkspaceDiff: diff,
      runtimePreflight: succeededRepoPreparationPreflight(),
    },
    preparationManifest: manifest,
    preparationWorkspace,
    reviewedPreparedWorkspaceDiff: diff,
    status: "succeeded" as const,
  };
}

function approvingRepoSecurityReviewer() {
  return {
    async review() {
      return {
        concerns: [],
        rationale: "Test fixture approval.",
        status: "succeeded" as const,
        verdict: "approved" as const,
      };
    },
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
