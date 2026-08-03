export type RepoSecurityScannerName = "guarddog" | "osv-scanner" | "semgrep";

type RepoSecurityScannerFinding = {
  id: string;
  line?: number;
  message: string;
  packageName?: string;
  packageVersion?: string;
  path?: string;
  scanner: RepoSecurityScannerName;
};

type RepoSecurityScannerCoverageWarning = {
  code?: string;
  message: string;
  path?: string;
  reference?: string;
};

/**
 * Bounded scanner evidence for the read-only Repo Security reviewer.
 * Scanner failures and findings are advisory; neither is approval authority.
 */
export type RepoSecurityScannerReport = {
  coverageWarnings?: RepoSecurityScannerCoverageWarning[];
  findingCount: number;
  findings: RepoSecurityScannerFinding[];
  normalization?: {
    omittedCoverageWarningCount: number;
    truncatedFieldCount: number;
  };
  omittedFindingCount: number;
  scanner: RepoSecurityScannerName;
  status: "completed" | "failed" | "timed-out";
  summary: string;
  version: string;
};

type RepoSecurityScannerWorkspaceCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

/** Executes only backend-authored, unprivileged commands in the pinned parent. */
export interface RepoSecurityScannerWorkspace {
  executeRepositoryCommand(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<RepoSecurityScannerWorkspaceCommandResult>;
}

type ScannerDefinition = {
  command: string;
  completedExitCodes?: readonly number[];
  expectedVersion: string;
  name: RepoSecurityScannerName;
  nativeErrors?: true;
  normalize(value: unknown): RepoSecurityScannerFinding[];
};

const scannerTimeoutMs = 60_000;
const scannerProcessTimeoutSeconds = 55;
const maxScannerStdoutBytes = 1_048_576;
const maxScannerStderrBytes = 16_384;
const maxFindingsPerScanner = 50;
const maxCoverageWarningsPerScanner = 10;
const maxNormalizedReportBytes = 128 * 1_024;
const maxFindingIdBytes = 256;
const maxFindingMessageBytes = 2_048;
const maxFindingPathBytes = 1_024;
const maxPackageNameBytes = 256;
const maxPackageVersionBytes = 128;
const maxCoverageWarningCodeBytes = 256;
const maxCoverageWarningMessageBytes = 2_048;
const maxCoverageWarningPathBytes = 1_024;
const maxCoverageWarningReferenceBytes = 1_024;

const scanners: readonly ScannerDefinition[] = [
  {
    command:
      "/opt/makeademo/security-tools/osv-scanner scan source --recursive --allow-no-lockfiles --format json /workspace",
    completedExitCodes: [0, 1],
    expectedVersion: "2.3.8",
    name: "osv-scanner",
    normalize: normalizeOsvFindings,
  },
  {
    command:
      "/usr/bin/env GUARDDOG_PARALLELISM=2 GUARDDOG_SEMGREP_MAX_TARGET_BYTES=1000000 GUARDDOG_SEMGREP_TIMEOUT=10 /opt/makeademo/security-tools/guarddog/bin/guarddog npm scan --no-sandbox --output-format=json /workspace",
    expectedVersion: "3.1.0",
    name: "guarddog",
    nativeErrors: true,
    normalize: normalizeGuarddogFindings,
  },
  {
    command:
      "/usr/bin/env SEMGREP_SEND_METRICS=off /opt/makeademo/security-tools/semgrep/bin/semgrep scan --config /opt/makeademo/security/semgrep-rules.yml --json --metrics=off --disable-version-check --timeout 10 --max-target-bytes 1000000 --exclude .git --exclude node_modules /workspace",
    expectedVersion: "1.172.0",
    name: "semgrep",
    nativeErrors: true,
    normalize: normalizeSemgrepFindings,
  },
];

/** Returns the exact trusted scanner argv-shell commands used by Stage 02. */
export function readRepoSecurityScannerSmokeCommands(): readonly {
  command: string;
  scanner: RepoSecurityScannerName;
}[] {
  return scanners.map(({ command, name }) => ({ command, scanner: name }));
}

/**
 * Runs MakeADemo's trusted static scanners without installing or executing
 * submitted repository code. Every report is warning-only evidence.
 */
export async function runRepoSecurityScanners(
  workspace: RepoSecurityScannerWorkspace,
  options: { signal?: AbortSignal } = {},
): Promise<RepoSecurityScannerReport[]> {
  const reports: RepoSecurityScannerReport[] = [];
  for (const scanner of scanners) {
    options.signal?.throwIfAborted();
    reports.push(await runScanner(workspace, scanner, options.signal));
  }
  return reports;
}

async function runScanner(
  workspace: RepoSecurityScannerWorkspace,
  scanner: ScannerDefinition,
  signal: AbortSignal | undefined,
): Promise<RepoSecurityScannerReport> {
  try {
    const result = await workspace.executeRepositoryCommand(
      createBoundedScannerCommand(scanner.command),
      {
        timeoutMs: scannerTimeoutMs,
      },
    );
    const parsed = JSON.parse(result.stdout) as unknown;
    signal?.throwIfAborted();
    const allFindings = scanner.normalize(parsed);
    const completedExit = (scanner.completedExitCodes ?? [0]).includes(
      result.exitCode,
    );
    const coverageWarnings = [
      ...(completedExit ? [] : [createExitCoverageWarning(result.exitCode)]),
      ...(scanner.nativeErrors === true
        ? normalizeNativeCoverageWarnings(readRecord(parsed).errors)
        : []),
    ];
    const timedOut = result.exitCode === 124 || result.exitCode === 137;
    const status = timedOut
      ? "timed-out"
      : !completedExit || coverageWarnings.length > 0
        ? "failed"
        : "completed";
    return createBoundedReport({
      allFindings,
      coverageWarnings,
      expectedVersion: scanner.expectedVersion,
      scanner: scanner.name,
      status,
    });
  } catch (error) {
    signal?.throwIfAborted();
    const timedOut = /timed?\s*out|timeout|did not finish/i.test(
      readErrorMessage(error),
    );
    return {
      findingCount: 0,
      findings: [],
      omittedFindingCount: 0,
      scanner: scanner.name,
      status: timedOut ? "timed-out" : "failed",
      summary: `${scanner.name} ${timedOut ? "timed out" : "could not produce a valid report"}; this is incomplete coverage, not a rejection.`,
      version: scanner.expectedVersion,
    };
  }
}

function createExitCoverageWarning(
  exitCode: number,
): RepoSecurityScannerCoverageWarning {
  const timedOut = exitCode === 124 || exitCode === 137;
  return {
    code: timedOut ? "scanner-timeout" : "nonzero-exit",
    message: timedOut
      ? "The scanner process timed out, so its results may be incomplete."
      : `The scanner process exited with status ${exitCode}, so its results may be incomplete.`,
  };
}

function createBoundedReport(input: {
  allFindings: RepoSecurityScannerFinding[];
  coverageWarnings: RepoSecurityScannerCoverageWarning[];
  expectedVersion: string;
  scanner: RepoSecurityScannerName;
  status: RepoSecurityScannerReport["status"];
}): RepoSecurityScannerReport {
  const normalization = { truncatedFieldCount: 0 };
  const findings = input.allFindings
    .slice(0, maxFindingsPerScanner)
    .map((finding) => boundFinding(finding, normalization));
  const coverageWarnings = input.coverageWarnings
    .slice(0, maxCoverageWarningsPerScanner)
    .map((warning) => boundCoverageWarning(warning, normalization));
  let omittedCoverageWarningCount = Math.max(
    0,
    input.coverageWarnings.length - coverageWarnings.length,
  );

  const report = (): RepoSecurityScannerReport => ({
    ...(coverageWarnings.length === 0 ? {} : { coverageWarnings }),
    findingCount: input.allFindings.length,
    findings,
    ...(normalization.truncatedFieldCount === 0 &&
    omittedCoverageWarningCount === 0
      ? {}
      : {
          normalization: {
            omittedCoverageWarningCount,
            truncatedFieldCount: normalization.truncatedFieldCount,
          },
        }),
    omittedFindingCount: input.allFindings.length - findings.length,
    scanner: input.scanner,
    status: input.status,
    summary: createReportSummary(
      input.scanner,
      input.status,
      input.allFindings.length,
    ),
    version: input.expectedVersion,
  });

  while (
    findings.length > 0 &&
    Buffer.byteLength(JSON.stringify(report()), "utf8") >
      maxNormalizedReportBytes
  ) {
    findings.pop();
  }
  while (
    coverageWarnings.length > 0 &&
    Buffer.byteLength(JSON.stringify(report()), "utf8") >
      maxNormalizedReportBytes
  ) {
    coverageWarnings.pop();
    omittedCoverageWarningCount += 1;
  }
  return report();
}

function createReportSummary(
  scanner: RepoSecurityScannerName,
  status: RepoSecurityScannerReport["status"],
  findingCount: number,
): string {
  if (status === "timed-out") {
    return `${scanner} timed out after reporting ${findingCount} advisory finding${findingCount === 1 ? "" : "s"}; coverage is incomplete, not a rejection.`;
  }
  if (status === "failed") {
    return `${scanner} reported ${findingCount} advisory finding${findingCount === 1 ? "" : "s"} with incomplete coverage; this is not a rejection.`;
  }
  return findingCount === 0
    ? `${scanner} completed without findings.`
    : `${scanner} reported ${findingCount} advisory finding${findingCount === 1 ? "" : "s"}.`;
}

function boundFinding(
  finding: RepoSecurityScannerFinding,
  normalization: { truncatedFieldCount: number },
): RepoSecurityScannerFinding {
  return {
    id: boundText(finding.id, maxFindingIdBytes, normalization),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    message: boundText(finding.message, maxFindingMessageBytes, normalization),
    ...(finding.packageName === undefined
      ? {}
      : {
          packageName: boundText(
            finding.packageName,
            maxPackageNameBytes,
            normalization,
          ),
        }),
    ...(finding.packageVersion === undefined
      ? {}
      : {
          packageVersion: boundText(
            finding.packageVersion,
            maxPackageVersionBytes,
            normalization,
          ),
        }),
    ...(finding.path === undefined
      ? {}
      : {
          path: boundText(finding.path, maxFindingPathBytes, normalization),
        }),
    scanner: finding.scanner,
  };
}

function boundCoverageWarning(
  warning: RepoSecurityScannerCoverageWarning,
  normalization: { truncatedFieldCount: number },
): RepoSecurityScannerCoverageWarning {
  return {
    ...(warning.code === undefined
      ? {}
      : {
          code: boundText(
            warning.code,
            maxCoverageWarningCodeBytes,
            normalization,
          ),
        }),
    message: boundText(
      warning.message,
      maxCoverageWarningMessageBytes,
      normalization,
    ),
    ...(warning.path === undefined
      ? {}
      : {
          path: boundText(
            warning.path,
            maxCoverageWarningPathBytes,
            normalization,
          ),
        }),
    ...(warning.reference === undefined
      ? {}
      : {
          reference: boundText(
            warning.reference,
            maxCoverageWarningReferenceBytes,
            normalization,
          ),
        }),
  };
}

function boundText(
  value: string,
  maxBytes: number,
  normalization: { truncatedFieldCount: number },
): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  normalization.truncatedFieldCount += 1;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(value.slice(0, midpoint), "utf8") <= maxBytes) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  return value.slice(0, lower);
}

