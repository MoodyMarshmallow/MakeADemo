import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "./preparation-workspace.interface";
import {
  SubmittedCodeWorkspaceSyncError,
  executeSubmittedCode,
  executeSubmittedProject,
  setSubmittedCodeNetworkAccess,
  syncSubmittedCodeWorkspace,
} from "./submitted-code-execution";

describe("submitted-code execution helpers", () => {
  it("passes a resolved plan only to submitted-project execution", async () => {
    const calls: unknown[] = [];
    const workspace = {
      ...fakeWorkspace(),
      async executeSubmittedProject(request: unknown) {
        calls.push(request);
        return { exitCode: 0, stderr: "", stdout: "ok" };
      },
    };
    const plan = {
      catalogRevision: "submitted-js-2026-07-17.1" as const,
      evidence: [],
      install: { argv: ["i", "--frozen-lockfile"], executable: "pnpm" },
      node: { version: "22.23.1" as const },
      packageManager: {
        name: "pnpm" as const,
        version: "11.13.0" as const,
      },
      projectRoot: "webapp",
    };
    const request = {
      argv: ["i", "--frozen-lockfile"],
      executable: "pnpm",
      plan,
    };

    await executeSubmittedProject(workspace, request);

    expect(calls).toEqual([request]);
  });

  it("fails instead of falling back to outer workspace execution", async () => {
    await expect(
      executeSubmittedCode(fakeWorkspace(), "npm run build"),
    ).rejects.toThrow("Preparation workspace cannot execute submitted code");
  });

  it("fails instead of falling back to outer workspace network controls", async () => {
    await expect(
      setSubmittedCodeNetworkAccess(fakeWorkspace(), true),
    ).rejects.toThrow(
      "Preparation workspace cannot control submitted-code network access",
    );
  });

  it("wraps submitted-code workspace sync failures with structured metadata", async () => {
    const cause = new Error("tar restore failed");

    await expect(
      syncSubmittedCodeWorkspace({
        ...fakeWorkspace(),
        async syncSubmittedCodeWorkspace() {
          throw cause;
        },
      }),
    ).rejects.toMatchObject({
      cause,
      failureKind: "submitted-code-workspace-sync-failed",
      message: "tar restore failed",
    });
  });

  it("exposes submitted-code workspace sync failures as a typed error", async () => {
    const cause = new Error("archive upload failed");

    await expect(
      syncSubmittedCodeWorkspace({
        ...fakeWorkspace(),
        async syncSubmittedCodeWorkspace() {
          throw cause;
        },
      }),
    ).rejects.toBeInstanceOf(SubmittedCodeWorkspaceSyncError);
  });
});

function fakeWorkspace(): PreparationWorkspace {
  return {
    async execute() {
      throw new Error("outer workspace execution must not run submitted code");
    },
    async getPreviewUrl() {
      return "https://preview.example.test";
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles() {},
  };
}
