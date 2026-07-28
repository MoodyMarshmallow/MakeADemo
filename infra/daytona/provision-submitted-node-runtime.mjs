#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const officialOrigin = "https://nodejs.org";
const trustRoot = "/opt/makeademo/node-release-trust";
const defaultRuntimeParent = "/opt/makeademo/toolchains/node";
const keyringPath = `${trustRoot}/pubring.kbx`;
const fingerprintPolicyPath = `${trustRoot}/allowed-primary-fingerprints.txt`;
const maxManifestBytes = 128 * 1024;
const maxArchiveBytes = 96 * 1024 * 1024;
const maxAttestationBytes = 8 * 1024;
const defaultArchiveLimits = Object.freeze({
  maxEntries: 60_000,
  maxExpandedBytes: 512 * 1024 * 1024,
});

export function buildNodeReleaseUrls(version) {
  assertExactStableNodeVersion(version);
  const releaseRoot = `${officialOrigin}/dist/v${version}`;
  return Object.freeze({
    archive: `${releaseRoot}/node-v${version}-linux-x64.tar.xz`,
    signedManifest: `${releaseRoot}/SHASUMS256.txt.asc`,
  });
}

export function parseAllowedPrimaryFingerprints(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8 * 1024) {
    throw new Error("Invalid Node release fingerprint policy.");
  }
  const fingerprints = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (
    fingerprints.length === 0 ||
    fingerprints.length > 32 ||
    fingerprints.some((fingerprint) => !/^[A-F0-9]{40}$/.test(fingerprint)) ||
    new Set(fingerprints).size !== fingerprints.length
  ) {
    throw new Error("Invalid Node release fingerprint policy.");
  }
  return new Set(fingerprints);
}

export function parseGpgvStatus(status, allowedPrimaryFingerprints) {
  if (typeof status !== "string" || Buffer.byteLength(status) > 64 * 1024) {
    throw new Error("Node release must have exactly one valid signature.");
  }
  if (/^\[GNUPG:\] (?:REVKEYSIG|KEYREVOKED)(?: |$)/m.test(status)) {
    throw new Error("Node release signature key is revoked.");
  }
  const signatures = status
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
    .map((line) => line.trim().split(/\s+/));
  if (
    signatures.length !== 1 ||
    signatures[0].length < 11 ||
    !/^[A-F0-9]{40}$/.test(signatures[0][2] ?? "")
  ) {
    throw new Error("Node release must have exactly one valid signature.");
  }
  const fields = signatures[0];
  const primaryFingerprint = fields.at(-1);
  if (
    primaryFingerprint === undefined ||
    !/^[A-F0-9]{40}$/.test(primaryFingerprint)
  ) {
    throw new Error("Node release must have exactly one valid signature.");
  }
  if (!allowedPrimaryFingerprints.has(primaryFingerprint)) {
    throw new Error(
      "Node release signer primary fingerprint is not allowlisted.",
    );
  }
  return primaryFingerprint;
}

export function parseNodeReleaseManifest(manifest, version) {
  assertExactStableNodeVersion(version);
  if (
    typeof manifest !== "string" ||
    Buffer.byteLength(manifest) > maxManifestBytes
  ) {
    throw new Error(
      "Signed manifest must select exactly one linux-x64 archive.",
    );
  }
  const filename = `node-v${version}-linux-x64.tar.xz`;
  const rows = manifest.split(/\r?\n/).filter((line) => {
    const separator = line.indexOf("  ");
    return separator >= 0 && line.slice(separator + 2) === filename;
  });
  if (rows.length !== 1) {
    throw new Error(
      "Signed manifest must select exactly one linux-x64 archive.",
    );
  }
  const match =
    /^([a-f0-9]{64}) {2}(node-v\d+\.\d+\.\d+-linux-x64\.tar\.xz)$/.exec(
      rows[0],
    );
  if (match?.[1] === undefined || match[2] !== filename) {
    throw new Error(
      "Signed manifest must select exactly one linux-x64 archive.",
    );
  }
  return { archiveSha256: match[1], filename };
}

