import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "./preparation-workspace.interface";
import {
  type SubmittedCodeNodeReleaseCatalog,
  SubmittedCodeNodeReleaseCatalogError,
  submittedCodeKnownGoodNodeReleaseCatalog,
} from "./submitted-code-node-release-catalog.interface";
import { inspectSubmittedCodeToolchain as inspectAgainstNodeCatalog } from "./submitted-code-toolchain-inspection";

function inspectSubmittedCodeToolchain(
  workspace: PreparationWorkspace,
  nodeReleaseCatalog: SubmittedCodeNodeReleaseCatalog = submittedCodeKnownGoodNodeReleaseCatalog,
) {
  return inspectAgainstNodeCatalog(workspace, nodeReleaseCatalog);
}

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

  it("resolves against the supplied per-job Node release catalog", async () => {
    const result = await inspectSubmittedCodeToolchain(
      fakeWorkspace({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { node: "24" },
                packageManager: "npm@10.8.2",
              }),
              "package-lock.json": "",
            },
            projectRoot: ".",
          },
        ],
      }),
      {
        async load() {
          return {
            releases: [{ family: 24, version: "24.3.2" }],
            source: "test-fixture",
          };
        },
      },
    );

    expect(result).toMatchObject({
      mode: "catalog",
      plan: { node: { family: 24, version: "24.3.2" } },
    });
  });

  it.each(["fetch_failed", "timed_out"] as const)(
    "preserves the Node catalog %s infrastructure attribution",
    async (code) => {
      const failure = new SubmittedCodeNodeReleaseCatalogError(
        code,
        `catalog ${code}`,
      );

      await expect(
        inspectSubmittedCodeToolchain(fakeWorkspace({ candidates: [] }), {
          async load() {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
    },
  );

  it("fails closed when trusted inspector output is malformed", async () => {
    await expect(
      inspectSubmittedCodeToolchain(fakeWorkspaceOutput("not json")),
    ).rejects.toThrow(
      "Submitted-project toolchain inspection returned malformed JSON",
    );
  });

  it("returns a bounded typed outcome for malformed submitted version metadata", async () => {
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
    ).resolves.toMatchObject({
      code: "invalid_node_constraint",
      mode: "unsupported",
    });
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
    ).resolves.toMatchObject({
      code: "invalid_node_constraint",
      mode: "unsupported",
      reason: expect.not.stringContaining(secret),
    });
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
    async uploadFiles() {},
  };
}
