import {
  type RepoSecurityScannerName,
  readRepoSecurityScannerSmokeCommands,
} from "../src/server/pipeline/02-repo-security-screen/repository-loading/repo-security-scanners";
import type { PreparationWorkspace } from "../src/server/pipeline/03-repo-preparation/preparation-workspace.interface";

type ScannerSmokeResult = {
  resultCount: number;
  scanner: RepoSecurityScannerName;
};

const fixtureFiles = [
  [
    "package.json",
    JSON.stringify({
      name: "makeademo-security-scanner-smoke",
      private: true,
      version: "1.0.0",
    }),
  ],
  [
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      name: "makeademo-security-scanner-smoke",
      packages: {
        "": {
          dependencies: { "is-number": "7.0.0" },
          name: "makeademo-security-scanner-smoke",
          version: "1.0.0",
        },
        "node_modules/is-number": {
          resolved:
            "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
          version: "7.0.0",
        },
      },
      requires: true,
      version: "1.0.0",
    }),
  ],
  ["makeademo-security-scanner-smoke.js", 'console.log("hello");\n'],
] as const;

/** Runs every Stage 02 scanner command and proves its raw JSON envelope. */
export async function verifyRepoSecurityScannerSmoke(
  workspace: PreparationWorkspace,
): Promise<ScannerSmokeResult[]> {
  if (workspace.executeRepositoryCommand === undefined) {
    throw new Error(
      "Prepared Daytona workspace lacks unprivileged repository commands.",
    );
  }
  const fixturePaths = fixtureFiles.map(([name]) => `/workspace/${name}`);
  const setup = await workspace.executeRepositoryCommand(
    [
      ...fixturePaths.map((path) => `test ! -e ${shellQuote(path)}`),
      ...fixtureFiles.map(
        ([name, contents]) =>
          `printf %s ${shellQuote(Buffer.from(contents).toString("base64"))} | /usr/bin/base64 --decode > ${shellQuote(`/workspace/${name}`)}`,
      ),
    ].join(" && "),
    { timeoutMs: 15_000 },
  );
  assertCommandSucceeded("security scanner fixture setup", setup);

  try {
    const results: ScannerSmokeResult[] = [];
    for (const scanner of readRepoSecurityScannerSmokeCommands()) {
      const execution = await workspace.executeRepositoryCommand(
        scanner.command,
        { timeoutMs: 60_000 },
      );
      assertCommandSucceeded(`${scanner.scanner} JSON smoke`, execution);
      results.push({
        resultCount: assertRepoSecurityScannerJsonContract(
          scanner.scanner,
          execution.stdout,
        ),
        scanner: scanner.scanner,
      });
    }
    return results;
  } finally {
    await workspace.executeRepositoryCommand(
      `/usr/bin/rm -f -- ${fixturePaths.map(shellQuote).join(" ")}`,
      { timeoutMs: 15_000 },
    );
  }
}

/** Parses one raw scanner response and asserts the envelope consumed by Stage 02. */
export function assertRepoSecurityScannerJsonContract(
  scanner: RepoSecurityScannerName,
  stdout: string,
): number {
  if (Buffer.byteLength(stdout, "utf8") > 1_048_576) {
    throw new Error(`${scanner} returned oversized smoke output.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`${scanner} returned malformed JSON.`);
  }
  if (!isRecord(value)) {
    throw new Error(`${scanner} returned a non-object JSON envelope.`);
  }
  if (scanner === "guarddog") {
    if (!isRecord(value.results)) {
      throw new Error("guarddog JSON omitted its results object.");
    }
    return Object.keys(value.results).length;
  }
  if (!Array.isArray(value.results)) {
    throw new Error(`${scanner} JSON omitted its results array.`);
  }
  if (scanner === "semgrep" && !Array.isArray(value.errors)) {
    throw new Error("semgrep JSON omitted its errors array.");
  }
  return value.results.length;
}

function assertCommandSucceeded(
  label: string,
  result: { exitCode: number },
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${result.exitCode}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
