import { describe, expect, it } from "vitest";
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

  it("fails when production fresh capture wiring lacks the prepared workspace", async () => {
    const prepareFreshCaptureState = createDaytonaFreshCaptureStatePreparer();

    await expect(
      prepareFreshCaptureState({
        attempt: 1,
        browserUrl: "https://preview.example.test/",
        preparedDemo: succeededPreparedDemo(),
      }),
    ).rejects.toThrow(
      "Fresh Footage Capture state requires the prepared workspace.",
    );
  });
});

function succeededPreparedDemo(
  preparationWorkspace?: PreparationWorkspaceHandle,
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
    opencodeSessionID: "session_123",
    preparationManifest: preparationManifest(),
    ...(preparationWorkspace === undefined ? {} : { preparationWorkspace }),
    repoSecurity: { rejections: [], status: "passed" as const, warnings: [] },
    status: "succeeded" as const,
  };
}

function fakePreparationWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async destroy() {},
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
