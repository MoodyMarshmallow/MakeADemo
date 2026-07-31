import { describe, expect, it } from "vitest";

import { PreparationWorkspaceInfrastructureError } from "./preparation-workspace-infrastructure.interface";
import type { PreparationWorkspace } from "./preparation-workspace.interface";
import {
  SubmittedCodeToolchainProvisioningError,
  SubmittedCodeWorkspaceSyncError,
  executeSubmittedCode,
  executeSubmittedProject,
  provisionSubmittedCodeToolchain,
  syncSubmittedCodeWorkspace,
} from "./submitted-code-execution";

describe("submitted-code execution helpers", () => {
  it("requires a trusted provisioning boundary before a plan is executable", async () => {
    await expect(
      provisionSubmittedCodeToolchain(fakeWorkspace(), {
        catalogRevision: "submitted-js-2026-07-26.1",
        evidence: [],
        node: {
          family: 22,
          lifecycle: "supported",
          version: "22.23.1",
        },
        packageManager: {
          generation: "yarn-berry",
          name: "yarn",
          version: "4.12.0",
        },
        projectRoot: ".",
      }),
    ).rejects.toThrow("cannot provision submitted-code toolchains");
  });

  it("wraps trusted toolchain provisioning failures with structured metadata", async () => {
    const cause = new Error("trusted provisioning unavailable");

    await expect(
      provisionSubmittedCodeToolchain(
        {
          ...fakeWorkspace(),
          async provisionSubmittedCodeToolchain() {
            throw cause;
          },
        },
        {
          catalogRevision: "submitted-js-2026-07-26.1",
          evidence: [],
          node: {
            family: 22,
            lifecycle: "supported",
            version: "22.23.1",
          },
          packageManager: {
            generation: "yarn-berry",
            name: "yarn",
            version: "4.12.0",
          },
          projectRoot: ".",
        },
      ),
    ).rejects.toMatchObject({
      cause,
      failureKind: "submitted-code-toolchain-provisioning-failed",
      message: "trusted provisioning unavailable",
    });
  });

  it("preserves safe infrastructure attribution through the provisioning wrapper", async () => {
    const cause = new PreparationWorkspaceInfrastructureError({
      phase: "trusted-provisioning",
      provider: "daytona",
    });

    await expect(
      provisionSubmittedCodeToolchain(
        {
          ...fakeWorkspace(),
          async provisionSubmittedCodeToolchain() {
            throw cause;
          },
        },
        {
          catalogRevision: "submitted-js-2026-07-26.1",
          evidence: [],
          node: {
            family: 22,
            lifecycle: "supported",
            version: "22.23.1",
          },
          packageManager: {
            generation: "bun-1",
            name: "bun",
            version: "1.2.22",
          },
          projectRoot: ".",
        },
      ),
    ).rejects.toMatchObject({
      failureKind: "submitted-code-toolchain-provisioning-failed",
      preparationWorkspaceInfrastructureDiagnostic: {
        phase: "trusted-provisioning",
        provider: "daytona",
      },
    });
  });

  it("exposes provisioning failures as a typed error", async () => {
    await expect(
      provisionSubmittedCodeToolchain(fakeWorkspace(), {
        catalogRevision: "submitted-js-2026-07-26.1",
        evidence: [],
        node: {
          family: 22,
          lifecycle: "supported",
          version: "22.23.1",
        },
        packageManager: {
          generation: "yarn-berry",
          name: "yarn",
          version: "4.12.0",
        },
        projectRoot: ".",
      }),
    ).rejects.toBeInstanceOf(SubmittedCodeToolchainProvisioningError);
  });

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
      catalogRevision: "submitted-js-2026-07-26.1" as const,
      evidence: [],
      install: {
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
      },
      node: {
        family: 22 as const,
        lifecycle: "supported" as const,
        version: "22.23.1" as const,
      },
      packageManager: {
        generation: "pnpm-modern" as const,
        name: "pnpm" as const,
        version: "11.13.0" as const,
      },
      projectRoot: "webapp",
    };
    const request = {
      argv: [
        "install",
        "--frozen-lockfile",
        "--child-concurrency=2",
        "--network-concurrency=4",
      ],
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
    async uploadFiles() {},
  };
}
