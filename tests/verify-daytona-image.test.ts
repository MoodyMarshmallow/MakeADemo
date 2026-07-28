import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Daytona image verifier", () => {
  it("fails before Daytona access when neither supported auth mode is configured", async () => {
    await expect(
      execFileAsync("bun", ["--no-env-file", verifierScriptPath()], {
        env: verifierEnvironment(),
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Set DAYTONA_API_KEY or both DAYTONA_JWT_TOKEN and DAYTONA_ORGANIZATION_ID.",
      ),
    });
  });

  it.each([
    ["JWT token", { DAYTONA_JWT_TOKEN: "jwt-secret-value" }],
    ["organization id", { DAYTONA_ORGANIZATION_ID: "org-secret-value" }],
  ])("rejects a partial %s pair without logging its value", async (_, auth) => {
    const credentialValue = Object.values(auth).find(
      (value) => value !== undefined,
    );
    if (credentialValue === undefined)
      throw new Error("missing test credential");
    const execution = execFileAsync(
      "bun",
      ["--no-env-file", verifierScriptPath()],
      {
        env: { ...verifierEnvironment(), ...auth },
        timeout: 10_000,
      },
    );

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "DAYTONA_JWT_TOKEN and DAYTONA_ORGANIZATION_ID must be set together.",
      ),
    });
    await expect(execution).rejects.not.toMatchObject({
      stderr: expect.stringContaining(credentialValue),
    });
  });

  it.each([
    ["API key", { DAYTONA_API_KEY: "api-secret-value" }],
    [
      "JWT pair",
      {
        DAYTONA_JWT_TOKEN: "jwt-secret-value",
        DAYTONA_ORGANIZATION_ID: "organization-secret-value",
      },
    ],
  ])("accepts a complete %s auth mode without logging it", async (_, auth) => {
    const execution = execFileAsync(
      "bun",
      ["--no-env-file", verifierScriptPath()],
      {
        env: { ...verifierEnvironment(), ...auth },
        timeout: 10_000,
      },
    );

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining("MAKEADEMO_DAYTONA_SNAPSHOT is required"),
    });
    for (const value of Object.values(auth)) {
      await expect(execution).rejects.not.toMatchObject({
        stderr: expect.stringContaining(value),
      });
    }
  });

  it("uses the submitted-code snapshot env var expected by the Daytona provider", async () => {
    const script = await readVerifierScript();

    expect(script).toContain("MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT");
    expect(script).toContain("submittedCodeSnapshot");
    expect(script).not.toContain("MAKEADEMO_SUBMITTED_CODE_IMAGE");
    expect(script).not.toContain("submittedCodeImage");
  });

  it("validates the bounded parent toolchain inspector JSON before submitted runtime checks", async () => {
    const script = await readVerifierScript();
    const inspectorIndex = script.indexOf(
      '"makeademo-inspect-submitted-code-toolchain"',
    );
    const runtimeIndex = script.indexOf(
      "Verifying preloaded submitted-code runtime image",
    );

    expect(inspectorIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBeGreaterThan(inspectorIndex);
    expect(script).toMatch(
      /assertCommandSucceeded\(\s*"parent submitted-project toolchain inspector"/,
    );
    expect(script).toContain("JSON.parse(inspector.stdout)");
    expect(script).toContain("Array.isArray(inspectorOutput.candidates)");
    expect(script).toContain("Buffer.byteLength(inspector.stdout)");
    expect(script).not.toContain("console.log(inspector.stdout)");
  });

  it("checks native Git HTTPS trust in both Daytona images", async () => {
    const script = await readVerifierScript();

    expect(script).toContain("git --version");
    expect(script).toContain(
      "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
    );
    expect(script).not.toContain("npm root -g");
    expect(script).toContain('assertCommandSucceeded("parent Git/CA trust"');
    expect(script).toContain('assertCommandSucceeded("submitted-code runtime"');
  });

  it("proves submitted lifecycle commands are unprivileged with immutable tool stores", async () => {
    const script = await readVerifierScript();

    expect(script).toContain('test "$(id -u)" -ne 0');
    expect(script).not.toContain("/opt/mise");
    expect(script).not.toContain("/opt/corepack");
    expect(script).toContain(
      'test "$MAKEADEMO_PLAYWRIGHT_MODULE_ROOT" = "/opt/makeademo/playwright-runtime/node_modules"',
    );
    expect(script).toContain('test ! -w "$MAKEADEMO_PLAYWRIGHT_MODULE_ROOT"');
    expect(script).toContain(
      'test "$(stat -c %u "$MAKEADEMO_PLAYWRIGHT_MODULE_ROOT")" = "0"',
    );
    expect(script).toContain(
      'test -z "$(find /ms-playwright ! -user root -print -quit)"',
    );
    expect(script).toContain(
      'test -z "$(find /ms-playwright ! -type l -perm /222 -print -quit)"',
    );
    expect(script).toContain('metadata.version !== "1.49.1"');
    expect(script).toContain('requireFromTrustedRuntime("playwright")');
    expect(script).toContain('requireFromTrustedRuntime("@playwright/test")');
    expect(script).toContain("chromium.launch({ headless: true })");
    expect(script).toContain("trusted playwright chromium ok");
    expect(script).toContain("touch /workspace/.makeademo/runtime-write-test");
  });

  it("launches the trusted Playwright runtime only through the private provisioned binding", async () => {
    const script = await readVerifierScript();
    const provisionIndex = script.indexOf(
      "await handle.workspace.provisionSubmittedCodeToolchain(dynamicPlan)",
    );
    const trustedLaunchIndex = script.indexOf("trusted playwright chromium ok");
    const boundRuntimeIndex = script.lastIndexOf(
      "handle.workspace.executeSubmittedRuntime({",
      trustedLaunchIndex,
    );

    expect(provisionIndex).toBeGreaterThanOrEqual(0);
    expect(boundRuntimeIndex).toBeGreaterThan(provisionIndex);
    expect(trustedLaunchIndex).toBeGreaterThan(boundRuntimeIndex);
    expect(script.slice(0, provisionIndex)).not.toContain(
      "trusted playwright chromium ok",
    );
  });

  it("checks dynamic plans without a static mise or Corepack fallback", async () => {
    const script = await readVerifierScript();

    expect(script).not.toContain("mise --no-config");
    expect(script).not.toContain("node@22.23.1");
    expect(script).not.toContain('MISE_OFFLINE: "1"');
    expect(script).toContain("provisionSubmittedCodeToolchain");
    expect(script).toContain('!offlineToolchain.stdout.includes("v24.0.0")');
    for (const version of ["18.20.8", "20.19.5", "22.23.1", "24.0.0"]) {
      expect(script).toContain(`nodeVersion: "${version}"`);
    }
    expect(script).not.toContain("setSubmittedCodeNetworkAccess");
    expect(script).not.toContain("setOutboundNetworkAccess");
  });

  it("exercises the pinned CLI against a local page with a real session lifecycle", async () => {
    const script = await readVerifierScript();

    expect(script).toContain('test "$(playwright-cli --version)" = "0.1.17"');
    expect(script).toContain("PLAYWRIGHT_MCP_CONFIG=");
    expect(script).toContain('"chromiumSandbox":false');
    expect(script).toContain('playwright-cli -s="$session" --json open');
    expect(script).toContain(
      'playwright-cli -s="$session" --json eval "() => location.origin"',
    );
    expect(script).toContain("JSON.parse(value.result)");
    expect(script).toContain("Playwright CLI origin check returned");
    expect(script).toContain('playwright-cli -s="$session" --json snapshot');
    expect(script).toContain('playwright-cli -s="$session" --json screenshot');
    expect(script).toContain('playwright-cli -s="$session" --json close');
    expect(script).toContain("http://127.0.0.1:4173/");
    expect(script).toContain("MakeADemo image smoke");
    expect(script).toContain('test -s "$screenshotPath"');
  });

  it("parses the real Playwright eval envelope before checking the origin", async () => {
    const script = await readVerifierScript();
    const originCheck = script.match(
      /`node -e '([^`]+)' "\$originPath" "\$localUrl"`/,
    )?.[1];
    expect(originCheck).toBeDefined();
    if (originCheck === undefined) {
      throw new Error("Daytona verifier origin check command is missing.");
    }
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-origin-check-"));
    const envelopePath = join(workspace, "origin.json");

    try {
      await writeFile(
        envelopePath,
        JSON.stringify({
          result: JSON.stringify("http://127.0.0.1:4173"),
        }),
      );

      await expect(
        execFileAsync(process.execPath, [
          "-e",
          originCheck,
          envelopePath,
          "http://127.0.0.1:4173/",
        ]),
      ).resolves.toBeDefined();
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("keeps model-provider credentials out of Daytona image verification", async () => {
    const script = await readVerifierScript();

    expect(script).not.toContain("OPENAI_API_KEY");
    expect(script).not.toContain("MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME");
    expect(script).not.toContain("secrets:");
  });

  it("checks plain package-manager resolution through the bound submitted runtime", async () => {
    const script = await readVerifierScript();

    expect(script).toContain('tool="$(command -v ${matrixCase.manager})"');
    expect(script).toContain("workspace.executeSubmittedRuntime({");
    expect(script).toContain(
      "const versionCommand = `node --version && ${matrixCase.manager} --version`",
    );
    expect(script).not.toContain(
      "`corepack ${matrixCase.manager}@${matrixCase.version} --version`",
    );
  });

  it("probes the manager configuration keys used by bounded installs", async () => {
    const script = await readVerifierScript();

    expect(script).toContain("YARN_TASK_POOL_CONCURRENCY=2");
    expect(script).toContain("yarn config get taskPoolConcurrency");
    expect(script).toContain("YARN_NETWORK_CONCURRENCY=4");
    expect(script).toContain("yarn config get networkConcurrency");
    expect(script).toContain('packageManager: "yarn@2.4.2"');
    expect(script).toContain('version: "2.4.2"');
    expect(script).toContain('"--child-concurrency=2"');
    expect(script).toContain('"--network-concurrency=4"');
    expect(script).toContain('"--maxsockets=4"');
    expect(script).toContain("npm --maxsockets=4 config get maxsockets");
    expect(script).not.toContain("npm_config_child_concurrency");
    expect(script).not.toContain("npm_config_network_concurrency");
  });

  it("uses a complete Yarn Berry lockfile for the immutable-install smoke test", async () => {
    const script = await readVerifierScript();

    expect(script).toContain(
      '# This file is generated by running "yarn install" inside your project.',
    );
    expect(script).toContain(
      "# Manual changes might be lost - proceed with caution!",
    );
    expect(script).toContain('"makeademo-yarn-berry-smoke@workspace:."');
    expect(script).toContain(
      'resolution: "makeademo-yarn-berry-smoke@workspace:."',
    );
  });

  it("uses Yarn 2.4.2's canonical immutable lockfile bytes", async () => {
    const script = await readVerifierScript();

    expect(script).toContain(
      `'# This file is generated by running "yarn install" inside your project.\\n# Manual changes might be lost - proceed with caution!\\n\\n__metadata:\\n  version: 4\\n\\n"makeademo-yarn-2-smoke@workspace:.":\\n  version: 0.0.0-use.local\\n  resolution: "makeademo-yarn-2-smoke@workspace:."\\n  languageName: unknown\\n  linkType: soft\\n'`,
    );
  });
});

async function readVerifierScript(): Promise<string> {
  return await readFile(verifierScriptPath(), "utf8");
}

function verifierScriptPath(): string {
  return join(import.meta.dirname, "..", "scripts", "verify-daytona-image.mts");
}

function verifierEnvironment(): NodeJS.ProcessEnv {
  const omitted = new Set([
    "DAYTONA_API_KEY",
    "DAYTONA_JWT_TOKEN",
    "DAYTONA_ORGANIZATION_ID",
    "MAKEADEMO_DAYTONA_SNAPSHOT",
    "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !omitted.has(name)),
  );
}
