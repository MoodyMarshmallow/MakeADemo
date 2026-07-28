import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNodeReleaseUrls,
  parseAllowedPrimaryFingerprints,
  parseGpgvStatus,
  parseNodeReleaseManifest,
  provisionSubmittedNodeRuntime,
  validateNodeArchiveEntries,
  validateProvisionAttestation,
} from "./provision-submitted-node-runtime.mjs";

const allowedFingerprint = "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356";
const signingSubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await restoreOwnerWrite(directory);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("submitted Node runtime trust policy", () => {
  it("accepts one valid signature whose primary key is allowlisted", () => {
    expect(
      parseGpgvStatus(
        `[GNUPG:] VALIDSIG ${signingSubkey} 2026-01-01 0 4 0 1 10 01 ${allowedFingerprint}\n`,
        new Set([allowedFingerprint]),
      ),
    ).toBe(allowedFingerprint);
  });

  it.each([
    ["missing", "[GNUPG:] GOODSIG signer\n"],
    [
      "multiple",
      `[GNUPG:] VALIDSIG ${signingSubkey} 2026-01-01 0 4 0 1 10 01 ${allowedFingerprint}\n[GNUPG:] VALIDSIG ${signingSubkey} 2026-01-01 0 4 0 1 10 01 ${allowedFingerprint}\n`,
    ],
    ["malformed", "[GNUPG:] VALIDSIG not-a-fingerprint\n"],
  ])("rejects %s valid-signature status", (_label, status) => {
    expect(() =>
      parseGpgvStatus(status, new Set([allowedFingerprint])),
    ).toThrow("exactly one valid signature");
  });

  it("rejects a valid signature from an untrusted primary key", () => {
    expect(() =>
      parseGpgvStatus(
        `[GNUPG:] VALIDSIG ${signingSubkey} 2026-01-01 0 4 0 1 10 01 ${"B".repeat(40)}\n`,
        new Set([allowedFingerprint]),
      ),
    ).toThrow("not allowlisted");
  });

  it.each(["REVKEYSIG", "KEYREVOKED"])(
    "rejects %s status even when a valid signature is present",
    (revocationStatus) => {
      expect(() =>
        parseGpgvStatus(
          `[GNUPG:] ${revocationStatus} ${signingSubkey} signer\n[GNUPG:] VALIDSIG ${signingSubkey} 2026-01-01 0 4 0 1 10 01 ${allowedFingerprint}\n`,
          new Set([allowedFingerprint]),
        ),
      ).toThrow("revoked");
    },
  );

  it("accepts a cryptographically valid signature whose signing subkey has since expired", () => {
    expect(
      parseGpgvStatus(
        `[GNUPG:] EXPKEYSIG ${signingSubkey} signer\n[GNUPG:] VALIDSIG ${signingSubkey} 2026-01-01 0 4 0 1 10 01 ${allowedFingerprint}\n`,
        new Set([allowedFingerprint]),
      ),
    ).toBe(allowedFingerprint);
  });

  it("parses and bounds the pinned release-signer fingerprint policy", () => {
    expect(
      parseAllowedPrimaryFingerprints(
        `${allowedFingerprint}\n${"B".repeat(40)}\n`,
      ),
    ).toEqual(new Set([allowedFingerprint, "B".repeat(40)]));
    expect(() => parseAllowedPrimaryFingerprints("short\n")).toThrow(
      "fingerprint policy",
    );
  });

  it("selects exactly one lowercase SHA-256 row for linux-x64", () => {
    const digest = "a".repeat(64);
    expect(
      parseNodeReleaseManifest(
        `${"b".repeat(64)}  node-v24.3.2-linux-arm64.tar.xz\n${digest}  node-v24.3.2-linux-x64.tar.xz\n`,
        "24.3.2",
      ),
    ).toEqual({
      archiveSha256: digest,
      filename: "node-v24.3.2-linux-x64.tar.xz",
    });
  });

  it.each([
    `${"a".repeat(64)}  node-v24.3.2-linux-x64.tar.xz\n${"b".repeat(64)}  node-v24.3.2-linux-x64.tar.xz\n`,
    `${"A".repeat(64)}  node-v24.3.2-linux-x64.tar.xz\n`,
    `${"a".repeat(64)} *node-v24.3.2-linux-x64.tar.xz\n`,
    `${"a".repeat(64)}  ../node-v24.3.2-linux-x64.tar.xz\n`,
  ])("rejects an ambiguous or unsafe manifest", (manifest) => {
    expect(() => parseNodeReleaseManifest(manifest, "24.3.2")).toThrow(
      "exactly one linux-x64 archive",
    );
  });

  it("uses only exact fixed-origin Node release URLs", () => {
    expect(buildNodeReleaseUrls("24.3.2")).toEqual({
      archive: "https://nodejs.org/dist/v24.3.2/node-v24.3.2-linux-x64.tar.xz",
      signedManifest: "https://nodejs.org/dist/v24.3.2/SHASUMS256.txt.asc",
    });
    for (const unsafe of ["24", "v24.3.2", "24.3.2-rc.1", "../24.3.2"])
      expect(() => buildNodeReleaseUrls(unsafe)).toThrow("exact stable Node");
  });
});

