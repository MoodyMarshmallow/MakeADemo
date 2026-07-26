import { describe, expect, it } from "vitest";

import {
  type SubmittedCodeNodeReleaseSnapshot,
  submittedCodeKnownGoodNodeReleaseSnapshot,
} from "./submitted-code-node-release-catalog.interface";
import { resolveSubmittedCodeToolchain as resolveAgainstNodeCatalog } from "./submitted-code-toolchain.schema";

function resolveSubmittedCodeToolchain(
  metadata: Parameters<typeof resolveAgainstNodeCatalog>[0],
  nodeReleases: SubmittedCodeNodeReleaseSnapshot = submittedCodeKnownGoodNodeReleaseSnapshot,
) {
  return resolveAgainstNodeCatalog(metadata, nodeReleases);
}

describe("resolveSubmittedCodeToolchain", () => {
  it("treats Excalidraw's incomplete Node tool selectors as preferences", () => {
    const plan = resolveSubmittedCodeToolchain(
      {
        candidates: [
          {
            files: {
              ".node-version": "18.x\n",
              ".nvmrc": "18\n",
              ".tool-versions": "nodejs v18\n",
              "mise.toml": '[tools]\nnode = "18"\n',
              "package.json": JSON.stringify({
                engines: { node: ">=18 <23" },
                packageManager: "yarn@1.22.22",
              }),
              "yarn.lock": "# yarn lockfile v1\n",
            },
            projectRoot: ".",
          },
        ],
      },
      nodeSnapshot("18.20.8", "20.19.5", "22.23.1", "24.1.0"),
    );

    expect(plan).toMatchObject({
      node: { version: "22.23.1" },
      warnings: expect.arrayContaining([
        expect.objectContaining({
          source: ".nvmrc",
          value: "18",
        }),
      ]),
    });
    expect(plan.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "node",
          role: "hard-compatibility",
          source: "package.json engines.node",
        }),
        expect.objectContaining({
          kind: "node",
          role: "soft-preference",
          source: ".nvmrc",
        }),
      ]),
    );
  });

  it("keeps an exact tool-file Node pin inside the package engine range", () => {
    expect(
      resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                ".node-version": "18.20.8\n",
                "package-lock.json": "{}",
                "package.json": JSON.stringify({
                  engines: { node: ">=18 <23" },
                }),
              },
              projectRoot: ".",
            },
          ],
        },
        nodeSnapshot("18.20.8", "20.19.5", "22.23.1"),
      ),
    ).toMatchObject({
      evidence: expect.arrayContaining([
        expect.objectContaining({
          role: "hard-pin",
          source: ".node-version",
          value: "18.20.8",
        }),
      ]),
      node: { version: "18.20.8" },
    });
  });

  it("intersects every Node claim and selects the highest stable matching release", () => {
    expect(
      resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                ".node-version": ">=22.20.0",
                ".nvmrc": "22.x",
                ".tool-versions": "nodejs >=22.21.0 <23\n",
                "mise.toml": '[tools]\nnode = ">=22.22.0"\n',
                "package.json": JSON.stringify({
                  devEngines: {
                    runtime: { name: "node", version: ">=22.19.0" },
                  },
                  engines: { node: ">=22.18.0 <24" },
                  packageManager: "pnpm@11.13.0",
                  volta: { node: "22.23.1" },
                }),
                "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
              },
              projectRoot: ".",
            },
          ],
        },
        nodeSnapshot("22.21.1", "22.22.0", "22.23.1", "24.1.0"),
      ),
    ).toMatchObject({
      node: { family: 22, lifecycle: "supported", version: "22.23.1" },
    });
  });

  it("defaults unconstrained projects to the highest stable Node 24 release", () => {
    expect(
      resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                "package-lock.json": "{}",
                "package.json": "{}",
              },
              projectRoot: ".",
            },
          ],
        },
        nodeSnapshot("22.23.1", "24.1.0", "24.3.2"),
      ),
    ).toMatchObject({
      node: { family: 24, lifecycle: "supported", version: "24.3.2" },
    });
  });

  it("selects a curated npm default compatible with the resolved Node generation", () => {
    expect(
      resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                "package-lock.json": "{}",
                "package.json": JSON.stringify({ engines: { node: "18" } }),
              },
              projectRoot: ".",
            },
          ],
        },
        nodeSnapshot("18.20.8", "24.3.2"),
      ),
    ).toMatchObject({
      node: { version: "18.20.8" },
      packageManager: { name: "npm", version: "10.9.2" },
    });
  });

  it("returns a typed blocker when an exact package manager rejects the resolved Node", () => {
    expect(
      resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                "package.json": JSON.stringify({
                  engines: { node: "20" },
                  packageManager: "pnpm@11.13.0",
                }),
                "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
              },
              projectRoot: ".",
            },
          ],
        },
        nodeSnapshot("20.19.5", "22.23.1"),
      ),
    ).toMatchObject({
      installBlocker: { code: "incompatible_node_package_manager" },
      node: { version: "20.19.5" },
    });
  });

  it("keeps Bun standalone from Node package-manager engine compatibility", () => {
    expect(
      resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                "bun.lock": "{}",
                "package.json": JSON.stringify({
                  engines: { node: "18" },
                  packageManager: "bun@1.2.22",
                }),
              },
              projectRoot: ".",
            },
          ],
        },
        nodeSnapshot("18.20.8"),
      ),
    ).toMatchObject({
      install: { executable: "bun" },
      packageManager: { name: "bun", version: "1.2.22" },
    });
  });

  it("marks resolved Node 18 and 20 families as legacy EOL", () => {
    for (const [constraint, version] of [
      ["18", "18.20.8"],
      ["20", "20.19.5"],
    ] as const) {
      expect(
        resolveSubmittedCodeToolchain(
          {
            candidates: [
              {
                files: {
                  "package-lock.json": "{}",
                  "package.json": JSON.stringify({
                    engines: { node: constraint },
                  }),
                },
                projectRoot: ".",
              },
            ],
          },
          nodeSnapshot(version, "22.23.1", "24.3.2"),
        ),
      ).toMatchObject({
        node: { lifecycle: "legacy-eol", version },
      });
    }
  });

  it.each(["lts/*", "node", "https://nodejs.org/node", "24.0.0-rc.1"])(
    "rejects unsafe Node claim %s with a typed outcome",
    (constraint) => {
      expect(() =>
        resolveSubmittedCodeToolchain({
          candidates: [
            {
              files: {
                "package-lock.json": "{}",
                "package.json": JSON.stringify({
                  engines: { node: constraint },
                }),
              },
              projectRoot: ".",
            },
          ],
        }),
      ).toThrow(expect.objectContaining({ code: "invalid_node_constraint" }));
    },
  );

  it("rejects a malformed mise Node declaration instead of using its safe-looking prefix", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "mise.toml": '[tools]\nnode = ["22", { version = 24 }]\n',
              "package-lock.json": "{}",
              "package.json": "{}",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_node_constraint" }));
  });

  it("rejects conflicting Node claims instead of choosing a priority winner", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              ".nvmrc": "20.19.5",
              "package-lock.json": "{}",
              "package.json": JSON.stringify({ engines: { node: "22" } }),
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: "conflicting_node_constraints" }),
    );
  });
  it("plans Cal's exact Yarn Berry release with its immutable contract", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                packageManager: "yarn@4.12.0",
              }),
              "yarn.lock": "__metadata:\n  version: 8\n",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      install: { argv: ["install", "--immutable"], executable: "yarn" },
      packageManager: {
        generation: "yarn-berry",
        name: "yarn",
        version: "4.12.0",
      },
    });
  });

  it("plans an unseen Yarn Classic generation with its frozen lockfile contract", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                packageManager: "yarn@1.22.19",
              }),
              "yarn.lock": "# yarn lockfile v1\n",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      install: {
        argv: ["install", "--frozen-lockfile", "--network-concurrency", "4"],
        executable: "yarn",
      },
      packageManager: {
        generation: "yarn-classic",
        name: "yarn",
        version: "1.22.19",
      },
    });
  });

  it("uses the Classic default when a Yarn v1 lockfile and a declared range omit an exact version", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({ engines: { yarn: ">=1 <2" } }),
              "yarn.lock":
                '# yarn lockfile v1\nleft-pad@^1.3.0:\n  version "1.3.0"\n',
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      install: {
        argv: ["install", "--frozen-lockfile", "--network-concurrency", "4"],
        executable: "yarn",
      },
      packageManager: {
        generation: "yarn-classic",
        name: "yarn",
        version: "1.22.22",
      },
    });
  });

  it.each([
    ["yarn", ">=2 <3", "yarn.lock", "__metadata:\n  version: 4\n", "2.4.2"],
    ["yarn", ">=3 <4", "yarn.lock", "__metadata:\n  version: 6\n", "3.8.7"],
    ["yarn", ">=4 <5", "yarn.lock", "__metadata:\n  version: 8\n", "4.12.0"],
    ["pnpm", ">=8 <9", "pnpm-lock.yaml", "lockfileVersion: '6.0'\n", "8.15.9"],
    ["pnpm", ">=9 <10", "pnpm-lock.yaml", "lockfileVersion: '9.0'\n", "9.15.9"],
    [
      "pnpm",
      ">=10 <11",
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n",
      "10.27.0",
    ],
    [
      "pnpm",
      ">=11 <12",
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n",
      "11.17.0",
    ],
    ["npm", ">=8 <9", "package-lock.json", "{}", "8.19.4"],
    ["npm", ">=9 <10", "package-lock.json", "{}", "9.9.4"],
    ["npm", ">=10 <11", "package-lock.json", "{}", "10.9.2"],
    ["npm", ">=11 <12", "package-lock.json", "{}", "11.6.2"],
  ] as const)(
    "selects the revisioned safe %s default for an unseen %s range",
    (name, range, lockfile, lockfileContents, version) => {
      expect(
        resolveSubmittedCodeToolchain({
          candidates: [
            {
              files: {
                "package.json": JSON.stringify({ engines: { [name]: range } }),
                [lockfile]: lockfileContents,
              },
              projectRoot: ".",
            },
          ],
        }),
      ).toMatchObject({ packageManager: { name, version } });
    },
  );

  it("does not accept a Berry descriptor for a Classic lockfile", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({ packageManager: "yarn@4.12.0" }),
              "yarn.lock": "# yarn lockfile v1\n",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow(
      "Yarn lockfile generation selects yarn-classic, but package-manager metadata selects yarn-berry.",
    );
  });

  it("plans an exact Bun 1 immutable install through its dedicated provisioner", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({ packageManager: "bun@1.2.22" }),
              "bun.lock": "{}",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      install: { argv: ["install", "--frozen-lockfile"], executable: "bun" },
      packageManager: { generation: "bun-1", name: "bun", version: "1.2.22" },
    });
  });

  it("selects a Bun default whose official GitHub asset has an authoritative digest", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: { "bun.lock": "{}", "package.json": "{}" },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      packageManager: { generation: "bun-1", name: "bun", version: "1.2.22" },
    });
  });

  it("blocks Bun releases older than GitHub's authoritative asset-digest boundary", () => {
    expect(
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "bun.lock": "{}",
              "package.json": JSON.stringify({ packageManager: "bun@1.2.15" }),
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toMatchObject({
      installBlocker: { code: "unsupported_provisioner" },
    });
  });

  it("rejects a Corepack integrity suffix for Bun's dedicated provisioner", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "bun.lock": "{}",
              "package.json": JSON.stringify({
                packageManager: `bun@1.2.22+sha512.${"a".repeat(128)}`,
              }),
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow("package.json packageManager must be an exact safe descriptor");
  });

  it("rejects prerelease package-manager descriptors", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                packageManager: "pnpm@11.0.0-rc.1",
              }),
              "pnpm-lock.yaml": "",
            },
            projectRoot: ".",
          },
        ],
      }),
    ).toThrow("package.json packageManager must be an exact safe descriptor.");
  });

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
      catalogRevision: "submitted-js-2026-07-26.1",
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
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
      },
      node: { version: "22.23.1" },
      packageManager: { name: "pnpm", version: "10.27.0" },
      projectRoot: ".",
    });
  });

  it("rejects disagreeing package.json and .nvmrc Node claims", () => {
    expect(() =>
      resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              ".nvmrc": "20.19.5\n",
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
    ).toThrow(
      expect.objectContaining({ code: "conflicting_node_constraints" }),
    );
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
    ).toThrow(expect.objectContaining({ code: "unsupported_node_version" }));
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
    ).toThrow(expect.objectContaining({ code: "unsupported_node_version" }));
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
      node: { version: "24.0.0" },
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

function nodeSnapshot(
  ...versions: readonly string[]
): SubmittedCodeNodeReleaseSnapshot {
  return {
    releases: versions.map((version) => ({
      family: Number(version.split(".")[0]) as 18 | 20 | 22 | 24,
      version,
    })),
    source: "test-fixture",
  };
}
