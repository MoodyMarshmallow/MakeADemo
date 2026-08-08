import { describe, expect, it } from "vitest";

import {
  type RepoPreparationControlState,
  createRepoPreparationControlState,
} from "./repo-preparation-control-state";

const manifest = {
  demoCommand: "npm run demo",
  mockingPlan: {
    boundaries: [],
    fixturePaths: [],
    loadedPlaybooks: [],
    nativeUiRoots: ["src/App.tsx"],
    plannedPresentationChanges: [],
  },
  status: "ready",
  url: "http://127.0.0.1:3000",
  workspaceId: "workspace-1",
};

function createState(
  readManifest: () => Promise<unknown> = async () => manifest,
): RepoPreparationControlState {
  return createRepoPreparationControlState({
    baselineSourceControlledPaths: ["src/App.tsx"],
    readManifest,
  });
}

describe("Repo Preparation control state", () => {
  it("keeps dependency requests in backend memory until the orchestrator consumes them", async () => {
    const state = createState();

    await state.requestDependencyInstall({});

    expect(state.takeDependencyInstallRequest()).toEqual({});
    expect(state.takeDependencyInstallRequest()).toBeUndefined();
  });

  it("does not accept a succeeded result forged outside the control state", async () => {
    const state = createState();

    await expect(state.submit({ status: "succeeded" })).rejects.toThrow(
      "Run makeademo_validate_preparation",
    );
    expect(state.readSubmittedResult()).toBeUndefined();
  });

  it("rejects a succeeded result when the agent changes its manifest after validation", async () => {
    let currentManifest: unknown = manifest;
    const state = createState(async () => currentManifest);
    state.recordValidation({
      manifest,
      runtimePreflight: {
        blockedNetworkAttempts: [],
        logs: [],
        status: "succeeded",
        warnings: [],
      },
    });
    currentManifest = {
      ...manifest,
      mockingPlan: {
        ...manifest.mockingPlan,
        plannedPresentationChanges: ["Replace the native interface"],
      },
    };

    await expect(state.submit({ status: "succeeded" })).rejects.toThrow(
      "must match the latest passed preflight manifest",
    );
    expect(state.readSubmittedResult()).toBeUndefined();
  });

  it("requires fresh validation when the loaded-playbook set changes", async () => {
    const state = createState();
    state.recordValidation({
      manifest,
      runtimePreflight: {
        blockedNetworkAttempts: [],
        logs: [],
        status: "succeeded",
        warnings: [],
      },
    });

    state.recordLoadedPlaybook("mock-backend-data");

    await expect(state.submit({ status: "succeeded" })).rejects.toThrow(
      "Run makeademo_validate_preparation",
    );
    expect(state.readSubmittedResult()).toBeUndefined();
  });

  it("keeps validation when loading a playbook already present in the set", async () => {
    const state = createState();
    state.recordLoadedPlaybook("mock-backend-data");
    state.recordValidation({
      manifest,
      runtimePreflight: {
        blockedNetworkAttempts: [],
        logs: [],
        status: "succeeded",
        warnings: [],
      },
    });

    state.recordLoadedPlaybook("mock-backend-data");

    await expect(
      state.submit({ status: "succeeded" }),
    ).resolves.toBeUndefined();
  });

  it("rejects submission when the loaded-playbook set changes during manifest reread", async () => {
    let finishManifestRead: ((value: unknown) => void) | undefined;
    const state = createState(
      () =>
        new Promise((resolve) => {
          finishManifestRead = resolve;
        }),
    );
    state.recordValidation({
      manifest,
      runtimePreflight: {
        blockedNetworkAttempts: [],
        logs: [],
        status: "succeeded",
        warnings: [],
      },
    });

    const submission = state.submit({ status: "succeeded" });
    await Promise.resolve();
    state.recordLoadedPlaybook("mock-backend-data");
    finishManifestRead?.(manifest);

    await expect(submission).rejects.toThrow(
      "Run makeademo_validate_preparation",
    );
    expect(state.readSubmittedResult()).toBeUndefined();
  });
});
