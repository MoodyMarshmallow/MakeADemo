import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

/**
 * A content-addressed package-manager artifact acquired before submitted files
 * are present in the runtime sandbox. The receipt is the only authority that
 * makes a resolved toolchain plan executable.
 */
type SubmittedCodeToolchainContentDigest = {
  algorithm: "sha256" | "sha512";
  value: string;
};

/** Provider-issued capability. Consumers must not synthesize or alter it. */
export type SubmittedCodeToolchainArtifactReceipt = {
  readonly node: {
    readonly archiveDigest: SubmittedCodeToolchainContentDigest & {
      algorithm: "sha256";
    };
    readonly nodeBinaryDigest: SubmittedCodeToolchainContentDigest & {
      algorithm: "sha256";
    };
    readonly signedManifestDigest: SubmittedCodeToolchainContentDigest & {
      algorithm: "sha256";
    };
    readonly signerPrimaryFingerprint: string;
    readonly version: string;
  };
  readonly packageManager: {
    readonly artifactDigest: SubmittedCodeToolchainContentDigest;
    readonly upstreamDigest: SubmittedCodeToolchainContentDigest;
  };
};

/**
 * Trusted provisioning boundary for package-manager artifacts. Implementations
 * must acquire only the exact plan requirement before submitted repository
 * files are synchronized, verify an algorithm-tagged authoritative content
 * digest, and cache the artifact outside submitted writable state before
 * resolving.
 */
export interface SubmittedCodeToolchainArtifactProvider {
  provisionSubmittedCodeToolchain(
    plan: SubmittedCodeToolchainPlan,
  ): Promise<SubmittedCodeToolchainArtifactReceipt>;
}
