import { submittedCodeKnownGoodNodeReleaseSnapshot } from "../src/server/pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { resolveSubmittedCodeToolchain } from "../src/server/pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import { executeDemoScriptInSandbox } from "../src/server/pipeline/04-script-generation/demo-script/demo-script-sandbox-executor";
import { DaytonaSdkPreparationWorkspaceProvider } from "../src/server/shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";

const makeADemoCaptureNodeVersion = "v22.12.0";
const makeADemoCaptureNodeSha256 =
  "177208bfc4a9403121a40c72d038c670f4fd937fa16ca7df0a720e90be0fe2d9";

const snapshot = process.env.MAKEADEMO_DAYTONA_SNAPSHOT;
const submittedCodeSnapshot =
  process.env.MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT;
const daytonaApiKey = process.env.DAYTONA_API_KEY;
const daytonaJwtToken = process.env.DAYTONA_JWT_TOKEN;
const daytonaOrganizationId = process.env.DAYTONA_ORGANIZATION_ID;
const hasDaytonaApiKey = hasNonEmptyValue(daytonaApiKey);
const hasDaytonaJwtToken = hasNonEmptyValue(daytonaJwtToken);
const hasDaytonaOrganizationId = hasNonEmptyValue(daytonaOrganizationId);

if (hasDaytonaJwtToken !== hasDaytonaOrganizationId) {
  throw new Error(
    "DAYTONA_JWT_TOKEN and DAYTONA_ORGANIZATION_ID must be set together.",
  );
}

if (!(hasDaytonaApiKey || hasDaytonaJwtToken)) {
  throw new Error(
    "Set DAYTONA_API_KEY or both DAYTONA_JWT_TOKEN and DAYTONA_ORGANIZATION_ID.",
  );
}

if (snapshot === undefined || snapshot.trim().length === 0) {
  throw new Error(
    "MAKEADEMO_DAYTONA_SNAPSHOT is required to verify the prepared Daytona image.",
  );
}

if (
  submittedCodeSnapshot === undefined ||
  submittedCodeSnapshot.trim().length === 0
) {
  throw new Error(
    "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT is required to verify the prepared submitted-code Daytona image.",
  );
}

const nodeReleases = submittedCodeKnownGoodNodeReleaseSnapshot;

console.log(`Creating Daytona workspace from snapshot ${snapshot}...`);
const provider = new DaytonaSdkPreparationWorkspaceProvider({
  snapshot,
  submittedCodeSnapshot,
});
const handle = await provider.create();

