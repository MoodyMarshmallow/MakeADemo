import {
  createDaytonaWorkspaceResetCommand,
  daytonaGitCaBundleCandidates,
  daytonaWorkspaceDirectory,
} from "../../../shared/integrations/daytona/workspace-command";
import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createGitCloneCommand } from "../../02-repo-security-screen/repository-loading/git-clone-command";
import { runGitCloneWithTransientRetry } from "../../02-repo-security-screen/repository-loading/git-clone-retry";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../preparation-workspace.interface";
const diagnosticValueMaxLength = 500;
const outputChannelMaxLength = 750;
const outputMaxLength = 1_500;

export type RepoPreparationCloneDiagnosticsContext = {
  daytonaSnapshot?: string;
  daytonaSubmittedCodeSnapshot?: string;
};

/** Clones one pinned revision into the non-executing parent workspace. */
export async function bootstrapRepoPreparationWorkspace(input: {
  cloneFailureDiagnosticsContext?: RepoPreparationCloneDiagnosticsContext;
  commitSha: string;
  logger: PipelineEventLogger;
  repoUrl: string;
  workspace: PreparationWorkspace;
}): Promise<
  | {
      baselineSourceControlledPaths: string[];
      failure?: never;
    }
  | {
      baselineSourceControlledPaths?: never;
      failure: ReturnType<typeof createRepoCloneFailure>;
    }
> {
  await writeLog(input, { event: "clone-started" });
  const parentClone = await cloneParent(
    input.workspace,
    input.repoUrl,
    input.commitSha,
  );
  await writeLog(input, cloneEvent("clone-finished", parentClone));
  if (parentClone.exitCode !== 0) {
    await writeDiagnostics(
      input,
      "parent agent workspace",
      input.workspace.execute.bind(input.workspace),
    );
    return {
      failure: createRepoCloneFailure(parentClone, "parent agent workspace"),
    };
  }

  const baselineSourceControlledPaths = await readSourceControlledPaths(
    input.workspace,
  );

  return { baselineSourceControlledPaths };
}

async function readSourceControlledPaths(
  workspace: PreparationWorkspace,
): Promise<string[]> {
  const result = await executeRepositoryCommand(
    workspace,
    "git -C /workspace ls-files -z",
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to inventory source-controlled submitted paths.");
  }
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

async function cloneParent(
  workspace: PreparationWorkspace,
  repoUrl: string,
  commitSha: string,
) {
  return await runGitCloneWithTransientRetry({
    clone: () =>
      executeRepositoryCommand(
        workspace,
        createCloneCommand(repoUrl, commitSha),
        {
          timeoutMs: 120_000,
        },
      ),
  });
}

function executeRepositoryCommand(
  workspace: PreparationWorkspace,
  command: string,
  options?: Parameters<PreparationWorkspace["execute"]>[1],
): Promise<PreparationWorkspaceCommandResult> {
  if (workspace.executeRepositoryCommand === undefined) {
    throw new Error("Unprivileged repository command execution is required.");
  }
  return workspace.executeRepositoryCommand(command, options);
}

function createCloneCommand(repoUrl: string, commitSha: string): string {
  return createGitCloneCommand({
    caBundleCandidates: [...daytonaGitCaBundleCandidates],
    commitSha,
    destinationPath: daytonaWorkspaceDirectory,
    repoUrl,
    resetCommand: createDaytonaWorkspaceResetCommand(),
  });
}

async function writeDiagnostics(
  input: Parameters<typeof bootstrapRepoPreparationWorkspace>[0],
  context: string,
  execute: PreparationWorkspace["execute"] | undefined,
) {
  if (execute === undefined) return;
  try {
    const diagnosticRun = await raceWithTimeout(
      execute(createDiagnosticsCommand()),
      7_000,
    );
    if (diagnosticRun.status === "timed-out") {
      await writeLog(
        input,
        {
          event: "clone-failure-diagnostics-failed",
          reason: diagnosticRun.reason,
        },
        true,
      );
      return;
    }
    const result = diagnosticRun.value;
    await writeLog(
      input,
      {
        ...parseDiagnostics(result.stdout),
        cloneFailureWorkspace: context,
        diagnosticsExitCode: result.exitCode,
        ...input.cloneFailureDiagnosticsContext,
        event: "clone-failure-diagnostics",
      },
      true,
    );
  } catch (error) {
    await writeLog(
      input,
      {
        event: "clone-failure-diagnostics-failed",
        reason: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  { status: "succeeded"; value: T } | { reason: string; status: "timed-out" }
> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve({
        reason: `Repo Preparation agent timed out after ${timeoutMs}ms.`,
        status: "timed-out",
      });
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        if (!settled) resolve({ status: "succeeded", value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        if (!settled) reject(error);
      },
    );
  });
}

function createDiagnosticsCommand(): string {
  return `timeout 5s sh -lc ${shellQuote(
    [
      "makeademo_clone_diagnostics=1",
      "if test -f /etc/ssl/certs/ca-certificates.crt; then printf 'caCertificatesCrtExists=true\\n'; else printf 'caCertificatesCrtExists=false\\n'; fi",
      "if test -e /etc/openshell-tls/ca-bundle.pem; then printf 'openshellCaBundleExists=true\\n'; else printf 'openshellCaBundleExists=false\\n'; fi",
      "if test -r /etc/openshell-tls/ca-bundle.pem; then printf 'openshellCaBundleReadable=true\\n'; else printf 'openshellCaBundleReadable=false\\n'; fi",
      "if test -e /etc/openshell-tls/ca-bundle.pem; then printf 'openshellCaBundlePath='; readlink -f /etc/openshell-tls/ca-bundle.pem 2>/dev/null | cut -c 1-500 || true; fi",
      "if test -e /etc/openshell-tls/openshell-ca.pem; then printf 'openshellCaCertExists=true\\n'; else printf 'openshellCaCertExists=false\\n'; fi",
      "if test -r /etc/openshell-tls/openshell-ca.pem; then printf 'openshellCaCertReadable=true\\n'; else printf 'openshellCaCertReadable=false\\n'; fi",
      "if test -e /etc/openshell-tls/openshell-ca.pem; then printf 'openshellCaCertPath='; readlink -f /etc/openshell-tls/openshell-ca.pem 2>/dev/null | cut -c 1-500 || true; fi",
      'for n in GIT_SSL_CAINFO SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE NODE_EXTRA_CA_CERTS; do eval "v=${$n-}"; if test -n "$v"; then case "$v" in /*) printf \'caEnvPath_%s=\' "$n"; printf \'%s\\n\' "$v" | cut -c 1-500 ;; *) printf \'caEnvName_%s=set\\n\' "$n" ;; esac; fi; done',
      "printf 'gitSslCAInfo='; git config --show-origin --get http.sslCAInfo 2>&1 | cut -c 1-500 || true; printf '\\n'",
      "printf 'gitVersion='; git --version 2>&1 || true",
      "printf 'opensslVersion='; openssl version 2>&1 || true",
    ].join("\n"),
  )}`;
}

function parseDiagnostics(stdout: string): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (
      [
        "caCertificatesCrtExists",
        "openshellCaBundleExists",
        "openshellCaBundleReadable",
        "openshellCaCertExists",
        "openshellCaCertReadable",
      ].includes(key)
    )
      values[key] = value === "true";
    else if (
      [
        "gitVersion",
        "opensslVersion",
        "openshellCaBundlePath",
        "openshellCaCertPath",
        "gitSslCAInfo",
      ].includes(key) ||
      key.startsWith("caEnv")
    )
      values[key] = limit(value, diagnosticValueMaxLength);
  }
  return values;
}

