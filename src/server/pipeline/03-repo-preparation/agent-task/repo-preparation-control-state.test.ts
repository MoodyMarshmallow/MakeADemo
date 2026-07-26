import { describe, expect, it } from "vitest";

import {
  type RepoPreparationControlState,
  createRepoPreparationControlState,
} from "./repo-preparation-control-state";

const manifest = {
  demoCommand: "npm run demo",
  status: "ready",
  url: "http://127.0.0.1:3000",
  workspaceId: "workspace-1",
};

function createState(
  readManifest: () => Promise<unknown> = async () => manifest,
): RepoPreparationControlState {
  return createRepoPreparationControlState({ readManifest });
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
    currentManifest = { ...manifest, workspaceId: "forged-workspace" };

    await expect(state.submit({ status: "succeeded" })).rejects.toThrow(
      "must match the latest passed preflight manifest",
    );
    expect(state.readSubmittedResult()).toBeUndefined();
  });
});