try {
  console.log(`Verifying parent Git/CA trust in ${handle.id}...`);
  const parentGitTrust = await handle.workspace.execute(
    [
      "git --version",
      "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
    ].join(" && "),
    {
      onStderr: (chunk) => process.stderr.write(chunk),
      onStdout: (chunk) => process.stdout.write(chunk),
    },
  );
  assertCommandSucceeded("parent Git/CA trust", parentGitTrust);

  console.log("Verifying parent submitted-project toolchain inspector...");
  const inspector = await handle.workspace.execute(
    "makeademo-inspect-submitted-code-toolchain",
  );
  assertCommandSucceeded(
    "parent submitted-project toolchain inspector",
    inspector,
  );
  if (Buffer.byteLength(inspector.stdout) > 512 * 1024) {
    throw new Error(
      "Parent submitted-project toolchain inspector returned oversized output.",
    );
  }
  let inspectorOutput: unknown;
  try {
    inspectorOutput = JSON.parse(inspector.stdout);
  } catch {
    throw new Error(
      "Parent submitted-project toolchain inspector returned malformed JSON.",
    );
  }
  if (
    typeof inspectorOutput !== "object" ||
    inspectorOutput === null ||
    !("candidates" in inspectorOutput) ||
    !Array.isArray(inspectorOutput.candidates)
  ) {
    throw new Error(
      "Parent submitted-project toolchain inspector returned an invalid candidates shape.",
    );
  }

  console.log(
    `Verifying preloaded submitted-code runtime image in ${handle.id}...`,
  );
  const runtime = await handle.workspace.executeSubmittedCode?.(
    [
      'test "$(id -u)" -ne 0',
      'test "$MAKEADEMO_PLAYWRIGHT_MODULE_ROOT" = "/opt/makeademo/playwright-runtime/node_modules"',
      'test "$PLAYWRIGHT_BROWSERS_PATH" = "/ms-playwright"',
      'test ! -w "$MAKEADEMO_PLAYWRIGHT_MODULE_ROOT"',
      'test "$(stat -c %u "$MAKEADEMO_PLAYWRIGHT_MODULE_ROOT")" = "0"',
      'test -z "$(find /ms-playwright ! -user root -print -quit)"',
      'test -z "$(find /ms-playwright ! -type l -perm /222 -print -quit)"',
      'test -x "/opt/makeademo/capture-runtime/bin/node"',
      'test "$(stat -c %u /opt/makeademo/capture-runtime/bin/node)" = "0"',
      'test -z "$(find /opt/makeademo/capture-runtime ! -user root -print -quit)"',
      'test -z "$(find /opt/makeademo/capture-runtime ! -type l -perm /222 -print -quit)"',
      `test "$(cat /opt/makeademo/capture-runtime/node.version)" = "${makeADemoCaptureNodeVersion}"`,
      `test "$(cat /opt/makeademo/capture-runtime/node.sha256)" = "${makeADemoCaptureNodeSha256}"`,
      `test "$(/opt/makeademo/capture-runtime/bin/node --version)" = "${makeADemoCaptureNodeVersion}"`,
      `printf '%s  %s\\n' '${makeADemoCaptureNodeSha256}' /opt/makeademo/capture-runtime/bin/node | sha256sum -c -`,
      "cd /workspace",
      "touch /workspace/.makeademo/runtime-write-test",
      "rm -f /workspace/.makeademo/runtime-write-test",
      "node --version",
      "bun --version",
      "bunx tsc --version",
      "git --version",
      "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
    ].join(" && "),
    {
      onStderr: (chunk) => process.stderr.write(chunk),
      onStdout: (chunk) => process.stdout.write(chunk),
    },
  );
  if (runtime === undefined) {
    throw new Error(
      "Prepared Daytona workspace lacks submitted-code execution.",
    );
  }
  assertCommandSucceeded("submitted-code runtime", runtime);
  console.log(
    "Verifying the Playwright CLI session lifecycle against a local page...",
  );
  const playwrightSession = await handle.workspace.executeSubmittedCode?.(
    [
      "set -eu",
      'test "$(playwright-cli --version)" = "0.1.17"',
      `session="makeademo-image-smoke-$(node -e 'process.stdout.write(require("crypto").randomUUID())')"`,
      'localUrl="http://127.0.0.1:4173/"',
      'outputDir="/tmp/makeademo-browser-tools/$session"',
      'configPath="$outputDir/config.json"',
      'originPath="$outputDir/origin.json"',
      'snapshotPath="$outputDir/snapshot.json"',
      'screenshotPath="$outputDir/screenshot.png"',
      'mkdir -p "$outputDir"',
      `printf '%s' '{"browser":{"browserName":"chromium","isolated":true,"launchOptions":{"chromiumSandbox":false,"headless":true}},"network":{"allowedOrigins":["http://127.0.0.1:4173"]},"outputDir":"'"$outputDir"'","outputMode":"stdout"}' > "$configPath"`,
      `node -e "require('http').createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><head><title>MakeADemo image smoke</title></head><body><h1>MakeADemo image smoke</h1></body></html>'); }).listen(4173, '127.0.0.1')" >/tmp/makeademo-image-smoke-server.log 2>&1 & serverPid=$!`,
      'cleanup() { playwright-cli -s="$session" --json close >/dev/null 2>&1 || true; kill "$serverPid" >/dev/null 2>&1 || true; }',
      "trap cleanup EXIT",
      'for attempt in $(seq 1 50); do curl -fsS "$localUrl" >/dev/null 2>&1 && break; sleep 0.1; done',
      'curl -fsS "$localUrl" >/dev/null',
      'PLAYWRIGHT_MCP_CONFIG="$configPath" playwright-cli -s="$session" --json open "$localUrl"',
      'playwright-cli -s="$session" --json eval "() => location.origin" > "$originPath"',
      `node -e 'const fs = require("fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.result !== "string") { console.error("Playwright CLI origin check returned an invalid envelope"); process.exit(1); } let result; try { result = JSON.parse(value.result); } catch { console.error("Playwright CLI origin check returned an invalid result"); process.exit(1); } if (typeof result !== "string") { console.error("Playwright CLI origin check returned a non-string result"); process.exit(1); } const expected = new URL(process.argv[2]).origin; if (result !== expected) { console.error("Playwright CLI origin check returned", JSON.stringify(result)); process.exit(1); }' "$originPath" "$localUrl"`,
      'playwright-cli -s="$session" --json snapshot > "$snapshotPath"',
      'case "$(cat "$snapshotPath")" in *"MakeADemo image smoke"*) ;; *) echo "Playwright snapshot omitted local page marker." >&2; exit 1 ;; esac',
      'playwright-cli -s="$session" --json screenshot --filename="$screenshotPath"',
      'test -s "$screenshotPath"',
      `node -e 'const fs = require("fs"); const bytes = fs.readFileSync(process.argv[1]); const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); if (bytes.length <= signature.length || !signature.equals(bytes.subarray(0, signature.length))) process.exit(1);' "$screenshotPath"`,
      'playwright-cli -s="$session" --json close',
    ].join("\n"),
    {
      env: {
        NO_UPDATE_NOTIFIER: "1",
        PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
        PLAYWRIGHT_MCP_ALLOWED_ORIGINS: "http://127.0.0.1:4173",
      },
      onStderr: (chunk) => process.stderr.write(chunk),
      onStdout: (chunk) => process.stdout.write(chunk),
    },
  );
  if (playwrightSession === undefined) {
    throw new Error(
      "Prepared Daytona workspace lacks submitted-code execution.",
    );
  }
  assertCommandSucceeded(
    "Playwright CLI local-page session smoke test",
    playwrightSession,
  );

  console.log(
    "Verifying trusted dynamic package-manager provisioning and private binding...",
  );
  const toolchainProjectRoot = `makeademo-toolchain-smoke-${crypto.randomUUID()}`;
  const toolchainProjectPath = `/workspace/${toolchainProjectRoot}`;
  const packageJson = JSON.stringify({
    packageManager: "pnpm@10.27.0",
  });
  const lockfile = "lockfileVersion: '9.0'\n";
  const projectFiles = [
    ["package.json", packageJson],
    ["pnpm-lock.yaml", lockfile],
  ] as const;
  const writeToolchainProject = await handle.workspace.execute(
    [
      `mkdir -p ${toolchainProjectPath}`,
      ...projectFiles.map(
        ([name, contents]) =>
          `printf '%s' '${Buffer.from(contents).toString("base64")}' | base64 -d > ${toolchainProjectPath}/${name}`,
      ),
    ].join(" && "),
  );
  assertCommandSucceeded(
    "toolchain smoke project setup",
    writeToolchainProject,
  );

  const dynamicPlan = resolveSubmittedCodeToolchain(
    {
      candidates: [
        {
          files: Object.fromEntries(projectFiles),
          projectRoot: toolchainProjectRoot,
        },
      ],
    },
    nodeReleases,
  );
  if (
    handle.workspace.provisionSubmittedCodeToolchain === undefined ||
    handle.workspace.syncSubmittedCodeWorkspace === undefined ||
    handle.workspace.executeSubmittedRuntime === undefined ||
    handle.workspace.executeMakeADemoCapture === undefined
  ) {
    throw new Error(
      "Prepared Daytona workspace lacks the submitted-code toolchain lifecycle.",
    );
  }
  await handle.workspace.provisionSubmittedCodeToolchain(dynamicPlan);
  await handle.workspace.syncSubmittedCodeWorkspace();
  const captureRuntimeSmokeDirectory =
    "/workspace/.makeademo/capture-runtime-smoke";
  const captureRuntimeSmokeScript = [
    'import { createRequire } from "node:module";',
    'import { chromium } from "/opt/makeademo/capture-runtime/playwright.mjs";',
    'if (process.execPath !== "/opt/makeademo/capture-runtime/bin/node") process.exit(1);',
    'const requireFromTrustedRuntime = createRequire("/opt/makeademo/playwright-runtime/node_modules/playwright/package.json");',
    'let metadata = requireFromTrustedRuntime("playwright/package.json");',
    'if (metadata.version !== "1.49.1") process.exit(1);',
    'metadata = requireFromTrustedRuntime("@playwright/test/package.json");',
    'if (metadata.version !== "1.49.1") process.exit(1);',
    'requireFromTrustedRuntime("playwright");',
    'requireFromTrustedRuntime("@playwright/test");',
    "const browser = await chromium.launch({ headless: true });",
    "await browser.close();",
    'console.log("trusted playwright chromium ok");',
  ].join("\n");
  const stageCaptureRuntimeSmoke =
    await handle.workspace.executeSubmittedCode?.(
      `mkdir -p '${captureRuntimeSmokeDirectory}' && printf '%s' '${Buffer.from(captureRuntimeSmokeScript).toString("base64")}' | base64 -d > '${captureRuntimeSmokeDirectory}/capture-smoke.mjs'`,
    );
  if (stageCaptureRuntimeSmoke === undefined) {
    throw new Error("Prepared Daytona workspace lacks submitted-code staging.");
  }
  assertCommandSucceeded(
    "capture runtime smoke staging",
    stageCaptureRuntimeSmoke,
  );
  const trustedPlaywrightRuntime =
    await handle.workspace.executeMakeADemoCapture({
      runDirectory: captureRuntimeSmokeDirectory,
      scriptPath: `${captureRuntimeSmokeDirectory}/capture-smoke.mjs`,
      stderrPath: `${captureRuntimeSmokeDirectory}/capture-smoke.stderr.log`,
      stdoutPath: `${captureRuntimeSmokeDirectory}/capture-smoke.stdout.log`,
      timeoutMs: 30_000,
    });
  assertCommandSucceeded(
    "fixed MakeADemo capture runtime Playwright Chromium launch",
    trustedPlaywrightRuntime,
  );
  if (
    !trustedPlaywrightRuntime.stdout.includes("trusted playwright chromium ok")
  ) {
    throw new Error(
      "Fixed MakeADemo capture runtime did not launch the trusted Playwright Chromium.",
    );
  }
  const offlineToolchain = await handle.workspace.executeSubmittedRuntime({
    command:
      'tool="$(command -v pnpm)" && case "$tool" in /opt/makeademo/toolchains/pnpm-*/*/bin/pnpm) ;; *) exit 1 ;; esac && test ! -w "$tool" && test ! -w "$(dirname "$tool")" && node --version && pnpm --version',
    plan: dynamicPlan,
  });
  assertCommandSucceeded(
    "dynamically provisioned pnpm with read-only trusted files",
    offlineToolchain,
  );
  if (
    !offlineToolchain.stdout.includes("v24.0.0") ||
    !offlineToolchain.stdout.includes("10.27.0")
  ) {
    throw new Error(
      "Unconstrained Node 24 and dynamically provisioned pnpm did not run from their trusted files.",
    );
  }

  await verifySubmittedToolchainMatrix({ snapshot, submittedCodeSnapshot });

  console.log("Prepared Daytona image verification passed.");
} finally {
  console.log(`Releasing and archiving Daytona workspace ${handle.id}...`);
  await handle.release();
}

