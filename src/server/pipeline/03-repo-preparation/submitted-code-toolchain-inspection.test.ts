import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "./preparation-workspace.interface";
import { inspectSubmittedCodeToolchain } from "./submitted-code-toolchain-inspection";

describe("inspectSubmittedCodeToolchain", () => {
  it("returns a catalog plan for supported submitted metadata", async () => {
    const result = await inspectSubmittedCodeToolchain(
      fakeWorkspace({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { node: "22" },
                packageManager: "pnpm@11.13.0",
              }),
              "pnpm-lock.yaml": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      mode: "catalog",
      plan: {
        node: { version: "22.23.1" },
        packageManager: { name: "pnpm", version: "11.13.0" },
      },
    });
  });

  it("returns an explicit unsupported-toolchain result for a catalog capability miss", async () => {
    const result = await inspectSubmittedCodeToolchain(
      fakeWorkspace({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { node: "20" },
                packageManager: "npm@10.8.2",
              }),
              "package-lock.json": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      code: "unsupported_node_version",
      mode: "unsupported",
    });
  });

  it("fails closed when trusted inspector output is malformed", async () => {
    await expect(
      inspectSubmittedCodeToolchain(fakeWorkspaceOutput("not json")),
    ).rejects.toThrow(
      "Submitted-project toolchain inspection returned malformed JSON",
    );
  });

  it("fails closed on malformed submitted version metadata", async () => {
    await expect(
      inspectSubmittedCodeToolchain(
        fakeWorkspace({
          candidates: [
            {
              files: {
                "package.json": JSON.stringify({
                  engines: { node: "definitely-not-semver" },
                  packageManager: "pnpm@11.13.0",
                }),
                "pnpm-lock.yaml": "",
              },
              projectRoot: ".",
            },
          ],
        }),
      ),
    ).rejects.toThrow("Submitted toolchain metadata could not be resolved");
  });

  it("does not expose submitted metadata secrets in malformed toolchain diagnostics", async () => {
    const secret = "token=supersecret";
    await expect(
      inspectSubmittedCodeToolchain(
        fakeWorkspace({
          candidates: [
            {
              files: {
                "package.json": JSON.stringify({
                  engines: { node: `${secret} ${"x".repeat(2_000)}` },
                }),
              },
              projectRoot: ".",
            },
          ],
        }),
      ),
    ).rejects.toThrow("Submitted toolchain metadata could not be resolved");
  });

  it("fails closed when the trusted inspector rejects submitted metadata", async () => {
    await expect(
      inspectSubmittedCodeToolchain(fakeWorkspaceOutput("unsafe symlink", 1)),
    ).rejects.toThrow("Submitted-project toolchain inspection failed");
  });

  it("redacts and bounds trusted inspector failure output", async () => {
    const secret = "token=supersecret";
    let error: Error | undefined;
    try {
      await inspectSubmittedCodeToolchain(
        fakeWorkspaceOutput(`${secret} ${"x".repeat(2_000)}`, 1),
      );
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).not.toContain(secret);
    expect(error?.message).toContain("token=***");
    expect(error?.message.length).toBeLessThanOrEqual(1_100);
  });
});

function fakeWorkspace(metadata: unknown): PreparationWorkspace {
  return fakeWorkspaceOutput(JSON.stringify(metadata));
}

function fakeWorkspaceOutput(
  stdout: string,
  exitCode = 0,
): PreparationWorkspace {
  return {
    async execute(command) {
      expect(command).toBe("makeademo-inspect-submitted-code-toolchain");
      return { exitCode, stderr: "", stdout };
    },
    async getPreviewUrl() {
      return "https://preview.example.test";
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles() {},
  };
}
