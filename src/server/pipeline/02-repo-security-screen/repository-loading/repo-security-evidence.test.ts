import { describe, expect, it } from "vitest";

import {
  selectRepoSecurityDeterministicManifestFiles,
  selectRepoSecurityEvidenceFiles,
} from "./repo-security-evidence";

describe("selectRepoSecurityEvidenceFiles", () => {
  it("reserves supported deterministic manifests root-first outside generic evidence", () => {
    const selection = selectRepoSecurityDeterministicManifestFiles([
      ...Array.from({ length: 130 }, (_, index) => ({
        path: `apps/app-${index.toString().padStart(3, "0")}/package.json`,
        sizeBytes: 32 * 1_024,
      })),
      {
        path: "deep/generic/pkg/package.json",
        sizeBytes: 32 * 1_024,
      },
      { path: "package.json", sizeBytes: 400 },
    ]);

    expect(selection.files).toHaveLength(128);
    expect(selection.files[0]).toEqual({
      excerptLimitBytes: 400,
      path: "package.json",
      sizeBytes: 400,
    });
    expect(selection.files.map((file) => file.path)).not.toContain(
      "deep/generic/pkg/package.json",
    );
    expect(selection.omittedManifestCount).toBe(3);
  });

  it("selects bounded static evidence in deterministic priority and path order", () => {
    const selection = selectRepoSecurityEvidenceFiles([
      { path: "tools/z.ts", sizeBytes: 20 },
      { path: "package.json", sizeBytes: 40_000 },
      { path: ".github/workflows/ci.yml", sizeBytes: 100 },
      { path: "Dockerfile", sizeBytes: 200 },
      { path: "scripts/a.sh", sizeBytes: 300 },
      { path: "src/app.ts", sizeBytes: 400 },
    ]);

    expect(selection.files.map((file) => file.path)).toEqual([
      "package.json",
      "Dockerfile",
      ".github/workflows/ci.yml",
      "scripts/a.sh",
      "tools/z.ts",
    ]);
    expect(selection.files[0]).toEqual({
      excerptLimitBytes: 32 * 1_024,
      path: "package.json",
      sizeBytes: 40_000,
    });
    expect(selection.limits).toEqual({
      maxEvidenceBytes: 512 * 1_024,
      maxFileBytes: 32 * 1_024,
      maxFiles: 128,
      maxInventorySamplePaths: 128,
    });
    expect(selection.inventory).toMatchObject({
      eligibleFileCount: 5,
      omittedEligibleFileCount: 0,
      sampledPaths: [
        ".github/workflows/ci.yml",
        "Dockerfile",
        "package.json",
        "scripts/a.sh",
        "src/app.ts",
        "tools/z.ts",
      ],
      totalFileCount: 6,
      totalSizeBytes: 41_020,
    });
  });

  it("never selects secret, dependency, cache, build, binary, asset, or unsafe paths", () => {
    const selection = selectRepoSecurityEvidenceFiles([
      { path: ".env", sizeBytes: 10 },
      { path: "apps/web/.env.production", sizeBytes: 10 },
      { path: "keys/id_rsa", sizeBytes: 10 },
      { path: "certs/server.pem", sizeBytes: 10 },
      { path: "node_modules/pkg/package.json", sizeBytes: 10 },
      { path: ".next/scripts/build.sh", sizeBytes: 10 },
      { path: "dist/Dockerfile", sizeBytes: 10 },
      { path: "assets/scripts/install.sh", sizeBytes: 10 },
      { path: "scripts/logo.png", sizeBytes: 10 },
      { path: "../scripts/escape.sh", sizeBytes: 10 },
      { path: "scripts/inspect.sh", sizeBytes: 10 },
    ]);

    expect(selection.files.map((file) => file.path)).toEqual([
      "scripts/inspect.sh",
    ]);
  });

  it("caps file count and aggregate excerpt bytes while reporting omissions", () => {
    const inventory = Array.from({ length: 140 }, (_, index) => ({
      path: `tools/file-${index.toString().padStart(3, "0")}.ts`,
      sizeBytes: 32 * 1_024,
    }));

    const selection = selectRepoSecurityEvidenceFiles(inventory);

    expect(selection.files).toHaveLength(16);
    expect(
      selection.files.reduce(
        (total, file) => total + file.excerptLimitBytes,
        0,
      ),
    ).toBe(512 * 1_024);
    expect(selection.inventory).toMatchObject({
      eligibleFileCount: 140,
      omittedEligibleFileCount: 124,
      sampledPathOmissionCount: 12,
    });
    expect(selection.inventory.sampledPaths).toHaveLength(128);
  });

  it("samples executable-looking files adjacent to supported manifests without parsing commands", () => {
    const selection = selectRepoSecurityEvidenceFiles([
      { path: "install.js", sizeBytes: 10 },
      { path: "package.json", sizeBytes: 200 },
      { path: "README.md", sizeBytes: 10 },
      { path: "src/app.ts", sizeBytes: 10 },
      { path: "web/app/package.json", sizeBytes: 200 },
      { path: "web/app/setup.bash", sizeBytes: 10 },
      { path: "web/app/setup.cjs", sizeBytes: 10 },
      { path: "web/app/setup.cts", sizeBytes: 10 },
      { path: "web/app/setup.mjs", sizeBytes: 10 },
      { path: "web/app/setup.mts", sizeBytes: 10 },
      { path: "web/app/setup.py", sizeBytes: 10 },
      { path: "web/app/setup.rb", sizeBytes: 10 },
      { path: "web/app/setup.sh", sizeBytes: 10 },
      { path: "web/app/setup.ts", sizeBytes: 10 },
      { path: "web/app/src/ignored.ts", sizeBytes: 10 },
    ]);

    expect(selection.files.map((file) => file.path)).toEqual([
      "package.json",
      "web/app/package.json",
      "install.js",
      "web/app/setup.bash",
      "web/app/setup.cjs",
      "web/app/setup.cts",
      "web/app/setup.mjs",
      "web/app/setup.mts",
      "web/app/setup.py",
      "web/app/setup.rb",
      "web/app/setup.sh",
      "web/app/setup.ts",
    ]);
  });
});