export function validateNodeArchiveEntries(entries, version, limits = {}) {
  assertExactStableNodeVersion(version);
  if (!Array.isArray(entries)) throw unsafeArchive();
  const maxEntries = limits.maxEntries ?? defaultArchiveLimits.maxEntries;
  const maxExpandedBytes =
    limits.maxExpandedBytes ?? defaultArchiveLimits.maxExpandedBytes;
  if (entries.length === 0 || entries.length > maxEntries)
    throw unsafeArchive();
  const archiveRoot = `node-v${version}-linux-x64`;
  const seen = new Set();
  let expandedBytes = 0;
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !["directory", "file", "symlink"].includes(entry.type) ||
      entry.path.length > 512 ||
      !/^[A-Za-z0-9._/@+-]+\/?$/.test(entry.path) ||
      entry.path.startsWith("/") ||
      entry.path.includes("//") ||
      seen.has(entry.path)
    ) {
      throw unsafeArchive();
    }
    const normalized = posix.normalize(entry.path.replace(/\/$/, ""));
    if (
      normalized !== archiveRoot &&
      !normalized.startsWith(`${archiveRoot}/`)
    ) {
      throw unsafeArchive();
    }
    seen.add(entry.path);
    expandedBytes += entry.size;
    if (expandedBytes > maxExpandedBytes) throw unsafeArchive();
    if (entry.type === "symlink") {
      if (
        typeof entry.linkTarget !== "string" ||
        entry.linkTarget.length === 0 ||
        entry.linkTarget.length > 512 ||
        entry.linkTarget.startsWith("/")
      ) {
        throw unsafeArchive();
      }
      const destination = posix.normalize(
        posix.join(posix.dirname(normalized), entry.linkTarget),
      );
      if (
        destination !== archiveRoot &&
        !destination.startsWith(`${archiveRoot}/`)
      ) {
        throw unsafeArchive();
      }
    } else if (entry.linkTarget !== undefined) {
      throw unsafeArchive();
    }
  }
  if (!seen.has(`${archiveRoot}/bin/node`)) throw unsafeArchive();
}

