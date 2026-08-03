import { describe, expect, it } from "vitest";

import {
  type RepoSecurityScannerWorkspace,
  runRepoSecurityScanners,
} from "./repo-security-scanners";

describe("runRepoSecurityScanners", () => {
  it("returns bounded normalized warnings from the three trusted scanners", async () => {
    const commands: Array<{ command: string; timeoutMs: number | undefined }> =
      [];
    const workspace: RepoSecurityScannerWorkspace = {
      async executeRepositoryCommand(command, options) {
        commands.push({ command, timeoutMs: options?.timeoutMs });
        if (command.includes("osv-scanner")) {
          return commandResult(
            JSON.stringify({
              results: [
                {
                  packages: [
                    {
                      package: {
                        ecosystem: "npm",
                        name: "example",
                        version: "1.0.0",
                      },
                      vulnerabilities: [
                        { id: "GHSA-test", summary: "Known vulnerability" },
                      ],
                    },
                  ],
                  source: { path: "/workspace/package-lock.json" },
                },
              ],
            }),
          );
        }
        if (command.includes("guarddog")) {
          return commandResult(
            JSON.stringify({
              package: "/workspace",
              results: {
                "npm-exec-base64": [
                  {
                    code: "eval(Buffer.from(value, 'base64'))",
                    location: "scripts/install.js:4",
                    message: "Encoded content is executed.",
                  },
                ],
              },
              risk_score: { score: 91 },
              risks: [
                {
                  threat_location: "scripts/install.js:4",
                  threat_rule: "npm-exec-base64",
                },
              ],
            }),
          );
        }
        return commandResult(
          JSON.stringify({
            errors: [],
            results: [
              {
                check_id: "makeademo.remote-download-execution",
                extra: {
                  message: "Downloads remote content into a shell.",
                  severity: "ERROR",
                },
                path: "/workspace/scripts/install.sh",
                start: { line: 2 },
              },
            ],
          }),
        );
      },
    };

    const reports = await runRepoSecurityScanners(workspace);

    expect(reports).toEqual([
      expect.objectContaining({
        findingCount: 1,
        findings: [
          expect.objectContaining({
            id: "GHSA-test",
            path: "package-lock.json",
            scanner: "osv-scanner",
          }),
        ],
        scanner: "osv-scanner",
        status: "completed",
        version: "2.3.8",
      }),
      expect.objectContaining({
        findingCount: 1,
        findings: [
          expect.objectContaining({
            id: "npm-exec-base64",
            line: 4,
            path: "scripts/install.js",
            scanner: "guarddog",
          }),
        ],
        scanner: "guarddog",
        status: "completed",
        version: "3.1.0",
      }),
      expect.objectContaining({
        findingCount: 1,
        findings: [
          expect.objectContaining({
            id: "makeademo.remote-download-execution",
            line: 2,
            path: "scripts/install.sh",
            scanner: "semgrep",
          }),
        ],
        scanner: "semgrep",
        status: "completed",
        version: "1.172.0",
      }),
    ]);
    expect(commands).toHaveLength(3);
    expect(commands.every(({ timeoutMs }) => timeoutMs === 60_000)).toBe(true);
    expect(commands.map(({ command }) => command)).toEqual([
      expect.stringContaining(
        "/opt/makeademo/security-tools/osv-scanner scan source",
      ),
      expect.stringContaining(
        "/opt/makeademo/security-tools/guarddog/bin/guarddog npm scan",
      ),
      expect.stringContaining(
        "/opt/makeademo/security-tools/semgrep/bin/semgrep scan",
      ),
    ]);
    expect(commands[0]?.command).toContain("--allow-no-lockfiles");
    expect(commands[1]?.command).toContain("/workspace");
    expect(commands[2]?.command).toContain(
      "/opt/makeademo/security/semgrep-rules.yml",
    );
    expect(
      commands.every(({ command }) =>
        command.includes("/usr/bin/head -c 1048576"),
      ),
    ).toBe(true);
    expect(
      commands.every(({ command }) =>
        command.includes('/usr/bin/mkdir -p -- "${TMPDIR}"'),
      ),
    ).toBe(true);
    expect(
      commands.every(
        ({ command }) =>
          command.indexOf('/usr/bin/mkdir -p -- "${TMPDIR}"') <
          command.indexOf("/usr/bin/mktemp"),
      ),
    ).toBe(true);
    expect(
      commands.every(({ command }) =>
        command.includes("/usr/bin/timeout --signal=KILL 55s"),
      ),
    ).toBe(true);
  });

  it("keeps scanner failures, timeouts, and excess findings as warning-only coverage", async () => {
    let invocation = 0;
    const workspace: RepoSecurityScannerWorkspace = {
      async executeRepositoryCommand() {
        invocation += 1;
        if (invocation === 1) {
          return { exitCode: 2, stderr: "OSV_SECRET_ERROR", stdout: "" };
        }
        if (invocation === 2) {
          throw new Error("Daytona command did not finish within 60000ms");
        }
        return commandResult(
          JSON.stringify({
            errors: [],
            results: Array.from({ length: 60 }, (_, index) => ({
              check_id: `makeademo.test-${index}`,
              extra: { message: `Finding ${index}` },
              path: `/workspace/file-${index}.js`,
              start: { line: index + 1 },
            })),
          }),
        );
      },
    };

    const reports = await runRepoSecurityScanners(workspace);

    expect(reports[0]).toMatchObject({
      findingCount: 0,
      findings: [],
      scanner: "osv-scanner",
      status: "failed",
    });
    expect(reports[0]?.summary).not.toContain("OSV_SECRET_ERROR");
    expect(reports[1]).toMatchObject({
      findingCount: 0,
      findings: [],
      scanner: "guarddog",
      status: "timed-out",
    });
    expect(reports[2]).toMatchObject({
      findingCount: 60,
      omittedFindingCount: 10,
      scanner: "semgrep",
      status: "completed",
    });
    expect(reports[2]?.findings).toHaveLength(50);
  });

  it("retains parseable findings but marks a nonzero scanner exit as incomplete", async () => {
    let invocation = 0;
    const workspace: RepoSecurityScannerWorkspace = {
      async executeRepositoryCommand() {
        invocation += 1;
        if (invocation === 1) {
          return {
            exitCode: 2,
            stderr: "fatal scanner detail that must not be forwarded",
            stdout: JSON.stringify({
              results: [
                {
                  packages: [
                    {
                      package: { name: "example", version: "1.0.0" },
                      vulnerabilities: [
                        { id: "GHSA-partial", summary: "Retained lead" },
                      ],
                    },
                  ],
                  source: { path: "/workspace/package-lock.json" },
                },
              ],
            }),
          };
        }
        return commandResult(JSON.stringify({ errors: [], results: [] }));
      },
    };

    const reports = await runRepoSecurityScanners(workspace);

    expect(reports[0]).toMatchObject({
      coverageWarnings: [expect.objectContaining({ code: "nonzero-exit" })],
      findingCount: 1,
      findings: [expect.objectContaining({ id: "GHSA-partial" })],
      scanner: "osv-scanner",
      status: "failed",
    });
    expect(reports[0]?.summary).not.toContain(
      "fatal scanner detail that must not be forwarded",
    );
  });

  it("treats OSV's vulnerability-found exit as a complete report", async () => {
    let invocation = 0;
    const workspace: RepoSecurityScannerWorkspace = {
      async executeRepositoryCommand() {
        invocation += 1;
        if (invocation === 1) {
          return {
            exitCode: 1,
            stderr: "",
            stdout: JSON.stringify({
              results: [
                {
                  packages: [
                    {
                      package: { name: "example", version: "1.0.0" },
                      vulnerabilities: [
                        { id: "GHSA-found", summary: "Known vulnerability" },
                      ],
                    },
                  ],
                  source: { path: "/workspace/package-lock.json" },
                },
              ],
            }),
          };
        }
        return commandResult(JSON.stringify({ errors: [], results: [] }));
      },
    };

    const reports = await runRepoSecurityScanners(workspace);

    expect(reports[0]).toMatchObject({
      findingCount: 1,
      scanner: "osv-scanner",
      status: "completed",
    });
    expect(reports[0]?.coverageWarnings).toBeUndefined();
  });

  it("retains findings while surfacing GuardDog and Semgrep native errors as incomplete coverage", async () => {
    const workspace: RepoSecurityScannerWorkspace = {
      async executeRepositoryCommand(command) {
        if (command.includes("osv-scanner")) {
          return commandResult(JSON.stringify({ results: [] }));
        }
        if (command.includes("guarddog")) {
          return commandResult(
            JSON.stringify({
              errors: [
                {
                  code: "guarddog-timeout",
                  message: "One manifest could not be scanned.",
                  path: "/workspace/packages/app/package.json",
                  reference: "https://example.invalid/guarddog-timeout",
                },
              ],
              results: {
                "npm-install-script": [
                  {
                    location: "package.json:8",
                    message: "Install script requires review.",
                  },
                ],
              },
            }),
          );
        }
        return commandResult(
          JSON.stringify({
            errors: [
              {
                code: 3,
                level: "error",
                message: "A target could not be parsed.",
                path: "/workspace/src/broken.js",
                type: "Parse error",
              },
            ],
            results: [
              {
                check_id: "makeademo.remote-download-execution",
                extra: { message: "Downloads and executes remote content." },
                path: "/workspace/scripts/install.sh",
                start: { line: 2 },
              },
            ],
          }),
        );
      },
    };

    const reports = await runRepoSecurityScanners(workspace);

    expect(reports[1]).toMatchObject({
      coverageWarnings: [
        {
          code: "guarddog-timeout",
          message: "One manifest could not be scanned.",
          path: "packages/app/package.json",
          reference: "https://example.invalid/guarddog-timeout",
        },
      ],
      findingCount: 1,
      scanner: "guarddog",
      status: "failed",
    });
    expect(reports[2]).toMatchObject({
      coverageWarnings: [
        expect.objectContaining({
          code: "Parse error",
          message: "A target could not be parsed.",
          path: "src/broken.js",
        }),
      ],
      findingCount: 1,
      scanner: "semgrep",
      status: "failed",
    });
  });

  it("bounds every untrusted field and the aggregate normalized report", async () => {
    const long = "x".repeat(10_000);
    const workspace: RepoSecurityScannerWorkspace = {
      async executeRepositoryCommand(command) {
        if (!command.includes("osv-scanner")) {
          return commandResult(JSON.stringify({ errors: [], results: [] }));
        }
        return commandResult(
          JSON.stringify({
            results: [
              {
                packages: [
                  {
                    package: { name: long, version: long },
                    vulnerabilities: Array.from({ length: 60 }, () => ({
                      id: long,
                      summary: long,
                    })),
                  },
                ],
                source: { path: `/workspace/${long}` },
              },
            ],
          }),
        );
      },
    };

    const [report] = await runRepoSecurityScanners(workspace);

    expect(report).toBeDefined();
    expect(
      Buffer.byteLength(JSON.stringify(report), "utf8"),
    ).toBeLessThanOrEqual(128 * 1_024);
    expect(report?.findingCount).toBe(60);
    expect(report?.findings.length).toBeLessThanOrEqual(50);
    expect(report?.omittedFindingCount).toBeGreaterThanOrEqual(10);
    expect(report?.normalization).toMatchObject({
      truncatedFieldCount: expect.any(Number),
    });
    expect(report?.normalization?.truncatedFieldCount).toBeGreaterThan(0);
    for (const finding of report?.findings ?? []) {
      expect(finding.id.length).toBeLessThanOrEqual(256);
      expect(finding.message.length).toBeLessThanOrEqual(2_048);
      expect(finding.path?.length).toBeLessThanOrEqual(1_024);
      expect(finding.packageName?.length).toBeLessThanOrEqual(256);
      expect(finding.packageVersion?.length).toBeLessThanOrEqual(128);
    }
  });

  it("propagates cancellation instead of converting it into scanner coverage warnings", async () => {
    const controller = new AbortController();
    let commandCount = 0;
    const workspace: RepoSecurityScannerWorkspace = {
      async executeRepositoryCommand() {
        commandCount += 1;
        controller.abort(new Error("pipeline cancelled"));
        throw controller.signal.reason;
      },
    };

    await expect(
      runRepoSecurityScanners(workspace, { signal: controller.signal }),
    ).rejects.toThrow("pipeline cancelled");
    expect(commandCount).toBe(1);
  });
});

function commandResult(stdout: string) {
  return { exitCode: 0, stderr: "", stdout };
}
