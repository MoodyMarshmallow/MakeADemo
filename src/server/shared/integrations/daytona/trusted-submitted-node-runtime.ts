const helperExecutable =
  "/usr/local/bin/makeademo-provision-submitted-node-runtime";
const runtimeRoot = "/opt/makeademo/toolchains/node/sha256";
const attestationMaxBytes = 8 * 1024;

export type TrustedSubmittedNodeRuntimeArtifact = Readonly<{
  root: string;
}>;

export class TrustedSubmittedNodeRuntimeError extends Error {
  constructor(
    readonly code:
      | "malformed_attestation"
      | "oversized_attestation"
      | "version_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TrustedSubmittedNodeRuntimeError";
  }
}

/** Builds the root-only helper command for one exact trusted Node release. */
export function createTrustedSubmittedNodeProvisionCommand(
  version: string,
): string {
  assertExactStableNodeVersion(version);
  return `${helperExecutable} provision ${shellQuote(version)}`;
}

/** Parses the helper's sole bounded JSON attestation into a trusted artifact. */
export function readTrustedSubmittedNodeAttestation(
  stdout: string,
  expectedVersion: string,
): TrustedSubmittedNodeRuntimeArtifact {
  assertExactStableNodeVersion(expectedVersion);
  if (Buffer.byteLength(stdout) > attestationMaxBytes) {
    throw new TrustedSubmittedNodeRuntimeError(
      "oversized_attestation",
      "Trusted Node runtime attestation exceeded its byte limit.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw malformedAttestation();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedAttestation();
  }
  const attestation = value as Record<string, unknown>;
  const keys = Object.keys(attestation).sort();
  if (
    keys.join(",") !==
      "archiveSha256,nodeBinarySha256,schemaVersion,signedManifestSha256,signerPrimaryFingerprint,version" ||
    attestation.schemaVersion !== 1 ||
    !isSha256(attestation.archiveSha256) ||
    !isSha256(attestation.nodeBinarySha256) ||
    !isSha256(attestation.signedManifestSha256) ||
    typeof attestation.signerPrimaryFingerprint !== "string" ||
    !/^[A-F0-9]{40}$/.test(attestation.signerPrimaryFingerprint) ||
    typeof attestation.version !== "string"
  ) {
    throw malformedAttestation();
  }
  if (attestation.version !== expectedVersion) {
    throw new TrustedSubmittedNodeRuntimeError(
      "version_mismatch",
      "Trusted Node runtime attestation did not match the planned version.",
    );
  }
  return Object.freeze({
    root: trustedSubmittedNodeRuntimeRoot(attestation.archiveSha256),
  });
}

function trustedSubmittedNodeRuntimeRoot(archiveSha256: string): string {
  if (!isSha256(archiveSha256)) {
    throw new Error("Trusted Node runtime archive digest is invalid.");
  }
  return `${runtimeRoot}/${archiveSha256}`;
}

function assertExactStableNodeVersion(version: string): void {
  if (!/^(?:18|20|22|24)\.\d+\.\d+$/.test(version)) {
    throw new Error(
      "Trusted Node runtime requires an exact stable Node version.",
    );
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function malformedAttestation(): TrustedSubmittedNodeRuntimeError {
  return new TrustedSubmittedNodeRuntimeError(
    "malformed_attestation",
    "Trusted Node runtime returned malformed attestation JSON.",
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