describe("submitted Node archive policy", () => {
  const root = "node-v24.3.2-linux-x64";
  const valid = [
    { path: `${root}/`, size: 0, type: "directory" },
    { path: `${root}/bin/`, size: 0, type: "directory" },
    { path: `${root}/bin/node`, size: 100, type: "file" },
    {
      linkTarget: "../lib/node_modules/npm/bin/npm-cli.js",
      path: `${root}/bin/npm`,
      size: 0,
      type: "symlink",
    },
  ] as const;

  it("accepts bounded files and internal relative symlinks", () => {
    expect(() => validateNodeArchiveEntries(valid, "24.3.2")).not.toThrow();
  });

  it.each([
    [...valid, { path: "../escape", size: 1, type: "file" }],
    [...valid, { path: `${root}/bin/node`, size: 1, type: "file" }],
    [
      ...valid,
      {
        linkTarget: "../../../../etc/passwd",
        path: `${root}/bin/escape`,
        size: 0,
        type: "symlink",
      },
    ],
    [...valid, { path: `${root}/device`, size: 0, type: "special" }],
  ])(
    "rejects traversal, duplicates, escaping links, and special files",
    (entries) => {
      expect(() => validateNodeArchiveEntries(entries, "24.3.2")).toThrow(
        "unsafe Node archive",
      );
    },
  );

  it("enforces entry-count and expanded-size bounds", () => {
    expect(() =>
      validateNodeArchiveEntries(valid, "24.3.2", { maxEntries: 2 }),
    ).toThrow("unsafe Node archive");
    expect(() =>
      validateNodeArchiveEntries(valid, "24.3.2", {
        maxExpandedBytes: 99,
      }),
    ).toThrow("unsafe Node archive");
  });
});

