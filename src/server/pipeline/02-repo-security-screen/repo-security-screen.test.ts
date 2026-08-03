import { describe, expect, it } from "vitest";

import {
  type RepoSecurityInput,
  screenRepoSecurity,
} from "./repo-security-screen";

describe("screenRepoSecurity", () => {
  it("surfaces scanner findings as warnings without deterministic rejection", () => {
    const result = screenRepoSecurity(
      repoInput([
        {
          findingCount: 1,
          findings: [
            {
              id: "GHSA-test",
              message: "Known vulnerable dependency",
              packageName: "example",
              path: "package-lock.json",
              scanner: "osv-scanner",
            },
          ],
          omittedFindingCount: 0,
          scanner: "osv-scanner",
          status: "completed",
          summary: "osv-scanner reported one advisory finding.",
          version: "2.3.8",
        },
      ]),
    );

    expect(result).toMatchObject({ rejections: [], status: "passed" });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "scanner-finding",
        path: "package-lock.json",
        ruleId: "GHSA-test",
        scanner: "osv-scanner",
        severity: "warning",
      }),
    );
  });

  it("treats scanner failure and timeout as incomplete coverage, not rejection", () => {
    const result = screenRepoSecurity(
      repoInput([
        failedReport("guarddog", "failed", "3.1.0"),
        failedReport("semgrep", "timed-out", "1.172.0"),
      ]),
    );

    expect(result).toMatchObject({ rejections: [], status: "passed" });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "scanner-incomplete",
        scanner: "guarddog",
      }),
      expect.objectContaining({
        code: "scanner-incomplete",
        scanner: "semgrep",
      }),
    ]);
  });
});

function repoInput(
  scannerReports: RepoSecurityInput["scannerReports"],
): RepoSecurityInput {
  return { scannerReports };
}

function failedReport(
  scanner: "guarddog" | "semgrep",
  status: "failed" | "timed-out",
  version: string,
): RepoSecurityInput["scannerReports"][number] {
  return {
    findingCount: 0,
    findings: [],
    omittedFindingCount: 0,
    scanner,
    status,
    summary: `${scanner} incomplete.`,
    version,
  };
}
