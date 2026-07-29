import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { submittedCodeKnownGoodNodeReleaseSnapshot } from "../../../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { resolveSubmittedCodeToolchain } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import {
  railwaySpikeTemplateRecipe,
  railwaySpikeTemplateRevision,
} from "./railway-spike-template-recipe";

const execFileAsync = promisify(execFile);
const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/localhost-app/", import.meta.url),
);
const trustedInspectorPath = fileURLToPath(
  new URL(
    "../../../../../infra/daytona/inspect-submitted-code-toolchain.mjs",
    import.meta.url,
  ),
);

describe("Railway spike template recipe", () => {
  it("pins the browser-ready runtime and its immutable trust boundaries", () => {
    expect(railwaySpikeTemplateRevision).toBe(
      railwaySpikeTemplateRecipe.revision,
    );
    expect(railwaySpikeTemplateRecipe.node.version).toBe("22.23.1");
    expect(railwaySpikeTemplateRecipe.playwright.version).toBe("1.49.1");
    expect(railwaySpikeTemplateRecipe.playwright.browsers).toContain(
      "chromium",
    );
    expect(railwaySpikeTemplateRecipe.user).toMatchObject({
      name: "makeademo",
      privileged: false,
      workspace: "/workspace",
    });

    const systemPackages = new Set(railwaySpikeTemplateRecipe.packages.system);
    for (const required of [
      "ca-certificates",
      "curl",
      "tar",
      "xz-utils",
      "ffmpeg",
    ]) {
      expect(systemPackages).toContain(required);
    }

    expect(railwaySpikeTemplateRecipe.runtimePaths.immutable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/opt/makeademo/playwright-runtime",
          owner: "root:root",
          immutable: true,
          writable: false,
        }),
        expect.objectContaining({
          path: "/ms-playwright",
          owner: "root:root",
          immutable: true,
          writable: false,
        }),
      ]),
    );
  });

  it("keeps provisioning commands ordered and represented as data", () => {
    expect(railwaySpikeTemplateRecipe.commands.length).toBeGreaterThan(0);
    expect(
      railwaySpikeTemplateRecipe.commands.every(
        (command) => typeof command === "string" && command.length > 0,
      ),
    ).toBe(true);
    expect(railwaySpikeTemplateRecipe.commands.join("\n")).toMatch(
      /node.*22\.23\.1/s,
    );
    expect(railwaySpikeTemplateRecipe.commands.join("\n")).toMatch(
      /playwright.*1\.49\.1/s,
    );
  });

  it("installs Debian 13 Chromium dependencies explicitly instead of using Playwright's unsupported fallback", () => {
    const systemPackages = new Set(railwaySpikeTemplateRecipe.packages.system);
    for (const required of [
      "fonts-freefont-ttf",
      "fonts-noto-color-emoji",
      "fonts-unifont",
      "libasound2t64",
      "libatk-bridge2.0-0t64",
      "libatk1.0-0t64",
      "libatspi2.0-0t64",
      "libcups2t64",
      "libgbm1",
      "libglib2.0-0t64",
      "libnspr4",
      "libnss3",
      "libxkbcommon0",
      "xvfb",
    ]) {
      expect(systemPackages).toContain(required);
    }

    const commands = railwaySpikeTemplateRecipe.commands.join("\n");
    expect(commands).toContain("install chromium");
    expect(commands).not.toContain("install --with-deps chromium");
    expect(commands).not.toContain("install-deps chromium");
  });

  it("uses only the pinned Node and npm binaries for template installs and verification", () => {
    const { nodeBin, npmBin } = railwaySpikeTemplateRecipe.runtimePaths;
    expect(nodeBin).toBe(
      "/opt/makeademo/toolchains/node/versions/22.23.1/bin/node",
    );
    expect(npmBin).toBe(
      "/opt/makeademo/toolchains/node/versions/22.23.1/bin/npm",
    );

    const commands = railwaySpikeTemplateRecipe.commands.join("\n");
    expect(commands).toContain(`${npmBin} install --global`);
    expect(commands).toContain(`test \"$(${nodeBin} --version)\"`);
    expect(commands).toContain(`test \"$(${npmBin} --version)\"`);
    expect(commands).toContain(
      `${nodeBin} /opt/makeademo/playwright-runtime/node_modules/playwright/cli.js install chromium`,
    );
    expect(commands).toContain(
      `${nodeBin} /usr/local/bin/makeademo-inspect-submitted-code-toolchain`,
    );
    expect(commands).not.toMatch(/(?:^|[\s(])(?:node|npm)(?=\s)/m);
  });

  it("declares an architecture-verified canary runtime and trusted inspection boundary", () => {
    expect(railwaySpikeTemplateRecipe.node).toMatchObject({
      architectures: ["x64", "arm64"],
      npmVersion: "11.6.2",
      shasumsUrl: "https://nodejs.org/dist/v22.23.1/SHASUMS256.txt",
      version: "22.23.1",
    });
    expect(railwaySpikeTemplateRecipe.user).toMatchObject({
      group: "makeademo",
      home: "/home/makeademo",
      name: "makeademo",
      privileged: false,
      temporaryDirectory: "/tmp/makeademo",
      workspace: "/workspace",
    });
    expect(railwaySpikeTemplateRecipe.trustedFiles).toEqual([
      expect.objectContaining({
        mode: 0o555,
        owner: "root:root",
        path: "/usr/local/bin/makeademo-inspect-submitted-code-toolchain",
      }),
    ]);

    const commands = railwaySpikeTemplateRecipe.commands.join("\n");
    expect(commands).toContain("SHASUMS256.txt");
    expect(commands).toContain("node-v22.23.1-linux-${node_arch}.tar.xz");
    expect(commands).toContain("sha256sum --check");
    expect(commands).toContain("npm --version");
    expect(commands).toContain("install chromium");
    expect(commands).not.toContain("install --with-deps chromium");
    expect(commands).toContain("makeademo-inspect-submitted-code-toolchain");
    expect(commands).toContain("runuser --user makeademo");
    expect(commands).toContain("chromium.launch");
  });

  it("resolves the checked-in canary fixture to the provider toolchain without an install blocker", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [trustedInspectorPath],
      { cwd: fixtureDirectory },
    );

    const plan = resolveSubmittedCodeToolchain(
      JSON.parse(stdout),
      submittedCodeKnownGoodNodeReleaseSnapshot,
    );

    expect(plan).toMatchObject({
      install: { argv: ["ci", "--maxsockets=4"], executable: "npm" },
      node: { family: 22, lifecycle: "supported", version: "22.23.1" },
      packageManager: {
        generation: "npm-modern",
        name: "npm",
        version: "11.6.2",
      },
      projectRoot: ".",
    });
    expect(plan.installBlocker).toBeUndefined();
  });
});