describe("provisionSubmittedNodeRuntime", () => {
  it("verifies the signed manifest before downloading, hashing, and extracting the archive", async () => {
    const harness = await createProvisionHarness();

    const artifact = await provisionSubmittedNodeRuntime(
      "24.3.2",
      harness.options,
    );

    expect(artifact).toMatchObject({
      archiveSha256: harness.archiveSha256,
      schemaVersion: 1,
      signerPrimaryFingerprint: allowedFingerprint,
      version: "24.3.2",
    });
    expect(harness.events).toEqual([
      "fetch:SHASUMS256.txt.asc",
      "gpgv",
      "fetch:node-v24.3.2-linux-x64.tar.xz",
      "tar:list",
      "tar:extract",
      "node:version",
    ]);
    expect(harness.fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("fails before extraction when the archive digest differs from the signed row", async () => {
    const harness = await createProvisionHarness({
      manifestArchiveSha256: "f".repeat(64),
    });

    await expect(
      provisionSubmittedNodeRuntime("24.3.2", harness.options),
    ).rejects.toThrow("did not match the signed manifest");
    expect(harness.events).not.toContain("tar:list");
  });

  it("fails before publishing when Node reports another version", async () => {
    const harness = await createProvisionHarness({
      nodeVersionOutput: "v24.3.1\n",
    });

    await expect(
      provisionSubmittedNodeRuntime("24.3.2", harness.options),
    ).rejects.toThrow("version verification failed");
    await expect(
      access(`${harness.runtimeParent}/sha256/${harness.archiveSha256}`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats safe internal symlink modes as non-operative during provisioning verification", async () => {
    const harness = await createProvisionHarness({ includeSymlink: true });

    await expect(
      provisionSubmittedNodeRuntime("24.3.2", harness.options),
    ).resolves.toMatchObject({ archiveSha256: harness.archiveSha256 });
  });

  it("rejects artifact ownership that differs from the trusted helper user", async () => {
    const harness = await createProvisionHarness();

    await expect(
      provisionSubmittedNodeRuntime("24.3.2", {
        ...harness.options,
        expectedUid: (process.getuid?.() ?? 0) + 1,
      }),
    ).rejects.toThrow("permissions are invalid");
  });

  it("rejects non-canonical helper attestations", () => {
    expect(() =>
      validateProvisionAttestation(
        {
          archiveSha256: "a".repeat(64),
          extra: true,
          nodeBinarySha256: "b".repeat(64),
          schemaVersion: 1,
          signedManifestSha256: "c".repeat(64),
          signerPrimaryFingerprint: allowedFingerprint,
          version: "24.3.2",
        },
        "24.3.2",
      ),
    ).toThrow("malformed attestation");
  });

  it.each([
    {
      redirected: true,
      url: "https://nodejs.org/dist/v24.3.2/SHASUMS256.txt.asc",
    },
    {
      redirected: false,
      url: "https://mirror.example.test/SHASUMS256.txt.asc",
    },
  ])("rejects redirects and response-origin drift", async (responsePolicy) => {
    const harness = await createProvisionHarness({ responsePolicy });
    await expect(
      provisionSubmittedNodeRuntime("24.3.2", harness.options),
    ).rejects.toThrow("invalid response");
    expect(harness.events).toEqual(["fetch:SHASUMS256.txt.asc"]);
  });

  it("forwards cancellation to the fixed-origin fetch", async () => {
    const harness = await createProvisionHarness();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    harness.fetchImplementation.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      throw init?.signal?.reason;
    });

    await expect(
      provisionSubmittedNodeRuntime("24.3.2", {
        ...harness.options,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});

async function createProvisionHarness(
  input: {
    includeSymlink?: boolean;
    manifestArchiveSha256?: string;
    nodeVersionOutput?: string;
    responsePolicy?: { redirected: boolean; url: string };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "makeademo-node-runtime-"));
  temporaryDirectories.push(root);
  const runtimeParent = join(root, "runtime-parent");
  const fingerprintPolicyPath = join(root, "fingerprints.txt");
  const keyringPath = join(root, "pubring.kbx");
  await writeFile(fingerprintPolicyPath, `${allowedFingerprint}\n`);
  await writeFile(keyringPath, "test-keyring");
  const archiveBytes = Buffer.from("signed-node-archive");
  const archiveSha256 = sha256(archiveBytes);
  const manifestArchiveSha256 = input.manifestArchiveSha256 ?? archiveSha256;
  const manifest = `${manifestArchiveSha256}  node-v24.3.2-linux-x64.tar.xz\n`;
  const events: string[] = [];
  const fetchImplementation = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    const isManifest = url.endsWith("SHASUMS256.txt.asc");
    events.push(`fetch:${url.split("/").at(-1)}`);
    return response(
      isManifest ? Buffer.from("signed-manifest") : archiveBytes,
      input.responsePolicy?.url ?? url,
      input.responsePolicy?.redirected ?? false,
    );
  });
  const runCommand = vi.fn(async (command: string, args: string[]) => {
    if (command === "gpgv") {
      events.push("gpgv");
      const output = args
        .find((argument) => argument.startsWith("--output="))
        ?.slice("--output=".length);
      if (output === undefined) throw new Error("missing gpgv output");
      await writeFile(output, manifest);
      return {
        exitCode: 0,
        stderr: "",
        stdout: `[GNUPG:] VALIDSIG ${signingSubkey} 2026-01-01 0 4 0 1 10 01 ${allowedFingerprint}\n`,
      };
    }
    if (command === "tar" && args.includes("--list")) {
      events.push("tar:list");
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          "drwxr-xr-x root/root 0 2026-01-01 00:00 node-v24.3.2-linux-x64/",
          "drwxr-xr-x root/root 0 2026-01-01 00:00 node-v24.3.2-linux-x64/bin/",
          "-rwxr-xr-x root/root 11 2026-01-01 00:00 node-v24.3.2-linux-x64/bin/node",
          ...(input.includeSymlink === true
            ? [
                "drwxr-xr-x root/root 0 2026-01-01 00:00 node-v24.3.2-linux-x64/lib/",
                "-rw-r--r-- root/root 3 2026-01-01 00:00 node-v24.3.2-linux-x64/lib/npm.js",
                "lrwxrwxrwx root/root 0 2026-01-01 00:00 node-v24.3.2-linux-x64/bin/npm -> ../lib/npm.js",
              ]
            : []),
          "",
        ].join("\n"),
      };
    }
    if (command === "tar" && args.includes("--extract")) {
      events.push("tar:extract");
      const destination = args[args.indexOf("--directory") + 1];
      await mkdir(join(destination, "bin"), { recursive: true });
      await writeFile(join(destination, "bin/node"), "node-binary");
      if (input.includeSymlink === true) {
        await mkdir(join(destination, "lib"), { recursive: true });
        await writeFile(join(destination, "lib/npm.js"), "npm");
        await symlink("../lib/npm.js", join(destination, "bin/npm"));
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (command.endsWith("/bin/node")) {
      events.push("node:version");
      return {
        exitCode: 0,
        stderr: "",
        stdout: input.nodeVersionOutput ?? "v24.3.2\n",
      };
    }
    throw new Error(`unexpected helper command: ${command}`);
  });
  return {
    archiveSha256,
    runtimeParent,
    events,
    fetchImplementation,
    options: {
      runtimeParent,
      expectedUid: process.getuid?.() ?? 0,
      fetchImplementation,
      fingerprintPolicyPath,
      keyringPath,
      runCommand,
    },
  };
}

function response(bytes: Buffer, url: string, redirected: boolean): Response {
  const result = new Response(bytes, {
    headers: { "content-length": String(bytes.length) },
    status: 200,
  });
  Object.defineProperties(result, {
    redirected: { value: redirected },
    url: { value: url },
  });
  return result;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function restoreOwnerWrite(path: string): Promise<void> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch {
    return;
  }
  if (details.isSymbolicLink()) return;
  await chmod(path, details.mode | 0o200);
  if (!details.isDirectory()) return;
  for (const name of await readdir(path)) {
    await restoreOwnerWrite(join(path, name));
  }
}
