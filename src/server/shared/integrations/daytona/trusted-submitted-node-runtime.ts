const helperExecutable =
  "/usr/local/bin/makeademo-provision-submitted-node-runtime";
const cacheRoot = "/opt/makeademo/toolchains/node/sha256";
const attestationMaxBytes = 8 * 1024;

type Sha256Digest = Readonly<{ algorithm: "sha256"; value: string }>;

export type TrustedSubmittedNodeRuntimeArtifact = Readonly<{
  archiveDigest: Sha256Digest;
  cacheStatus: "hit" | "miss";
  nodeBinaryDigest: Sha256Digest;
  root: string;
  signedManifestDigest: Sha256Digest;
  signerPrimaryFingerprint: string;
  version: string;
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

/** Builds the offline re-verification command bound to the issued receipt. */
export function createTrustedSubmittedNodeVerificationCommand(
  artifact: TrustedSubmittedNodeRuntimeArtifact,
): string {
  return `${helperExecutable} verify ${[
    artifact.version,
    artifact.archiveDigest.value,
    artifact.nodeBinaryDigest.value,
    artifact.signedManifestDigest.value,
    artifact.signerPrimaryFingerprint,
  ]
    .map(shellQuote)
    .join(" ")}`;
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
      "archiveSha256,cacheStatus,nodeBinarySha256,schemaVersion,signedManifestSha256,signerPrimaryFingerprint,version" ||
    attestation.schemaVersion !== 1 ||
    !["hit", "miss"].includes(String(attestation.cacheStatus)) ||
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
    archiveDigest: sha256Digest(attestation.archiveSha256),
    cacheStatus: attestation.cacheStatus as "hit" | "miss",
    nodeBinaryDigest: sha256Digest(attestation.nodeBinarySha256),
    root: trustedSubmittedNodeRuntimeRoot(attestation.archiveSha256),
    signedManifestDigest: sha256Digest(attestation.signedManifestSha256),
    signerPrimaryFingerprint: attestation.signerPrimaryFingerprint,
    version: attestation.version,
  });
}

export function trustedSubmittedNodeRuntimeRoot(archiveSha256: string): string {
  if (!isSha256(archiveSha256)) {
    throw new Error("Trusted Node runtime archive digest is invalid.");
  }
  return `${cacheRoot}/${archiveSha256}`;
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

function sha256Digest(value: string): Sha256Digest {
  return Object.freeze({ algorithm: "sha256", value });
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
