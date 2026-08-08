import { describe, expect, it } from "vitest";

import { createApplicationIdentityBaseline } from "./application-identity-evidence";
import {
  createAuthoritativePreparationManifest,
  readPreparationManifest,
  validateNativeVisibleInterfaceProvenance,
} from "./preparation-manifest";

const noMockingPlan = {
  boundaries: [],
  fixturePaths: [],
  loadedPlaybooks: [],
  nativeUiRoots: ["src/App.tsx"],
  plannedPresentationChanges: [],
};

describe("readPreparationManifest", () => {
  it("accepts the minimum durable preparation manifest", () => {
    expect(
      readPreparationManifest({
        assumptions: ["uses local fixtures"],
        demoCommand: "npm run demo:makeademo",
        diffArtifactId: "artifact_diff",
        mockingPlan: {
          boundaries: [
            {
              kind: "backend",
              localReplacement: "Static article repository",
              source: "Hosted article API",
            },
          ],
          fixturePaths: ["src/demo/articles.json"],
          loadedPlaybooks: ["mock-backend-data"],
          nativeUiRoots: ["src/App.tsx"],
          plannedPresentationChanges: [
            "Show seeded articles in the native feed",
          ],
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
      deletedFiles: [],
      demoCommand: "npm run demo:makeademo",
      diffArtifactId: "artifact_diff",
      existingDemoEvidence: [],
      mockingPlan: {
        boundaries: [
          {
            kind: "backend",
            localReplacement: "Static article repository",
            source: "Hosted article API",
          },
        ],
        fixturePaths: ["src/demo/articles.json"],
        loadedPlaybooks: ["mock-backend-data"],
        nativeUiRoots: ["src/App.tsx"],
        plannedPresentationChanges: ["Show seeded articles in the native feed"],
      },
      mockedServices: ["Hosted article API"],
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
        mockingPlan: noMockingPlan,
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared a standard-library-only demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toMatchObject({ dependencyInstall: "not-required" });
  });

  it("rejects a mocking plan without a native UI root", () => {
    expect(() =>
      readPreparationManifest({
        assumptions: [],
        demoCommand: "npm run demo",
        diffArtifactId: "artifact_diff",
        mockingPlan: { ...noMockingPlan, nativeUiRoots: [] },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toThrow("mockingPlan.nativeUiRoots must not be empty");
  });

  it("rejects a mocking plan collection beyond its bounded count", () => {
    expect(() =>
      readPreparationManifest({
        assumptions: [],
        demoCommand: "npm run demo",
        diffArtifactId: "artifact_diff",
        mockingPlan: {
          ...noMockingPlan,
          fixturePaths: Array.from(
            { length: 65 },
            (_, index) => `fixtures/${index}.json`,
          ),
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toThrow("mockingPlan.fixturePaths must contain at most 64 items");
  });

  it("rejects a mocking plan string beyond its bounded byte length", () => {
    expect(() =>
      readPreparationManifest({
        assumptions: [],
        demoCommand: "npm run demo",
        diffArtifactId: "artifact_diff",
        mockingPlan: {
          ...noMockingPlan,
          plannedPresentationChanges: ["x".repeat(1_001)],
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toThrow(
      "mockingPlan.plannedPresentationChanges[0] must be at most 1000 bytes",
    );
  });

  it("rejects a native UI root that was created during preparation", () => {
    const manifest = createAuthoritativePreparationManifest(
      readPreparationManifest({
        assumptions: [],
        createdFiles: ["demo/index.html"],
        demoCommand: "node demo/server.js",
        diffArtifactId: "agent-authored-diff",
        mockingPlan: {
          ...noMockingPlan,
          nativeUiRoots: ["demo/index.html"],
        },
        nativeVisibleInterface: {
          nativeStartupAttempts: ["node demo/server.js"],
          sourceControlledUiPaths: ["src/App.tsx"],
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Created a standalone replacement demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
      {
        artifactId: "workspace-diff:sha256:backend",
        createdPaths: ["demo/index.html"],
        deletedPaths: [],
        modifiedPaths: [],
        patch: "created demo/index.html",
        patchSha256: "1".repeat(64),
        sizeBytes: 23,
      },
    );

    expect(() =>
      validateNativeVisibleInterfaceProvenance(
        manifest,
        createApplicationIdentityBaseline({
          pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
          repoUrl: "https://github.com/example/app",
          sourceControlledPaths: ["src/App.tsx"],
          sourceTreeObjectId: "3".repeat(40),
        }),
      ),
    ).toThrow(
      "mockingPlan.nativeUiRoots includes demo/index.html, which was not source-controlled before Repo Preparation",
    );
  });

  it("validates native UI roots through the pre-mutation UI identity index", () => {
    const manifest = readPreparationManifest({
      assumptions: [],
      demoCommand: "npm run demo",
      diffArtifactId: "workspace-diff:sha256:backend",
      mockingPlan: noMockingPlan,
      repoUrl: "https://github.com/example/app",
      risks: [],
      setupSummary: "Uses the native UI.",
      status: "reused-existing-demo",
      url: "http://127.0.0.1:3000",
      workspaceId: "workspace_123",
    });
    const baseline = createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: ["src/App.tsx"],
      sourceTreeObjectId: "3".repeat(40),
    });

    expect(() =>
      validateNativeVisibleInterfaceProvenance(manifest, {
        ...baseline,
        uiIdentityIndex: {
          ...baseline.uiIdentityIndex,
          entries: [],
          entryCount: 0,
        },
      }),
    ).toThrow("not indexed as pre-mutation source evidence");
  });

  it("derives mocked services from boundaries instead of a legacy claim", () => {
    expect(
      readPreparationManifest({
        assumptions: [],
        demoCommand: "npm run demo",
        diffArtifactId: "artifact_diff",
        mockedServices: ["Hosted billing API"],
        mockingPlan: {
          ...noMockingPlan,
          boundaries: [
            {
              kind: "backend",
              localReplacement: "Local article fixtures",
              source: "Hosted article API",
            },
          ],
          loadedPlaybooks: ["mock-backend-data"],
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
    ).toMatchObject({ mockedServices: ["Hosted article API"] });
  });

  it("rejects a fixture path outside the pinned source and backend diff", () => {
    const manifest = createAuthoritativePreparationManifest(
      readPreparationManifest({
        assumptions: [],
        demoCommand: "npm run demo",
        diffArtifactId: "agent-authored-diff",
        mockingPlan: {
          ...noMockingPlan,
          fixturePaths: ["src/demo/untracked.json"],
        },
        repoUrl: "https://github.com/example/app",
        risks: [],
        setupSummary: "Prepared demo.",
        status: "created-new-demo",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace_123",
      }),
      {
        artifactId: "workspace-diff:sha256:backend",
        createdPaths: [],
        deletedPaths: [],
        modifiedPaths: [],
        patch: "",
        patchSha256: "1".repeat(64),
        sizeBytes: 0,
      },
    );

    expect(() =>
      validateNativeVisibleInterfaceProvenance(
        manifest,
        createApplicationIdentityBaseline({
          pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
          repoUrl: "https://github.com/example/app",
          sourceControlledPaths: ["src/App.tsx"],
          sourceTreeObjectId: "3".repeat(40),
        }),
      ),
    ).toThrow(
      "mockingPlan.fixturePaths includes src/demo/untracked.json, which was not present in the pinned source or backend-captured workspace diff",
    );
  });

  it("rejects unknown dependency-install values", () => {
    expect(() =>
      readPreparationManifest({
        assumptions: [],
        dependencyInstall: "sometimes",
        demoCommand: "node server.js",
        diffArtifactId: "artifact_diff",
        mockingPlan: noMockingPlan,
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
