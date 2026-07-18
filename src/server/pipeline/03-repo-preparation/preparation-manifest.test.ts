import { describe, expect, it } from "vitest";

import { readPreparationManifest } from "./preparation-manifest";

describe("readPreparationManifest", () => {
  it("accepts the minimum durable preparation manifest", () => {
    expect(
      readPreparationManifest({
        assumptions: ["uses local fixtures"],
        demoCommand: "npm run demo:makeademo",
        diffArtifactId: "artifact_diff",
        nativeVisibleInterface: {
          nativeStartupAttempts: ["npm run demo:makeademo"],
          sourceControlledUiPaths: ["src/App.tsx"],
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Created a local demo route with mocked data.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toEqual({
      assumptions: ["uses local fixtures"],
      createdFiles: [],
      demoCommand: "npm run demo:makeademo",
      diffArtifactId: "artifact_diff",
      existingDemoEvidence: [],
      mockedServices: [],
      modifiedFiles: [],
      nativeVisibleInterface: {
        nativeStartupAttempts: ["npm run demo:makeademo"],
        sourceControlledUiPaths: ["src/App.tsx"],
      },
      repoUrl: "https://github.com/example/app",
      risks: [],
      scriptGenerationContext: [],
      setupSummary: "Created a local demo route with mocked data.",
      status: "created-new-demo",
      url: "http://127.0.0.1:3000",
      workspaceId: "workspace_123",
      dependencyInstall: "inferred",
    });
  });

  it("accepts an explicit dependency-install opt-out", () => {
    expect(
      readPreparationManifest({
        assumptions: [],
        dependencyInstall: "not-required",
        demoCommand: "node server.js",
        diffArtifactId: "artifact_diff",
        nativeVisibleInterface: {
          nativeStartupAttempts: ["node server.js"],
          sourceControlledUiPaths: ["src/App.tsx"],
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared a standard-library-only demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toMatchObject({ dependencyInstall: "not-required" });
  });

  it("rejects unknown dependency-install values", () => {
    expect(() =>
      readPreparationManifest({
        assumptions: [],
        dependencyInstall: "sometimes",
        demoCommand: "node server.js",
        diffArtifactId: "artifact_diff",
        nativeVisibleInterface: {
          nativeStartupAttempts: ["node server.js"],
          sourceControlledUiPaths: ["src/App.tsx"],
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toThrow("dependencyInstall must be inferred or not-required");
  });
});
