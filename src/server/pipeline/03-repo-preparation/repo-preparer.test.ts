import { describe, expect, it } from "vitest";

import { createAgentSession } from "../../test-support/create-agent-session";
import { createApplicationIdentityBaseline } from "./application-identity-evidence";
import type { RepoPreparationAgent } from "./repo-preparation-agent.interface";
import { prepareRepo } from "./repo-preparer";

describe("prepareRepo", () => {
  it("returns a manifest when the preparation agent prepares the workspace", async () => {
    const agent: RepoPreparationAgent = {
      async prepare() {
        return {
          ...successfulEvidence(),
          manifest: {
            assumptions: [],
            demoCommand: "npm run demo:makeademo",
            diffArtifactId: "artifact_diff",
            mockingPlan: noMockingPlan,
            nativeVisibleInterface: {
              nativeStartupAttempts: ["npm run demo:makeademo"],
              sourceControlledUiPaths: ["src/App.tsx"],
            },
            repoUrl: "https://github.com/example/app",
            risks: [],
            setupSummary: "Reused an existing demo script.",
            status: "reused-existing-demo",
            url: "http://localhost:3000",
            workspaceId: "workspace_123",
          },
          status: "succeeded",
        };
      },
    };

    const result = await prepareRepo(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.manifest.demoCommand).toBe("npm run demo:makeademo");
      expect(result).toMatchObject({
        applicationIdentityBaseline: {
          pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
        },
        preparedWorkspaceDiff: {
          artifactId: "workspace-diff:sha256:backend",
        },
        runtimePreflight: { status: "succeeded" },
      });
    }
  });

  it("preserves the Agent Session handle for same-session Script Generation", async () => {
    const agentSession = createAgentSession();
    const agent: RepoPreparationAgent = {
      async prepare() {
        return {
          ...successfulEvidence(),
          manifest: {
            assumptions: [],
            demoCommand: "npm run demo:makeademo",
            diffArtifactId: "artifact_diff",
            mockingPlan: noMockingPlan,
            nativeVisibleInterface: {
              nativeStartupAttempts: ["npm run demo:makeademo"],
              sourceControlledUiPaths: ["src/App.tsx"],
            },
            repoUrl: "https://github.com/example/app",
            risks: [],
            setupSummary: "Reused an existing demo script.",
            status: "reused-existing-demo",
            url: "http://localhost:3000",
            workspaceId: "workspace_123",
          },
          agentSession,
          status: "succeeded",
        };
      },
    };

    const result = await prepareRepo(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.agentSession).toBe(agentSession);
    }
  });

  it("preserves the failure kind when the preparation agent cannot prepare the workspace", async () => {
    const agent: RepoPreparationAgent = {
      async prepare() {
        return {
          assumptions: ["remote API shape is not inferable"],
          blockers: ["dashboard data requires a private API"],
          failureKind: "dependency-install-sigkill",
          status: "failed",
          suggestedChanges: ["add local dashboard fixtures"],
        };
      },
    };

    const result = await prepareRepo(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["dashboard"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureKind).toBe("dependency-install-sigkill");
    }
  });

  it("fails when the preparation agent returns an invalid manifest", async () => {
    const agent: RepoPreparationAgent = {
      async prepare() {
        return {
          ...successfulEvidence(),
          manifest: {
            demoCommand: "npm run demo",
            repoUrl: "https://github.com/example/app",
            url: "http://localhost:3000",
            workspaceId: "workspace_123",
          },
          status: "succeeded",
        };
      },
    };

    const result = await prepareRepo(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["dashboard"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result.status).toBe("failed");
  });

  it("reports an infrastructure handoff failure when a success omits provenance", async () => {
    const agent = {
      async prepare() {
        return {
          manifest: {
            assumptions: [],
            createdFiles: [],
            demoCommand: "npm run demo:makeademo",
            diffArtifactId: "artifact_diff",
            nativeVisibleInterface: {
              nativeStartupAttempts: ["npm run demo:makeademo"],
              sourceControlledUiPaths: [],
            },
            repoUrl: "https://github.com/example/app",
            risks: [],
            setupSummary: "Prepared demo runtime.",
            status: "created-new-demo",
            url: "http://localhost:3000",
            workspaceId: "workspace_123",
          },
          status: "succeeded" as const,
        };
      },
    } as unknown as RepoPreparationAgent;

    const result = await prepareRepo(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["dashboard"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result.status).toBe("failed");
  });

  it("rejects a success manifest whose visible interface was created during preparation", async () => {
    const agent: RepoPreparationAgent = {
      async prepare() {
        return {
          ...successfulEvidence({ createdPaths: ["demo/index.html"] }),
          manifest: {
            assumptions: [],
            createdFiles: ["demo/index.html"],
            demoCommand: "node demo/server.js",
            diffArtifactId: "artifact_diff",
            nativeVisibleInterface: {
              nativeStartupAttempts: ["node demo/server.js"],
              sourceControlledUiPaths: ["demo/index.html"],
            },
            repoUrl: "https://github.com/example/app",
            risks: [],
            setupSummary: "Created a standalone replacement demo.",
            status: "created-new-demo",
            url: "http://localhost:3000",
            workspaceId: "workspace_123",
          },
          status: "succeeded",
        };
      },
    };

    const result = await prepareRepo(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["dashboard"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result).toMatchObject({ status: "failed" });
  });
});

function successfulEvidence(
  diffOverrides: Partial<{
    createdPaths: readonly string[];
    deletedPaths: readonly string[];
    modifiedPaths: readonly string[];
  }> = {},
) {
  return {
    applicationIdentityBaseline: createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: ["src/App.tsx"],
      sourceTreeObjectId: "2".repeat(40),
    }),
    preparedWorkspaceDiff: {
      artifactId: "workspace-diff:sha256:backend",
      createdPaths: [],
      deletedPaths: [],
      modifiedPaths: [],
      patch: "",
      patchSha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sizeBytes: 0,
      ...diffOverrides,
    },
    runtimePreflight: {
      blockedNetworkAttempts: [],
      logs: ["validated"],
      status: "succeeded" as const,
      warnings: [],
    },
  };
}

const noMockingPlan = {
  boundaries: [],
  fixturePaths: [],
  loadedPlaybooks: [],
  nativeUiRoots: ["src/App.tsx"],
  plannedPresentationChanges: [],
};
