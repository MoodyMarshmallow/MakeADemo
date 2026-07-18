#!/usr/bin/env node
import { lstat, opendir, readFile } from "node:fs/promises";
import { posix } from "node:path";

const workspace = process.cwd();
const maxFileBytes = 64 * 1024;
const maxCandidates = 32;
const maxDirectoryEntries = 256;
const maxVisitedRoots = 96;
const maxLstats = 512;
let visitedDirectoryEntries = 0;
let visitedRoots = 1;
let performedLstats = 0;
const acceptedFiles = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
]);
const presenceOnlyFiles = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const rootPackage = await boundedLstatIfExists(
  posix.join(workspace, "package.json"),
);
const candidates =
  rootPackage === undefined
    ? await discoverNestedCandidates()
    : [{ files: await readRootFiles(rootPackage), projectRoot: "." }];

process.stdout.write(JSON.stringify({ candidates }));

async function discoverNestedCandidates() {
  const roots = [];
  for (const first of await safeDirectories(workspace)) {
    pushRoot(roots, first);
    for (const second of await safeDirectories(posix.join(workspace, first))) {
      pushRoot(roots, posix.join(first, second));
    }
  }

  const nestedCandidates = [];
  for (const projectRoot of roots.sort()) {
    const directory = posix.join(workspace, projectRoot);
    const names = await safeNames(directory);
    if (!names.includes("package.json")) continue;
    nestedCandidates.push({
      files: await readNamedFiles(directory, projectRoot, names),
      projectRoot,
    });
    if (nestedCandidates.length > maxCandidates)
      throw new Error("too many JavaScript project roots");
  }
  return nestedCandidates;
}

async function readRootFiles(packageDetails) {
  const files = {};
  for (const name of acceptedFiles) {
    const details =
      name === "package.json"
        ? packageDetails
        : await boundedLstatIfExists(posix.join(workspace, name));
    if (details === undefined) continue;
    await readMetadataFile(files, workspace, ".", name, details);
  }
  return files;
}

async function readNamedFiles(directory, projectRoot, names) {
  const files = {};
  for (const name of names) {
    if (!acceptedFiles.has(name)) continue;
    const details = await boundedLstat(posix.join(directory, name));
    await readMetadataFile(files, directory, projectRoot, name, details);
  }
  return files;
}

async function readMetadataFile(files, directory, projectRoot, name, details) {
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`unsafe toolchain metadata file: ${projectRoot}/${name}`);
  }
  if (presenceOnlyFiles.has(name)) {
    files[name] = "";
    return;
  }
  if (details.size > maxFileBytes)
    throw new Error(`unsafe toolchain metadata file: ${projectRoot}/${name}`);
  files[name] = await readFile(posix.join(directory, name), "utf8");
}

async function safeNames(directory) {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return [];
  }
  const names = [];
  for await (const entry of entries) {
    visitedDirectoryEntries += 1;
    assertTraversalBudget();
    names.push(entry.name);
  }
  return names.sort();
}

async function safeDirectories(directory) {
  const result = [];
  for (const name of await safeNames(directory)) {
    if (
      !/^[A-Za-z0-9._-]+$/.test(name) ||
      name === "node_modules" ||
      name === ".git"
    )
      continue;
    const details = await boundedLstat(posix.join(directory, name));
    if (details.isDirectory() && !details.isSymbolicLink()) result.push(name);
  }
  return result;
}

function pushRoot(roots, root) {
  visitedRoots += 1;
  assertTraversalBudget();
  roots.push(root);
}

async function boundedLstat(path) {
  performedLstats += 1;
  assertTraversalBudget();
  return await lstat(path);
}

async function boundedLstatIfExists(path) {
  try {
    return await boundedLstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertTraversalBudget() {
  if (
    visitedDirectoryEntries > maxDirectoryEntries ||
    visitedRoots > maxVisitedRoots ||
    performedLstats > maxLstats
  ) {
    throw new Error("toolchain inspection traversal budget exceeded");
  }
}
