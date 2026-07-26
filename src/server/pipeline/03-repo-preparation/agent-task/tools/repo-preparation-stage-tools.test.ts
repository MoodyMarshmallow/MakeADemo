import { describe, expect, it } from "vitest";

import {
  type RepoPreparationControlState,
  createRepoPreparationControlState,
} from "../repo-preparation-control-state";
import { createRepoPreparationStageTools } from "./repo-preparation-stage-tools";

const manifest = {
  demoCommand: "npm run demo",
  url: "http://127.0.0.1:3000",
  workspaceId: "workspace-1",
};

function createState(
  readManifest: () => Promise<unknown> = async () => manifest,
): RepoPreparationControlState {
  return createRepoPreparationControlState({ readManifest });
}

describe("Repo Preparation stage tools", () => {
  it("exposes only Repo Preparation's stage-owned capabilities", () => {
    const tools = createRepoPreparationStageTools(createState());

    expect(tools.map(({ name }) => name)).toEqual([
      "makeademo_dependency_request_install",
      "makeademo_install_dependencies",
      "makeademo_validate_preparation",
      "makeademo_submit_preparation_result",
    ]);
    expect(tools.every(({ execute }) => typeof execute === "function")).toBe(
      true,
    );
  });

  it("requests a backend-selected dependency install without command arguments", async () => {
    const state = createState();
    const tools = createRepoPreparationStageTools(state);
    const tool = tools.find(
      ({ name }) => name === "makeademo_dependency_request_install",
    );

    if (tool === undefined) throw new Error("Dependency tool is missing.");

    expect(tool.args).toEqual({});
    await expect(tool.execute({})).resolves.toBe(
      "Requested the backend-selected immutable dependency install.",
    );
    expect(state.takeDependencyInstallRequest()).toEqual({});
  });

  it("writes a validation request only for the canonical manifest path", async () => {
    const state = createState();
    const tool = createRepoPreparationStageTools(state).find(
      ({ name }) => name === "makeademo_validate_preparation",
    );

    if (tool === undefined) throw new Error("Validation tool is missing.");

    await expect(
      tool.execute({
        manifestPath: "/workspace/.makeademo/preparation-manifest.json",
      }),
    ).resolves.toContain("Stop now");
    expect(state.takeValidationRequest()).toEqual({
      manifestPath: "/workspace/.makeademo/preparation-manifest.json",
    });
    await expect(
      tool.execute({ manifestPath: "/workspace/preparation-manifest.json" }),
    ).rejects.toThrow("Preparation manifest path must be");
  });

  it("canonicalizes optional fields when submitting a failed preparation", async () => {
    const state = createState();
    const tool = createRepoPreparationStageTools(state).find(
      ({ name }) => name === "makeademo_submit_preparation_result",
    );

    if (tool === undefined) throw new Error("Submit tool is missing.");

    await expect(
      tool.execute({ blockers: ["missing setup"], status: "failed" }),
    ).resolves.toBe("Submitted Repo Preparation failed result.");
    expect(state.readSubmittedResult()).toEqual({
      assumptions: [],
      blockers: ["missing setup"],
      status: "failed",
      suggestedChanges: [],
    });
    await expect(
      tool.execute({ blockers: [], status: "failed" }),
    ).rejects.toThrow("non-empty blockers");
  });

  it("accepts a succeeded submission only after matching validation", async () => {
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
    const tool = createRepoPreparationStageTools(state).find(
      ({ name }) => name === "makeademo_submit_preparation_result",
    );

    if (tool === undefined) throw new Error("Submit tool is missing.");

    await expect(tool.execute({ status: "succeeded" })).resolves.toBe(
      "Submitted Repo Preparation succeeded result.",
    );
    expect(state.readSubmittedResult()).toEqual({
      manifest,
      status: "succeeded",
    });

    currentManifest = { ...manifest, workspaceId: "different-workspace" };
    await expect(tool.execute({ status: "succeeded" })).rejects.toThrow(
      "must match the latest passed preflight manifest",
    );
  });
});