function normalizeNativeCoverageWarnings(
  value: unknown,
): RepoSecurityScannerCoverageWarning[] {
  const warnings: RepoSecurityScannerCoverageWarning[] = [];
  collectNativeCoverageWarnings(value, warnings);
  return warnings;
}

function collectNativeCoverageWarnings(
  value: unknown,
  warnings: RepoSecurityScannerCoverageWarning[],
  defaultCode?: string,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNativeCoverageWarnings(entry, warnings, defaultCode);
    }
    return;
  }
  if (typeof value === "string" && value.length > 0) {
    warnings.push({
      ...(defaultCode === undefined ? {} : { code: defaultCode }),
      message: value,
    });
    return;
  }
  if (!isRecord(value)) return;

  const message = readString(value.message);
  const code =
    readString(value.code) ??
    readString(value.type) ??
    readString(value.level) ??
    defaultCode;
  const path = normalizeWorkspacePath(readString(value.path));
  const reference =
    readString(value.reference) ??
    readString(value.help) ??
    readString(value.url);
  if (
    message !== undefined ||
    code !== undefined ||
    path !== undefined ||
    reference !== undefined
  ) {
    warnings.push({
      ...(code === undefined ? {} : { code }),
      message: message ?? "The scanner reported incomplete coverage.",
      ...(path === undefined ? {} : { path }),
      ...(reference === undefined ? {} : { reference }),
    });
    return;
  }

  for (const [nestedCode, nested] of Object.entries(value)) {
    collectNativeCoverageWarnings(nested, warnings, nestedCode);
  }
}

