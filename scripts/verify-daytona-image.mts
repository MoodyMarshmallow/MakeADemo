import { createGitCloneCommand } from "../src/server/pipeline/03-repo-preparation/git-clone-command";
import {
  createOpenCodeProviderSandboxSecrets,
  ensureOpenCodeProviderDaytonaSecret,
} from "../src/server/shared/integrations/agents/opencode-provider-secrets";
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

const providerSecrets =
  await readConfiguredOpenCodeProviderSecrets(daytonaApiKey);

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

  console.log(
    `Verifying preloaded submitted-code runtime image in ${handle.id}...`,
  );
  if (handle.workspace.setSubmittedCodeNetworkAccess !== undefined) {
    await handle.workspace.setSubmittedCodeNetworkAccess(true);
    submittedCodeNetworkOpened = true;
  }
  const runtime = await handle.workspace.executeSubmittedCode?.(
    [
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

  if (providerSecrets === undefined) {
    console.log(
      "Skipping secret-mounted parent Git/CA trust: no Daytona provider secret config available.",
    );
  } else {
    console.log(
      "Creating Daytona workspace with configured provider secrets mounted...",
    );
    const secretMountedProvider = new DaytonaSdkPreparationWorkspaceProvider({
      secrets: providerSecrets,
      snapshot,
    });
    const secretMountedHandle = await secretMountedProvider.create();
    try {
      console.log(
        `Printing secret-mounted parent Git/CA diagnostics in ${secretMountedHandle.id}...`,
      );
      await secretMountedHandle.workspace.execute(
        createSecretMountedGitCaDiagnosticsCommand(),
        {
          onStderr: (chunk) => process.stderr.write(chunk),
          onStdout: (chunk) => process.stdout.write(chunk),
        },
      );
      console.log(
        `Verifying secret-mounted parent Git/CA trust in ${secretMountedHandle.id}...`,
      );
      const secretMountedParentGitTrust =
        await secretMountedHandle.workspace.execute(
          createGitCloneCommand({
            destinationPath: "/tmp/makeademo-secret-mounted-git-ca-trust",
            repoUrl: "https://github.com/octocat/Hello-World.git",
            resetCommand: "rm -rf /tmp/makeademo-secret-mounted-git-ca-trust",
          }),
          {
            onStderr: (chunk) => process.stderr.write(chunk),
            onStdout: (chunk) => process.stdout.write(chunk),
          },
        );
      assertCommandSucceeded(
        "secret-mounted parent Git/CA trust",
        secretMountedParentGitTrust,
      );
    } finally {
      console.log(
        `Releasing and archiving secret-mounted Daytona workspace ${secretMountedHandle.id}...`,
      );
      await secretMountedHandle.release();
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

async function readConfiguredOpenCodeProviderSecrets(
  daytonaApiKey: string,
): Promise<Record<string, string> | undefined> {
  const configuredOpenAiSecretName =
    process.env.MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME?.trim();
  const hasLocalOpenAiProviderConfig =
    process.env.OPENAI_API_KEY !== undefined &&
    process.env.OPENAI_API_KEY.trim().length > 0;

  if (hasLocalOpenAiProviderConfig) {
    const providerSecretName = await ensureOpenCodeProviderDaytonaSecret({
      daytonaApiKey,
      providerID: "openai",
    });

    return createOpenCodeProviderSandboxSecrets({
      providerID: "openai",
      providerSecretName,
    });
  }

  if (
    configuredOpenAiSecretName === undefined ||
    configuredOpenAiSecretName.length === 0
  ) {
    return undefined;
  }

  return createOpenCodeProviderSandboxSecrets({
    providerID: "openai",
    providerSecretName: configuredOpenAiSecretName,
  });
}

function createSecretMountedGitCaDiagnosticsCommand(): string {
  return `timeout 5s sh -lc ${shellQuote(
    [
      "printf 'makeademo_secret_mounted_git_ca_diagnostics=1\\n'",
      'for makeademo_ca_env_name in GIT_SSL_CAINFO SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE NODE_EXTRA_CA_CERTS; do eval "makeademo_ca_env_value=\\${$makeademo_ca_env_name-}"; if test -n "$makeademo_ca_env_value"; then case "$makeademo_ca_env_value" in /*) printf \'ca_env_path_%s=\' "$makeademo_ca_env_name"; printf \'%s\\n\' "$makeademo_ca_env_value" | cut -c 1-500 ;; *) printf \'ca_env_name_%s=set\\n\' "$makeademo_ca_env_name" ;; esac; fi; done',
      "ls -ld /etc/openshell-tls 2>&1 | cut -c 1-500 || true",
      "ls -l /etc/openshell-tls/ca-bundle.pem /etc/openshell-tls/openshell-ca.pem 2>/dev/null | cut -c 1-500 || true",
      "readlink -f /etc/openshell-tls/ca-bundle.pem 2>&1 | cut -c 1-500 || true",
      "git config --show-origin --get http.sslCAInfo 2>&1 | cut -c 1-500 || true",
    ].join("\n"),
  )}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
