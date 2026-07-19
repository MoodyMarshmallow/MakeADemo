import { describe, expect, it } from "vitest";

import {
  SubmittedCodeToolchainResolutionError,
  resolveSubmittedCodeToolchain,
} from "./submitted-code-toolchain.schema";

describe("resolveSubmittedCodeToolchain", () => {
  it("resolves Ghost's exact Node and Corepack-hashed pnpm evidence", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              ".node-version": "22.23.1\n",
              ".nvmrc": "22.23.1\n",
              "package.json": JSON.stringify({
                devEngines: { runtime: { name: "node", version: "22.23.1" } },
                engines: { node: "^22.23.1" },
                packageManager: "pnpm@11.13.0+sha512.0123456789abcdef",
              }),
              "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      catalogRevision: "submitted-js-2026-07-17.1",
      node: { version: "22.23.1" },
      packageManager: {
        corepackHash: "sha512.0123456789abcdef",
        name: "pnpm",
        version: "11.13.0",
      },
      projectRoot: ".",
    });
  });

  it("resolves Directus to the compatible catalog Node and exact pnpm", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { node: "22", pnpm: ">=10 <11" },
                packageManager: "pnpm@10.27.0",
              }),
              "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      install: {
        argv: ["i", "--frozen-lockfile"],
        executable: "pnpm",
      },
      node: { version: "22.23.1" },
      packageManager: { name: "pnpm", version: "10.27.0" },
      projectRoot: ".",
    });
  });

  it("uses package.json engines.node before a disagreeing .nvmrc and retains a warning", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              ".nvmrc": "20\n",
              "package.json": JSON.stringify({
                engines: { node: "^22.23.1" },
                packageManager: "pnpm@10.27.0",
              }),
              "pnpm-lock.yaml": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      node: { version: "22.23.1" },
      warnings: [
        {
          source: ".nvmrc",
          value: "20",
        },
      ],
    });
  });

  it("reports unsupported exact Node versions with fixed catalog evidence", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              ".node-version": "22.22.0",
              "package.json": "{}",
              "package-lock.json": "{}",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(
      "Node constraints do not intersect the submitted-js-2026-07-17.1 active catalog (22.23.1)",
    );
  });

  it("rejects an audited Node version that is not baked into the active image", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              ".node-version": "24.16.0",
              "package.json": JSON.stringify({
                packageManager: "pnpm@10.27.0",
              }),
              "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(
      "Node constraints do not intersect the submitted-js-2026-07-17.1 active catalog (22.23.1)",
    );
  });

  it("rejects pnpm metadata paired with a Yarn-only lockfile", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                packageManager: "pnpm@10.27.0",
              }),
              "yarn.lock": "# yarn lockfile v1\n",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(
      "Package-manager metadata selects pnpm, but the lockfile selects yarn.",
    );
  });

  it("rejects packageManager range descriptors", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                packageManager: "pnpm@^10.27.0",
              }),
              "pnpm-lock.yaml": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow("package.json packageManager must be an exact safe descriptor.");
  });

  it("rejects packageManager custom URL descriptors", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                packageManager:
                  "pnpm@https://packages.example.test/pnpm-10.27.0.tgz",
              }),
              "pnpm-lock.yaml": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow("package.json packageManager must be an exact safe descriptor.");
  });

  it("rejects conflicting package-manager lockfiles", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": "{}",
              "pnpm-lock.yaml": "",
              "yarn.lock": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow("Conflicting package-manager lockfiles: pnpm, yarn.");
  });

  it("rejects duplicate npm lock artifacts instead of collapsing them", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "npm-shrinkwrap.json": "",
              "package-lock.json": "",
              "package.json": JSON.stringify({
                packageManager: "npm@10.0.0",
              }),
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(
      "Conflicting package-manager lock artifacts: npm-shrinkwrap.json, package-lock.json.",
    );
  });

  it("rejects duplicate Bun lock artifacts instead of collapsing them", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "bun.lock": "",
              "bun.lockb": "",
              "package.json": JSON.stringify({
                packageManager: "bun@1.2.22",
              }),
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(
      "Conflicting package-manager lock artifacts: bun.lock, bun.lockb.",
    );
  });

  it("keeps a catalog runtime while blocking immutable install without a lockfile", () => {
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              packageManager: "pnpm@10.27.0",
            }),
          },
          projectRoot: ".",
        },
      ],
    });

    expect(plan).toMatchObject({
      installBlocker: { code: "missing_lockfile" },
      node: { version: "22.23.1" },
    });
    expect(plan.install).toBeUndefined();
  });

  it("rejects traversal segments in a submitted project root", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": "{}",
              "pnpm-lock.yaml": "",
            },
            projectRoot: "apps/../private",
          },
        ],
      }),
    ).toThrow("Unsafe submitted project root: apps/../private");
  });

  it("uses an exact packageManager descriptor before a disagreeing engine hint", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { pnpm: ">=11" },
                packageManager: "pnpm@10.27.0",
              }),
              "pnpm-lock.yaml": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      packageManager: { name: "pnpm", version: "10.27.0" },
      warnings: [
        {
          source: "package.json engines.pnpm",
          value: ">=11",
        },
      ],
    });
  });

  it("uses the sole nested JavaScript project root for Mattermost", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { node: ">=18" },
                packageManager: "pnpm@10.27.0",
              }),
              "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            },
            projectRoot: "webapp",
          },
        ],
      }).projectRoot,
    ).toBe("webapp");
  });

  it("gives an accepted root workspace precedence over stale nested metadata", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                packageManager: "pnpm@11.13.0",
                workspaces: ["apps/*"],
              }),
              "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            },
            projectRoot: ".",
          },
          {
            files: {
              "package.json": JSON.stringify({ packageManager: "npm@10.0.0" }),
              "package-lock.json": "{}",
            },
            projectRoot: "apps/web",
          },
        ],
      }).packageManager,
    ).toMatchObject({ name: "pnpm", version: "11.13.0" });
  });

  it("fails rather than guessing between nested JavaScript roots", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          { files: { "package.json": "{}" }, projectRoot: "frontend" },
          { files: { "package.json": "{}" }, projectRoot: "webapp" },
        ],
      }),
    ).toThrow("Ambiguous JavaScript project roots: frontend, webapp");
  });
});
