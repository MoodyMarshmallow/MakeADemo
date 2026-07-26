import { describe, expect, it } from "vitest";

import {
  type PreparationWorkspaceProvider,
  runInPreparationWorkspace,
} from "./preparation-workspace-runner";
import type { PreparationWorkspace } from "./preparation-workspace.interface";

describe("runInPreparationWorkspace", () => {
  it("creates a workspace, returns the agent result, and releases the workspace", async () => {
    const events: string[] = [];
    const provider = fakeProvider(events);

    const result = await runInPreparationWorkspace({
      provider,
      run: async (handle) => {
        events.push(`run:${handle.id}`);
        return "prepared";
      },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ status: "succeeded", value: "prepared" });
    expect(events).toEqual(["create", "run:workspace_123", "release"]);
  });

  it("releases the workspace when the agent run times out", async () => {
    const events: string[] = [];
    const provider = fakeProvider(events);
    const result = await runInPreparationWorkspace({
      provider,
      run: () => new Promise(() => undefined),
      timeoutMs: 0,
    });

    expect(result).toEqual({
      reason: "Repo Preparation agent timed out after 0ms.",
      status: "timed-out",
    });
    expect(events).toEqual(["create", "release"]);
  });
});

function fakeProvider(events: string[]): PreparationWorkspaceProvider {
  return {
    async create() {
      events.push("create");
      return {
        async release() {
          events.push("release");
        },
        id: "workspace_123",
        workspace: fakeWorkspace(events),
      };
    },
  };
}

function fakeWorkspace(events: string[]): PreparationWorkspace {
  return {
    async execute(command) {
      events.push(`execute:${command}`);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async uploadFiles() {},
  };
}
