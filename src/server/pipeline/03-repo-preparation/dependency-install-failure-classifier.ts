import {
  prerelease,
  satisfies as semverSatisfies,
  valid,
  validRange,
} from "semver";
import type { PreparationWorkspaceCommandResult } from "./preparation-workspace.interface";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

export type DependencyInstallFailureClassification = {
  actualNodeVersion: string;
  dependency: string;
  expectedNodeRange: string;
  failureKind: "repository_node_dependency_incompatible";
};

const diagnosticTailMaxBytes = 8_192;

/** Classifies only bounded, package-manager-authored install diagnostics. */
export function classifyDependencyInstallFailure(input: {
  plan: SubmittedCodeToolchainPlan;
  result: PreparationWorkspaceCommandResult;
}): DependencyInstallFailureClassification | undefined {
  if (
    input.result.exitCode === 0 ||
    input.plan.packageManager?.name !== "yarn" ||
    input.plan.packageManager.generation !== "yarn-classic"
  ) {
    return undefined;
  }

  const diagnostic = stripAnsiSgr(
    boundUtf8Tail(
      `${input.result.stdout}\n${input.result.stderr}`,
      diagnosticTailMaxBytes,
    ),
  );
  if (
    [...diagnostic.matchAll(/^error Found incompatible module\.$/gm)].length !==
    1
  ) {
    return undefined;
  }
  const matches = [
    ...diagnostic.matchAll(
      /^error ([^\r\n:]{1,256}): The engine "node" is incompatible with this module\. Expected version "([^"\r\n]{1,128})"\. Got "([^"\r\n]{1,64})"\.$/gm,
    ),
  ];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }
  const dependency = parseExactNpmDependency(match[1]);
  const actualNodeVersion = match[3];
  const expectedNodeRange = match[2];
  const expectedRange = validRange(expectedNodeRange, { loose: false });
  if (
    dependency === undefined ||
    valid(actualNodeVersion) !== actualNodeVersion ||
    prerelease(actualNodeVersion) !== null ||
    actualNodeVersion !== input.plan.node.version ||
    expectedRange === null ||
    /(?:^|[<>=~^|\s])v?\d+\.\d+\.\d+-[0-9A-Za-z]/.test(expectedNodeRange) ||
    /(?:https?:|git\+|file:)/i.test(expectedNodeRange) ||
    semverSatisfies(actualNodeVersion, expectedRange, {
      includePrerelease: false,
      loose: false,
    })
  ) {
    return undefined;
  }

  return {
    actualNodeVersion,
    dependency,
    expectedNodeRange,
    failureKind: "repository_node_dependency_incompatible",
  };
}

function parseExactNpmDependency(value: string): string | undefined {
  const versionSeparator = value.lastIndexOf("@");
  if (versionSeparator <= 0) return undefined;
  const name = value.slice(0, versionSeparator);
  const version = value.slice(versionSeparator + 1);
  if (
    name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name) ||
    valid(version) !== version ||
    prerelease(version) !== null
  ) {
    return undefined;
  }
  return value;
}

function stripAnsiSgr(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences begin with ESC.
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function boundUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] ?? 0) >> 6 === 2) start += 1;
  return bytes.subarray(start).toString("utf8");
}
