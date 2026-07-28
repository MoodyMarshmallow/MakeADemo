import { describe, expect, it } from "vitest";

import {
  type TrustedSubmittedNodeRuntimeError,
  createTrustedSubmittedNodeProvisionCommand,
  readTrustedSubmittedNodeAttestation,
} from "./trusted-submitted-node-runtime";

const validAttestation = {
  archiveSha256: "a".repeat(64),
  nodeBinarySha256: "b".repeat(64),
  schemaVersion: 1,
  signedManifestSha256: "c".repeat(64),
  signerPrimaryFingerprint: "D".repeat(40),
  version: "24.3.2",
} as const;

describe("trusted submitted Node runtime adapter", () => {
  it("parses a bounded helper attestation and derives its runtime root", () => {
    expect(
      readTrustedSubmittedNodeAttestation(
        `${JSON.stringify(validAttestation)}\n`,
        "24.3.2",
      ),
    ).toEqual({
      root: `/opt/makeademo/toolchains/node/sha256/${"a".repeat(64)}`,
    });
  });

  it.each([
    ["malformed_attestation", "not-json", "24.3.2"],
    [
      "malformed_attestation",
      JSON.stringify({ ...validAttestation, archiveSha256: "short" }),
      "24.3.2",
    ],
    [
      "malformed_attestation",
      JSON.stringify({
        ...validAttestation,
        signerPrimaryFingerprint: "d".repeat(40),
      }),
      "24.3.2",
    ],
    ["version_mismatch", JSON.stringify(validAttestation), "22.23.1"],
  ] as const)("rejects %s helper output", (code, stdout, expectedVersion) => {
    expect(() =>
      readTrustedSubmittedNodeAttestation(stdout, expectedVersion),
    ).toThrow(expect.objectContaining({ code }));
  });

  it("rejects oversized helper output before JSON parsing", () => {
    expect(() =>
      readTrustedSubmittedNodeAttestation("x".repeat(9_000), "24.3.2"),
    ).toThrow(
      expect.objectContaining<Partial<TrustedSubmittedNodeRuntimeError>>({
        code: "oversized_attestation",
      }),
    );
  });

  it("builds the root-helper provision command", () => {
    expect(createTrustedSubmittedNodeProvisionCommand("24.3.2")).toContain(
      "makeademo-provision-submitted-node-runtime provision '24.3.2'",
    );
  });

  it("rejects unsafe command inputs", () => {
    expect(() => createTrustedSubmittedNodeProvisionCommand("24")).toThrow(
      "exact stable Node",
    );
  });
});
