import { DaytonaSdkPreparationWorkspaceProvider } from "../src/server/shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";

const snapshot = process.env.MAKEADEMO_DAYTONA_SNAPSHOT;
const submittedCodeSnapshot =
  process.env.MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT;
const daytonaApiKey = process.env.DAYTONA_API_KEY;

if (daytonaApiKey === undefined) {
  throw new Error(
    "DAYTONA_API_KEY is required to verify the prepared Daytona image.",
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

console.log(`Creating Daytona workspace from snapshot ${snapshot}...`);
const provider = new DaytonaSdkPreparationWorkspaceProvider({
  snapshot,
  submittedCodeSnapshot,
});
const handle = await provider.create();
let submittedCodeNetworkOpened = false;

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
  if (handle.workspace.setSubmittedCodeNetworkAccess !== undefined) {
    await handle.workspace.setSubmittedCodeNetworkAccess(true);
    submittedCodeNetworkOpened = true;
  }
  const runtime = await handle.workspace.executeSubmittedCode?.(
    [
      'test "$(id -u)" -ne 0',
      "! touch /opt/mise/makeademo-mutation-test",
      "! touch /opt/corepack/makeademo-mutation-test",
      "touch /workspace/.makeademo/runtime-write-test",
      "rm -f /workspace/.makeademo/runtime-write-test",
      "node --version",
      "bun --version",
      "bunx tsc --version",
      "git --version",
      "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
      [
        'NODE_PATH="$(npm root -g)"',
        "node -e \"require('@playwright/test'); console.log('playwright ok')\"",
      ].join(" "),
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
  if (!runtime.stdout.includes("playwright ok")) {
    throw new Error("Submitted-code runtime did not load @playwright/test.");
  }
  if (handle.workspace.setSubmittedCodeNetworkAccess !== undefined) {
    await handle.workspace.setSubmittedCodeNetworkAccess(false);
    submittedCodeNetworkOpened = false;
  }

  console.log(
    "Verifying the Playwright CLI session lifecycle against a local page offline...",
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
    "offline Playwright CLI local-page session smoke test",
    playwrightSession,
  );

  for (const pnpmVersion of ["10.27.0", "11.13.0"] as const) {
    const projectToolchain = await handle.workspace.executeSubmittedCode?.(
      [
        "mise --no-config exec node@22.23.1 -- node --version",
        `mise --no-config exec node@22.23.1 -- corepack pnpm@${pnpmVersion} --version`,
      ].join(" && "),
      {
        env: {
          COREPACK_DEFAULT_TO_LATEST: "0",
          COREPACK_ENABLE_NETWORK: "0",
          COREPACK_ENABLE_PROJECT_SPEC: "1",
          COREPACK_ENABLE_STRICT: "1",
          COREPACK_ENV_FILE: "0",
          MISE_AUTO_INSTALL: "0",
          MISE_LOCKED: "1",
          MISE_NO_CONFIG: "1",
          MISE_OFFLINE: "1",
          MISE_PARANOID: "1",
        },
      },
    );
    if (projectToolchain === undefined) {
      throw new Error(
        "Prepared Daytona workspace lacks submitted-code execution.",
      );
    }
    assertCommandSucceeded(
      `network-blocked Node 22.23.1 / pnpm ${pnpmVersion}`,
      projectToolchain,
    );
    if (
      !projectToolchain.stdout.includes("v22.23.1") ||
      !projectToolchain.stdout.includes(pnpmVersion)
    ) {
      throw new Error(
        `Catalog toolchain output did not match pnpm ${pnpmVersion}.`,
      );
    }
  }

  console.log("Prepared Daytona image verification passed.");
} finally {
  try {
    if (
      submittedCodeNetworkOpened &&
      handle.workspace.setSubmittedCodeNetworkAccess !== undefined
    ) {
      await handle.workspace.setSubmittedCodeNetworkAccess(false);
    }
  } finally {
    console.log(`Releasing and archiving Daytona workspace ${handle.id}...`);
    await handle.release();
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