export async function provisionSubmittedNodeRuntime(version, options = {}) {
  assertExactStableNodeVersion(version);
  const runtimeParent = options.runtimeParent ?? defaultRuntimeParent;
  const signal = options.signal;
  const dependencies = createDependencies(options);
  await dependencies.mkdir(runtimeParent, { recursive: true });
  const incomingRoot = await dependencies.mkdtemp(
    `${runtimeParent}/.incoming-`,
  );
  try {
    const urls = buildNodeReleaseUrls(version);
    const signedManifestPath = `${incomingRoot}/SHASUMS256.txt.asc`;
    const archivePath = `${incomingRoot}/node.tar.xz`;
    const manifest = await downloadBoundedOfficialFile({
      destination: signedManifestPath,
      expectedUrl: urls.signedManifest,
      fetchImplementation: dependencies.fetchImplementation,
      maxBytes: maxManifestBytes,
      signal,
      writeFile: dependencies.writeFile,
    });
    const allowedFingerprints = parseAllowedPrimaryFingerprints(
      await dependencies.readFile(
        options.fingerprintPolicyPath ?? fingerprintPolicyPath,
        "utf8",
      ),
    );
    const verifiedManifestPath = `${incomingRoot}/SHASUMS256.txt`;
    const signature = await dependencies.runCommand(
      "gpgv",
      [
        `--keyring=${options.keyringPath ?? keyringPath}`,
        "--status-fd=1",
        `--output=${verifiedManifestPath}`,
        signedManifestPath,
      ],
      { signal },
    );
    if (signature.exitCode !== 0) {
      throw new Error("Node release signature verification failed.");
    }
    const signerPrimaryFingerprint = parseGpgvStatus(
      signature.stdout,
      allowedFingerprints,
    );
    const verifiedManifest = await dependencies.readFile(
      verifiedManifestPath,
      "utf8",
    );
    const selected = parseNodeReleaseManifest(verifiedManifest, version);
    const archive = await downloadBoundedOfficialFile({
      destination: archivePath,
      expectedUrl: urls.archive,
      fetchImplementation: dependencies.fetchImplementation,
      maxBytes: maxArchiveBytes,
      signal,
      writeFile: dependencies.writeFile,
    });
    if (archive.sha256 !== selected.archiveSha256) {
      throw new Error(
        "Node archive SHA-256 did not match the signed manifest.",
      );
    }

    const listed = await dependencies.runCommand(
      "tar",
      ["--list", "--verbose", "--xz", "--file", archivePath],
      { signal },
    );
    if (listed.exitCode !== 0) throw unsafeArchive();
    const entries = parseTarVerboseListing(listed.stdout);
    validateNodeArchiveEntries(entries, version);
    const extractedRoot = `${incomingRoot}/runtime`;
    await dependencies.mkdir(extractedRoot, { recursive: true });
    const extracted = await dependencies.runCommand(
      "tar",
      [
        "--extract",
        "--xz",
        "--file",
        archivePath,
        "--directory",
        extractedRoot,
        "--strip-components=1",
        "--no-same-owner",
        "--no-same-permissions",
      ],
      { signal },
    );
    if (extracted.exitCode !== 0) throw unsafeArchive();
    const nodeBinarySha256 = await sha256File(
      `${extractedRoot}/bin/node`,
      dependencies,
    );
    const attestation = Object.freeze({
      archiveSha256: archive.sha256,
      nodeBinarySha256,
      schemaVersion: 1,
      signedManifestSha256: manifest.sha256,
      signerPrimaryFingerprint,
      version,
    });
    await dependencies.writeFile(
      `${extractedRoot}/SHASUMS256.txt.asc`,
      await dependencies.readFile(signedManifestPath),
      { mode: 0o400 },
    );
    await dependencies.writeFile(
      `${extractedRoot}/makeademo-node-attestation.json`,
      JSON.stringify(attestation),
      { mode: 0o400 },
    );
    const finalRoot = nodeRuntimeRoot(runtimeParent, attestation.archiveSha256);
    await dependencies.mkdir(dirname(finalRoot), { recursive: true });
    await makeTreeImmutable(extractedRoot, dependencies);
    await verifyProvisionedNodeRuntime(
      attestation,
      extractedRoot,
      options,
      dependencies,
    );
    await renameImmutableRoot(extractedRoot, finalRoot, dependencies);
    return attestation;
  } finally {
    await makeDirectoriesOwnerWritable(incomingRoot, dependencies).catch(
      () => undefined,
    );
    await dependencies.rm(incomingRoot, { force: true, recursive: true });
  }
}

async function verifyProvisionedNodeRuntime(
  attestation,
  root,
  options,
  dependencies,
) {
  const stored = validateProvisionAttestation(
    JSON.parse(
      await readBoundedFile(
        `${root}/makeademo-node-attestation.json`,
        maxAttestationBytes,
        dependencies,
        "utf8",
      ),
    ),
    attestation.version,
  );
  if (!sameAttestation(stored, attestation)) {
    throw new Error(
      "Trusted Node runtime attestation does not match its provisioned artifact.",
    );
  }
  await validateImmutableTree(root, dependencies, options.expectedUid ?? 0);
  if (
    (await sha256File(`${root}/bin/node`, dependencies)) !==
      attestation.nodeBinarySha256 ||
    (await sha256File(`${root}/SHASUMS256.txt.asc`, dependencies)) !==
      attestation.signedManifestSha256
  ) {
    throw new Error("Trusted Node runtime artifact verification failed.");
  }
  const version = await dependencies.runCommand(
    `${root}/bin/node`,
    ["--version"],
    {
      signal: options.signal,
    },
  );
  if (
    version.exitCode !== 0 ||
    version.stdout.trim() !== `v${attestation.version}`
  ) {
    throw new Error("Trusted Node runtime version verification failed.");
  }
  return root;
}

