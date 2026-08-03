import type {
  RepoSecurityScannerName,
  RepoSecurityScannerReport,
} from "./repository-loading/repo-security-scanners";

export type RepoSecurityInput = {
  /** Advisory evidence produced by trusted scanners in the pinned parent. */
  scannerReports: RepoSecurityScannerReport[];
};

type RepoSecurityFinding = {
  code: "scanner-finding" | "scanner-findings-omitted" | "scanner-incomplete";
  line?: number;
  message: string;
  path?: string;
  ruleId?: string;
  scanner: RepoSecurityScannerName;
  severity: "warning";
};

export type RepoSecurityResult = {
  rejections: never[];
  status: "passed";
  warnings: RepoSecurityFinding[];
};

/**
 * Converts trusted scanner reports into advisory evidence. The security agent,
 * not this deterministic step, owns the final approval or rejection verdict.
 */
export function screenRepoSecurity(
  input: RepoSecurityInput,
): RepoSecurityResult {
  const warnings: RepoSecurityFinding[] = [];

  for (const report of input.scannerReports) {
    if (report.status !== "completed") {
      warnings.push({
        code: "scanner-incomplete",
        message: report.summary,
        scanner: report.scanner,
        severity: "warning",
      });
      continue;
    }

    for (const finding of report.findings) {
      warnings.push({
        code: "scanner-finding",
        ...(finding.line === undefined ? {} : { line: finding.line }),
        message: finding.message,
        ...(finding.path === undefined ? {} : { path: finding.path }),
        ruleId: finding.id,
        scanner: report.scanner,
        severity: "warning",
      });
    }

    if (report.omittedFindingCount > 0) {
      warnings.push({
        code: "scanner-findings-omitted",
        message: `${report.scanner} omitted ${report.omittedFindingCount} additional findings from the bounded review report.`,
        scanner: report.scanner,
        severity: "warning",
      });
    }
  }

  return { rejections: [], status: "passed", warnings };
}