function createRepoCloneFailure(
  result: { exitCode: number; stderr: string; stdout: string },
  context: string,
) {
  const output = limit(
    [result.stderr, result.stdout]
      .map((value) => limit(redact(value), outputChannelMaxLength))
      .filter(Boolean)
      .join("\n"),
    outputMaxLength,
  );
  return {
    assumptions: [],
    blockers: [
      `Repo Preparation could not clone the submitted repository in the ${context} (git exited with ${result.exitCode}): ${output}`,
    ],
    status: "failed" as const,
    suggestedChanges: [
      "Retry Repo Preparation after the submitted repository can be cloned from the Daytona workspace.",
    ],
  };
}

function cloneEvent(
  event: string,
  result: { exitCode: number; stderr: string; stdout: string },
) {
  return {
    event,
    exitCode: result.exitCode,
    stderrLength: result.stderr.length,
    stdoutLength: result.stdout.length,
  };
}

async function writeLog(
  input: Pick<
    Parameters<typeof bootstrapRepoPreparationWorkspace>[0],
    "logger" | "workspace"
  >,
  event: Record<string, unknown>,
  durable = false,
) {
  const payload = {
    ...event,
    event:
      typeof event.event === "string" ? event.event : "repo-preparation.debug",
    stage: "repo-preparation",
  };
  try {
    const write = input.workspace.writeSandboxLog?.(payload);
    if (durable) await write;
    else void write?.catch((error) => warn(input.logger, payload.event, error));
  } catch (error) {
    warn(input.logger, payload.event, error);
  }
}

function warn(logger: PipelineEventLogger, event: string, error: unknown) {
  try {
    void logger
      .warn(
        {
          error: error instanceof Error ? error.message : String(error),
          event: "sandbox-log-write-failed",
          failedEvent: event,
          stage: "repo-preparation",
          workspaceComponent: "sandbox-log",
        },
        "Repo Preparation sandbox log write failed.",
      )
      .catch(() => {});
  } catch {}
}
function redact(value: string) {
  return value
    .replace(/\b(https?:\/\/)([^\s/@'"<>]+@)/gi, "$1***@")
    .replace(
      /([?&](?:access_token|api[_-]?key|auth[_-]?token|client[_-]?secret|key|oauth[_-]?token|password|private[_-]?key|secret|token)=)([^\s&'"<>]+)/gi,
      "$1***",
    );
}
function limit(value: string, max: number) {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