async function renameImmutableRoot(source, destination, dependencies) {
  try {
    await dependencies.rename(source, destination);
  } catch (error) {
    if (error?.code !== "EACCES" || process.platform !== "darwin") throw error;
    await dependencies.chmod(source, 0o700);
    await dependencies.rename(source, destination);
    await dependencies.chmod(destination, 0o555);
  }
}

export function validateProvisionAttestation(value, expectedVersion) {
  const expectedKeys = [
    "archiveSha256",
    "nodeBinarySha256",
    "schemaVersion",
    "signedManifestSha256",
    "signerPrimaryFingerprint",
    "version",
  ];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== expectedKeys.join(",") ||
    value.schemaVersion !== 1 ||
    value.version !== expectedVersion ||
    !/^[a-f0-9]{64}$/.test(value.archiveSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.nodeBinarySha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.signedManifestSha256 ?? "") ||
    !/^[A-F0-9]{40}$/.test(value.signerPrimaryFingerprint ?? "")
  ) {
    throw new Error(
      "Trusted Node runtime returned malformed attestation JSON.",
    );
  }
  return Object.freeze({
    archiveSha256: value.archiveSha256,
    nodeBinarySha256: value.nodeBinarySha256,
    schemaVersion: 1,
    signedManifestSha256: value.signedManifestSha256,
    signerPrimaryFingerprint: value.signerPrimaryFingerprint,
    version: value.version,
  });
}

function assertExactStableNodeVersion(version) {
  if (
    typeof version !== "string" ||
    !/^(?:18|20|22|24)\.\d+\.\d+$/.test(version)
  ) {
    throw new Error(
      "Node runtime provisioning requires an exact stable Node version.",
    );
  }
}

async function downloadBoundedOfficialFile(input) {
  const expected = new URL(input.expectedUrl);
  if (
    expected.origin !== officialOrigin ||
    !expected.pathname.startsWith("/dist/v")
  ) {
    throw new Error("Node runtime download origin is not allowed.");
  }
  const response = await input.fetchImplementation(input.expectedUrl, {
    redirect: "error",
    signal: input.signal,
  });
  if (
    !response.ok ||
    response.redirected ||
    response.url !== input.expectedUrl
  ) {
    throw new Error("Node runtime download returned an invalid response.");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > input.maxBytes)
  ) {
    throw new Error("Node runtime download exceeded its byte limit.");
  }
  if (response.body === null)
    throw new Error("Node runtime download was empty.");
  const reader = response.body.getReader();
  const chunks = [];
  const hash = createHash("sha256");
  let total = 0;
  while (true) {
    if (input.signal?.aborted) throw input.signal.reason;
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > input.maxBytes) {
      await reader.cancel();
      throw new Error("Node runtime download exceeded its byte limit.");
    }
    hash.update(value);
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, total);
  await input.writeFile(input.destination, bytes, { mode: 0o600 });
  return { bytes: total, sha256: hash.digest("hex") };
}

function parseTarVerboseListing(output) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output) > 16 * 1024 * 1024
  ) {
    throw unsafeArchive();
  }
  return output
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      const match =
        /^([dl-])[rwxStTs-]{9}\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
      if (
        match?.[1] === undefined ||
        match[2] === undefined ||
        match[3] === undefined
      ) {
        throw unsafeArchive();
      }
      const rawPath = match[3];
      const separator = rawPath.indexOf(" -> ");
      const path = separator < 0 ? rawPath : rawPath.slice(0, separator);
      const linkTarget =
        separator < 0 ? undefined : rawPath.slice(separator + 4);
      return {
        ...(linkTarget === undefined ? {} : { linkTarget }),
        path,
        size: Number(match[2]),
        type:
          match[1] === "d"
            ? "directory"
            : match[1] === "l"
              ? "symlink"
              : "file",
      };
    });
}