function createBoundedScannerCommand(scannerCommand: string): string {
  return [
    '/usr/bin/mkdir -p -- "${TMPDIR}"',
    'makeademo_scan_stdout="$(/usr/bin/mktemp "${TMPDIR}/makeademo-security-stdout.XXXXXX")"',
    'makeademo_scan_stderr="$(/usr/bin/mktemp "${TMPDIR}/makeademo-security-stderr.XXXXXX")"',
    'trap \'/usr/bin/rm -f -- "$makeademo_scan_stdout" "$makeademo_scan_stderr"\' EXIT',
    `/usr/bin/timeout --signal=KILL ${scannerProcessTimeoutSeconds}s ${scannerCommand} >"$makeademo_scan_stdout" 2>"$makeademo_scan_stderr"`,
    "makeademo_scan_status=$?",
    `/usr/bin/head -c ${maxScannerStdoutBytes} -- "$makeademo_scan_stdout"`,
    `/usr/bin/head -c ${maxScannerStderrBytes} -- "$makeademo_scan_stderr" >&2`,
    'exit "$makeademo_scan_status"',
  ].join("; ");
}

function normalizeOsvFindings(value: unknown): RepoSecurityScannerFinding[] {
  const findings: RepoSecurityScannerFinding[] = [];
  for (const result of readArray(readRecord(value).results)) {
    const resultRecord = readRecord(result);
    const sourcePath = normalizeWorkspacePath(
      readString(readRecord(resultRecord.source).path),
    );
    for (const packageResult of readArray(resultRecord.packages)) {
      const packageRecord = readRecord(packageResult);
      const packageDetails = readRecord(packageRecord.package);
      const packageName = readString(packageDetails.name);
      const packageVersion = readString(packageDetails.version);
      for (const vulnerability of readArray(packageRecord.vulnerabilities)) {
        const vulnerabilityRecord = readRecord(vulnerability);
        const id = readString(vulnerabilityRecord.id) ?? "osv-vulnerability";
        findings.push({
          id,
          message:
            readString(vulnerabilityRecord.summary) ??
            `Known vulnerability ${id}.`,
          ...(packageName === undefined ? {} : { packageName }),
          ...(packageVersion === undefined ? {} : { packageVersion }),
          ...(sourcePath === undefined ? {} : { path: sourcePath }),
          scanner: "osv-scanner",
        });
      }
    }
  }
  return findings;
}

