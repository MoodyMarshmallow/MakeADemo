import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../test-support/create-agent-session";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import { createDaytonaFreshCaptureStatePreparer } from "./fresh-capture-state";

describe("createDaytonaFreshCaptureStatePreparer", () => {
  it("invokes the Daytona baseline restore seam before Footage Capture", async () => {
    const preparationWorkspace = fakePreparationWorkspaceHandle();
    const calls: unknown[] = [];
    const prepareFreshCaptureState = createDaytonaFreshCaptureStatePreparer(
      async (input) => {
        calls.push(input);
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

    expect(calls).toEqual([
      {
        preparationManifest: preparationManifest(),
        preparationWorkspace,
      },
    ]);
  });
});

function succeededPreparedDemo(
  preparationWorkspace: PreparationWorkspaceHandle,
) {
  const acceptedDemoScript = {
    assumptions: [],
    demoPlan: { featureOrder: [], narrative: "Demo.", risks: [] },
    demoPlaywrightScript: "",
    exploration: {
      assumptions: [],
      productSurfaces: [],
      summary: "Prepared app.",
    },
    format: "16:9" as const,
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: [],
    scriptId: "script_test",
    title: "Demo",
    version: 1 as const,
  };

  return {
    acceptedDemoScript,
    capturePathValidation: {
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test/",
      logs: [],
      status: "succeeded" as const,
      warnings: [],
    },
    demoScriptPackage: acceptedDemoScript,
    agentSession: createAgentSession(),
    preparationManifest: preparationManifest(),
    preparationWorkspace,
    repoSecurity: { rejections: [], status: "passed" as const, warnings: [] },
    status: "succeeded" as const,
  };
}

function fakePreparationWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "daytona_workspace",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

function preparationManifest() {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo",
    diffArtifactId: "diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared app.",
    status: "adapted-existing-demo" as const,
    url: "http://localhost:3000/",
    workspaceId: "workspace_123",
  };
}
