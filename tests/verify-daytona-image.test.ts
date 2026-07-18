import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Daytona image verifier", () => {
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
    expect(script).toContain('NODE_PATH="$(npm root -g)"');
    expect(script).toContain('assertCommandSucceeded("parent Git/CA trust"');
    expect(script).toContain('assertCommandSucceeded("submitted-code runtime"');
  });

  it("proves submitted lifecycle commands are unprivileged with immutable tool stores", async () => {
    const script = await readVerifierScript();

    expect(script).toContain('test "$(id -u)" -ne 0');
    expect(script).toContain("! touch /opt/mise/makeademo-mutation-test");
    expect(script).toContain("! touch /opt/corepack/makeademo-mutation-test");
    expect(script).toContain("touch /workspace/.makeademo/runtime-write-test");
  });

  it("checks both discriminating pnpm plans after submitted-code network closes", async () => {
    const script = await readVerifierScript();

    expect(script).toContain(
      'for (const pnpmVersion of ["10.27.0", "11.13.0"]',
    );
    expect(script).toContain(
      "mise --no-config exec node@22.23.1 -- node --version",
    );
    expect(script).toContain(
      "mise --no-config exec node@22.23.1 -- corepack pnpm@${pnpmVersion} --version",
    );
    expect(script).toContain('COREPACK_ENABLE_NETWORK: "0"');
    expect(script).toContain('MISE_OFFLINE: "1"');
    expect(script).toContain("setSubmittedCodeNetworkAccess(false)");
    expect(script.indexOf("setSubmittedCodeNetworkAccess(false)")).toBeLessThan(
      script.indexOf("mise --no-config exec node@22.23.1"),
    );
  });

  it("checks parent Git HTTPS trust again with configured Daytona provider secrets mounted", async () => {
    const script = await readVerifierScript();

    expect(script).toContain("createGitCloneCommand");
    expect(script).toContain("ensureOpenCodeProviderDaytonaSecret");
    expect(script).toContain("MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME");
    expect(script).toContain("daytonaApiKey");
    expect(script).toContain("secrets: providerSecrets");
    expect(script).toContain("Verifying secret-mounted parent Git/CA trust");
    expect(script).toContain("/tmp/makeademo-secret-mounted-git-ca-trust");
    expect(script).toMatch(
      /assertCommandSucceeded\(\s*"secret-mounted parent Git\/CA trust"/,
    );
  });

  it("uses Repo Preparation clone CA discovery for the secret-mounted parent Git check", async () => {
    const script = await readVerifierScript();

    expect(script).toContain(
      'import { createGitCloneCommand } from "../src/server/pipeline/03-repo-preparation/git-clone-command";',
    );
    expect(script).toMatch(
      /secretMountedHandle\.workspace\.execute\(\s*createGitCloneCommand\(\{[\s\S]*repoUrl: "https:\/\/github\.com\/octocat\/Hello-World\.git"/,
    );
    expect(script).not.toMatch(
      /secretMountedHandle\.workspace\.execute\(\s*\[[\s\S]*git ls-remote https:\/\/github\.com\/octocat\/Hello-World\.git HEAD/,
    );
  });

  it("does not link a submitted-code sandbox for the secret-mounted parent check", async () => {
    const script = await readVerifierScript();

    expect(script).toMatch(
      /new DaytonaSdkPreparationWorkspaceProvider\(\{\s*secrets: providerSecrets,\s*snapshot,/,
    );
    expect(script).not.toMatch(
      /new DaytonaSdkPreparationWorkspaceProvider\(\{\s*secrets: providerSecrets,\s*snapshot,\s*submittedCodeSnapshot,/,
    );
  });

  it("does not print local provider secrets while preparing the secret-mounted check", async () => {
    const script = await readVerifierScript();

    expect(script).not.toMatch(
      /console\.(?:log|error|warn)\([^)]*OPENAI_API_KEY/,
    );
    expect(script).not.toMatch(
      /process\.std(?:out|err)\.write\([^)]*OPENAI_API_KEY/,
    );
  });

  it("prints bounded CA diagnostics before the secret-mounted parent clone", async () => {
    const script = await readVerifierScript();

    const diagnosticsIndex = script.indexOf(
      "Printing secret-mounted parent Git/CA diagnostics",
    );
    const cloneIndex = script.indexOf(
      "Verifying secret-mounted parent Git/CA trust",
    );

    expect(diagnosticsIndex).toBeGreaterThanOrEqual(0);
    expect(cloneIndex).toBeGreaterThan(diagnosticsIndex);
    expect(script).toContain("createSecretMountedGitCaDiagnosticsCommand");
    expect(script).toContain("/etc/openshell-tls/ca-bundle.pem");
    expect(script).toContain("/etc/openshell-tls/openshell-ca.pem");
    expect(script).toContain("ls -ld /etc/openshell-tls");
    expect(script).toContain("readlink -f /etc/openshell-tls/ca-bundle.pem");
    expect(script).toContain("git config --show-origin --get http.sslCAInfo");
    expect(script).toContain("cut -c 1-500");
  });
});

async function readVerifierScript(): Promise<string> {
  return await readFile(
    join(import.meta.dirname, "..", "scripts", "verify-daytona-image.mts"),
    "utf8",
  );
}