type ToolchainMatrixCase = {
  files: ReadonlyArray<readonly [string, string]>;
  label: string;
  manager: "bun" | "npm" | "pnpm" | "yarn";
  nodeVersion: string;
  version: string;
};

async function verifySubmittedToolchainMatrix(input: {
  snapshot: string;
  submittedCodeSnapshot: string;
}): Promise<void> {
  const bunPackageJson = JSON.stringify({
    dependencies: { a: "workspace:*" },
    name: "makeademo-bun-smoke",
    packageManager: "bun@1.2.22",
    private: true,
    version: "1.0.0",
    workspaces: ["packages/*"],
  });
  const cases: readonly ToolchainMatrixCase[] = [
    {
      files: [
        [
          "package.json",
          JSON.stringify({
            name: "makeademo-npm-smoke",
            engines: { node: "18" },
            packageManager: "npm@9.9.4",
            version: "1.0.0",
          }),
        ],
        [
          "package-lock.json",
          JSON.stringify({
            lockfileVersion: 3,
            name: "makeademo-npm-smoke",
            packages: {
              "": { name: "makeademo-npm-smoke", version: "1.0.0" },
            },
            requires: true,
            version: "1.0.0",
          }),
        ],
      ],
      label: "npm modern",
      manager: "npm",
      nodeVersion: "18.20.8",
      version: "9.9.4",
    },
    {
      files: [
        [
          "package.json",
          JSON.stringify({
            name: "makeademo-pnpm-smoke",
            engines: { node: "20" },
            packageManager: "pnpm@10.26.1",
            version: "1.0.0",
          }),
        ],
        [
          "pnpm-lock.yaml",
          "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
        ],
      ],
      label: "pnpm modern",
      manager: "pnpm",
      nodeVersion: "20.19.5",
      version: "10.26.1",
    },
    {
      files: [
        [
          "package.json",
          JSON.stringify({
            name: "makeademo-yarn-classic-smoke",
            engines: { node: "22" },
            packageManager: "yarn@1.22.19",
            version: "1.0.0",
          }),
        ],
        ["yarn.lock", "# yarn lockfile v1\n"],
      ],
      label: "Yarn Classic",
      manager: "yarn",
      nodeVersion: "22.23.1",
      version: "1.22.19",
    },
    {
      files: [
        [
          "package.json",
          JSON.stringify({
            name: "makeademo-yarn-2-smoke",
            engines: { node: "24" },
            packageManager: "yarn@2.4.2",
            version: "1.0.0",
          }),
        ],
        [
          "yarn.lock",
          '# This file is generated by running "yarn install" inside your project.\n# Manual changes might be lost - proceed with caution!\n\n__metadata:\n  version: 4\n\n"makeademo-yarn-2-smoke@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "makeademo-yarn-2-smoke@workspace:."\n  languageName: unknown\n  linkType: soft\n',
        ],
      ],
      label: "Yarn 2",
      manager: "yarn",
      nodeVersion: "24.0.0",
      version: "2.4.2",
    },
    {
      files: [
        [
          "package.json",
          JSON.stringify({
            name: "makeademo-yarn-berry-smoke",
            engines: { node: "24" },
            packageManager: "yarn@4.11.0",
            version: "1.0.0",
          }),
        ],
        [
          "yarn.lock",
          '# This file is generated by running "yarn install" inside your project.\n# Manual changes might be lost - proceed with caution!\n\n__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"makeademo-yarn-berry-smoke@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "makeademo-yarn-berry-smoke@workspace:."\n  languageName: unknown\n  linkType: soft\n',
        ],
      ],
      label: "Yarn Berry",
      manager: "yarn",
      nodeVersion: "24.0.0",
      version: "4.11.0",
    },
    {
      files: [
        ["package.json", bunPackageJson],
        [
          "bun.lock",
          '{\n  "lockfileVersion": 1,\n  "configVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "makeademo-bun-smoke",\n      "dependencies": { "a": "workspace:*" }\n    },\n    "packages/a": { "name": "a", "version": "1.0.0" }\n  },\n  "packages": { "a": ["a@workspace:packages/a"] }\n}\n',
        ],
        [
          "packages/a/package.json",
          JSON.stringify({ name: "a", version: "1.0.0" }),
        ],
      ],
      label: "Bun 1",
      manager: "bun",
      nodeVersion: "24.0.0",
      version: "1.2.22",
    },
  ];

  for (const matrixCase of cases) {
    console.log(`Verifying ${matrixCase.label} trusted toolchain lifecycle...`);
    const provider = new DaytonaSdkPreparationWorkspaceProvider(input);
    const matrixHandle = await provider.create();
    try {
      const projectRoot = `makeademo-${matrixCase.manager}-${crypto.randomUUID()}`;
      const setup = await matrixHandle.workspace.execute(
        [
          `mkdir -p /workspace/${projectRoot}`,
          ...matrixCase.files.map(([name, contents]) => {
            const destination = `/workspace/${projectRoot}/${name}`;
            return `mkdir -p "$(dirname '${destination}')" && printf '%s' '${Buffer.from(contents).toString("base64")}' | base64 -d > '${destination}'`;
          }),
        ].join(" && "),
      );
      assertCommandSucceeded(`${matrixCase.label} fixture setup`, setup);
      const plan = resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: Object.fromEntries(
                matrixCase.files.filter(([name]) => !name.includes("/")),
              ),
              projectRoot,
            },
          ],
        },
        nodeReleases,
      );
      const workspace = matrixHandle.workspace;
      if (
        workspace.provisionSubmittedCodeToolchain === undefined ||
        workspace.syncSubmittedCodeWorkspace === undefined ||
        workspace.executeSubmittedProject === undefined ||
        workspace.executeSubmittedRuntime === undefined ||
        workspace.executeMakeADemoCapture === undefined
      ) {
        throw new Error(
          `${matrixCase.label} workspace lacks the submitted-code lifecycle.`,
        );
      }
      await workspace.provisionSubmittedCodeToolchain(plan);
      await workspace.syncSubmittedCodeWorkspace();

      const expectedBoundedArgv =
        matrixCase.manager === "npm"
          ? ["ci", "--maxsockets=4"]
          : matrixCase.manager === "pnpm"
            ? [
                "install",
                "--frozen-lockfile",
                "--child-concurrency=2",
                "--network-concurrency=4",
              ]
            : matrixCase.manager === "yarn" &&
                matrixCase.version.startsWith("1.")
              ? ["install", "--frozen-lockfile", "--network-concurrency", "4"]
              : plan.install?.argv;
      if (
        JSON.stringify(plan.install?.argv) !==
        JSON.stringify(expectedBoundedArgv)
      ) {
        throw new Error(
          `${matrixCase.label} did not plan its verified bounded argv.`,
        );
      }

      const capture = await executeDemoScriptInSandbox({
        baseUrl: "data:text/html,<body>toolchain independent capture</body>",
        demoPlaywrightScript: captureRuntimeContractScript(matrixCase.label),
        mode: "validation",
        remoteRunDirectory:
          "/workspace/.makeademo/toolchain-independent-capture",
        runtimeNetworkPolicy: "unrestricted-public",
        scriptFilename: "capture-contract.ts",
        timeoutMs: 30_000,
        workspace,
      });
      assertCommandSucceeded(
        `${matrixCase.label} toolchain-independent capture`,
        capture,
      );
      if (
        !capture.stdout.includes(
          `"sceneId":"${matrixCase.label}-capture-contract"`,
        )
      ) {
        throw new Error(
          `${matrixCase.label} did not run the fixed capture contract.`,
        );
      }

      const install = await workspace.executeSubmittedProject({
        argv: plan.install?.argv ?? [],
        executable: plan.install?.executable ?? matrixCase.manager,
        installProfile: "bounded",
        plan,
      });
      assertCommandSucceeded(`${matrixCase.label} immutable install`, install);

      const configurationProbe =
        matrixCase.manager === "yarn" && matrixCase.version.startsWith("4.")
          ? "YARN_TASK_POOL_CONCURRENCY=2 YARN_NETWORK_CONCURRENCY=4 yarn config get taskPoolConcurrency && YARN_TASK_POOL_CONCURRENCY=2 YARN_NETWORK_CONCURRENCY=4 yarn config get networkConcurrency"
          : matrixCase.manager === "yarn" &&
              !matrixCase.version.startsWith("1.")
            ? "YARN_NETWORK_CONCURRENCY=4 yarn config get networkConcurrency"
            : matrixCase.manager === "npm"
              ? "npm --maxsockets=4 config get maxsockets"
              : undefined;
      if (configurationProbe !== undefined) {
        const probe = await workspace.executeSubmittedRuntime({
          command: `cd /workspace/${projectRoot} && ${configurationProbe}`,
          plan,
        });
        assertCommandSucceeded(
          `${matrixCase.label} bounded configuration probe`,
          probe,
        );
        if (
          matrixCase.manager === "yarn" &&
          matrixCase.version.startsWith("4.") &&
          !probe.stdout.split(/\s+/).includes("2")
        ) {
          throw new Error(`${matrixCase.label} did not consume its CPU bound.`);
        }
        if (!probe.stdout.split(/\s+/).includes("4")) {
          throw new Error(
            `${matrixCase.label} did not consume its network bound.`,
          );
        }
      }

      const versionCommand = `node --version && ${matrixCase.manager} --version`;
      const trustedPathCheck = `tool="$(command -v ${matrixCase.manager})"; case "$tool" in /opt/makeademo/toolchains/${matrixCase.manager}-*/*/bin/${matrixCase.manager}) ;; *) exit 1 ;; esac; test ! -w "$tool"; test ! -w "$(dirname "$tool")"`;
      const offline = await workspace.executeSubmittedRuntime({
        command: `${trustedPathCheck}; ${versionCommand}`,
        plan,
      });
      assertCommandSucceeded(
        `${matrixCase.label} exact trusted-manager runtime`,
        offline,
      );
      if (
        !offline.stdout.includes(`v${matrixCase.nodeVersion}`) ||
        !offline.stdout.includes(matrixCase.version)
      ) {
        throw new Error(
          `${matrixCase.label} runtime did not report Node ${matrixCase.nodeVersion} and ${matrixCase.version}.`,
        );
      }
    } finally {
      await matrixHandle.release();
    }
  }
}

function assertCommandSucceeded(
  label: string,
  result: { exitCode: number; stderr: string; stdout: string },
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${[
        result.stderr,
        result.stdout,
      ]
        .filter((output) => output.length > 0)
        .join("\n")}`,
    );
  }
}

function captureRuntimeContractScript(label: string): string {
  const sceneId = `${label}-capture-contract`;
  return [
    "declare const process: { execPath: string };",
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async ({ page, baseUrl }) => {",
    '  if (process.execPath !== "/opt/makeademo/capture-runtime/bin/node") throw new Error("unexpected capture Node");',
    "  await page.goto(baseUrl);",
    "});",
    `await scene(${JSON.stringify(sceneId)}, async ({ page, expect }) => {`,
    "  await expect(page.locator('body')).toContainText('toolchain independent capture');",
    "});",
  ].join("\n");
}

function hasNonEmptyValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