function normalizeGuarddogFindings(
  value: unknown,
): RepoSecurityScannerFinding[] {
  const findings: RepoSecurityScannerFinding[] = [];
  for (const [ruleId, matches] of Object.entries(
    readRecord(readRecord(value).results),
  )) {
    collectGuarddogFindings(ruleId, matches, findings);
  }
  return findings;
}

function collectGuarddogFindings(
  defaultId: string,
  value: unknown,
  findings: RepoSecurityScannerFinding[],
) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = readRecord(entry);
      const location = readGuarddogLocation(readString(record.location));
      const path =
        location.path ??
        normalizeWorkspacePath(
          readString(record.file) ?? readString(record.path),
        );
      const line = location.line ?? readPositiveInteger(record.line);
      findings.push({
        id: readString(record.rule) ?? defaultId,
        ...(line === undefined ? {} : { line }),
        message:
          readString(record.message) ??
          readString(record.code) ??
          `GuardDog matched ${defaultId}.`,
        ...(path === undefined ? {} : { path }),
        scanner: "guarddog",
      });
    }
    return;
  }
  if (isRecord(value)) {
    for (const [id, nested] of Object.entries(value)) {
      collectGuarddogFindings(id, nested, findings);
    }
  }
}

function readGuarddogLocation(location: string | undefined): {
  line?: number;
  path?: string;
} {
  if (location === undefined) return {};
  const match = /^(?<path>.*):(?<line>\d+)$/.exec(location);
  if (match?.groups === undefined) {
    const path = normalizeWorkspacePath(location);
    return path === undefined ? {} : { path };
  }
  const path = normalizeWorkspacePath(match.groups.path);
  const line = Number(match.groups.line);
  return {
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(path === undefined ? {} : { path }),
  };
}

function normalizeSemgrepFindings(
  value: unknown,
): RepoSecurityScannerFinding[] {
  return readArray(readRecord(value).results).map((result) => {
    const record = readRecord(result);
    const extra = readRecord(record.extra);
    const start = readRecord(record.start);
    const id = readString(record.check_id) ?? "semgrep-finding";
    const line = readPositiveInteger(start.line);
    const path = normalizeWorkspacePath(readString(record.path));
    return {
      id,
      ...(line === undefined ? {} : { line }),
      message: readString(extra.message) ?? `Semgrep matched ${id}.`,
      ...(path === undefined ? {} : { path }),
      scanner: "semgrep" as const,
    };
  });
}

function normalizeWorkspacePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return path.replace(/^\/workspace\/?/, "").replace(/^\.\//, "");
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
