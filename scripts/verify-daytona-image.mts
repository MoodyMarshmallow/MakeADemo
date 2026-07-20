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