function nodeRuntimeRoot(runtimeParent, archiveSha256) {
  return `${runtimeParent}/sha256/${archiveSha256}`;
}

function createDependencies(options) {
  return {
    chmod: options.chmod ?? chmod,
    fetchImplementation:
      options.fetchImplementation ?? ((url, init) => fetch(url, init)),
    lstat: options.lstat ?? lstat,
    mkdir: options.mkdir ?? mkdir,
    mkdtemp: options.mkdtemp ?? mkdtemp,
    readFile: options.readFile ?? readFile,
    readdir: options.readdir ?? readdir,
    rename: options.rename ?? rename,
    rm: options.rm ?? rm,
    runCommand: options.runCommand ?? runCommand,
    writeFile: options.writeFile ?? writeFile,
  };
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const append = (chunks, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(
          new Error("Trusted Node helper command output exceeded its limit."),
        );
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolvePromise({
        exitCode: exitCode ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
}

async function sha256File(path, dependencies) {
  const bytes = await dependencies.readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeTreeImmutable(root, dependencies) {
  const entries = await walkTree(root, dependencies);
  for (const entry of entries.toReversed()) {
    if (entry.details.isSymbolicLink()) continue;
    await dependencies.chmod(
      entry.path,
      entry.details.isDirectory()
        ? 0o555
        : entry.path.endsWith("/bin/node")
          ? 0o555
          : 0o444,
    );
  }
}

async function makeDirectoriesOwnerWritable(root, dependencies) {
  const entries = await walkTree(root, dependencies);
  for (const entry of entries) {
    if (entry.details.isDirectory() && !entry.details.isSymbolicLink()) {
      await dependencies.chmod(entry.path, 0o700);
    }
  }
}

async function validateImmutableTree(root, dependencies, expectedUid) {
  const entries = await walkTree(root, dependencies);
  for (const entry of entries) {
    if (
      entry.details.uid !== expectedUid ||
      (!entry.details.isSymbolicLink() &&
        ((entry.details.mode & 0o222) !== 0 ||
          (entry.details.mode & 0o6000) !== 0))
    ) {
      throw new Error("Trusted Node runtime artifact permissions are invalid.");
    }
  }
}

async function walkTree(root, dependencies) {
  const pending = [root];
  const result = [];
  while (pending.length > 0) {
    if (result.length > 60_000) throw unsafeArchive();
    const path = pending.pop();
    const details = await dependencies.lstat(path);
    result.push({ details, path });
    if (!details.isDirectory() || details.isSymbolicLink()) continue;
    for (const name of await dependencies.readdir(path)) {
      pending.push(`${path}/${name}`);
    }
  }
  return result;
}

async function readBoundedFile(path, maxBytes, dependencies, encoding) {
  const details = await dependencies.lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > maxBytes
  ) {
    throw new Error("Trusted Node runtime artifact record is invalid.");
  }
  return await dependencies.readFile(path, encoding);
}

function sameAttestation(left, right) {
  return [
    "archiveSha256",
    "nodeBinarySha256",
    "schemaVersion",
    "signedManifestSha256",
    "signerPrimaryFingerprint",
    "version",
  ].every((key) => left[key] === right[key]);
}

function unsafeArchive() {
  return new Error("Submitted Node release contains an unsafe Node archive.");
}

async function runCli(argv) {
  const [command, version, ...rest] = argv;
  if (command === "provision" && rest.length === 0) {
    process.stdout.write(
      `${JSON.stringify(await provisionSubmittedNodeRuntime(version))}\n`,
    );
    return;
  }
  throw new Error("Usage: provision <version>");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Trusted Node runtime helper failed."}\n`,
    );
    process.exitCode = 1;
  });
}
