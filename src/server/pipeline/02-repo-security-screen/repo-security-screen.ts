type RepoSecurityFile = {
  path: string;
  text?: string;
};

export type RepoSecurityInput = {
  files: RepoSecurityFile[];
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
};

export type RepoSecurityResult = {
  rejections: string[];
  status: "passed" | "rejected";
  warnings: string[];
};

const LARGE_REPO_FILE_COUNT = 20_000;
const LARGE_REPO_SIZE_BYTES = 500_000_000;
const lockfiles = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const privateKeyFilenames = new Set(["id_ed25519", "id_rsa"]);

export function screenRepoSecurity(
  input: RepoSecurityInput,
): RepoSecurityResult {
  const normalizedFiles = input.files.map((file) => ({
    ...file,
    path: file.path.replace(/^\.\//, ""),
  }));
  const paths = new Set(normalizedFiles.map((file) => file.path));
  const rejections: string[] = [];
  const warnings: string[] = [];

  if (!paths.has("package.json")) {
    rejections.push("package.json is required for JavaScript/TypeScript repos");
  }

  for (const file of normalizedFiles) {
    if (isCommittedPrivateKey(file.path)) {
      rejections.push(`repo contains committed secret file ${file.path}`);
    }
  }

  const packageFile = normalizedFiles.find(
    (file) => file.path === "package.json",
  );
  if (packageFile?.text) {
    inspectPackageJson(packageFile.text, rejections, warnings);
  }

  if (
    input.repoStats.fileCount > LARGE_REPO_FILE_COUNT ||
    input.repoStats.sizeBytes > LARGE_REPO_SIZE_BYTES
  ) {
    warnings.push(
      "repo size or file count may degrade agent exploration quality",
    );
  }

  if (![...paths].some((path) => lockfiles.has(path))) {
    warnings.push(
      "repo has no lockfile; dependency installation may be less deterministic",
    );
  }

  return {
    rejections,
    status: rejections.length > 0 ? "rejected" : "passed",
    warnings,
  };
}

function isCommittedPrivateKey(path: string) {
  const filename = path.split("/").at(-1) ?? path;
  return privateKeyFilenames.has(filename);
}

function inspectPackageJson(
  text: string,
  rejections: string[],
  warnings: string[],
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    rejections.push("package.json must be valid JSON");
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    rejections.push("package.json must be an object");
    return;
  }

  const packageRecord = parsed as Record<string, unknown>;
  inspectScripts(packageRecord.scripts, rejections, warnings);
  inspectDependencies(packageRecord.dependencies, warnings);
  inspectDependencies(packageRecord.devDependencies, warnings);
}

function inspectScripts(
  scripts: unknown,
  rejections: string[],
  warnings: string[],
) {
  if (
    typeof scripts !== "object" ||
    scripts === null ||
    Array.isArray(scripts)
  ) {
    return;
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      continue;
    }

    if (
      /rm\s+-rf\s+\//.test(command) ||
      /mkfs|forkbomb|crypto.?miner/i.test(command)
    ) {
      rejections.push(`package script ${name} contains a destructive command`);
    }

    if (name === "postinstall") {
      warnings.push(
        "package script postinstall may run setup code during dependency installation",
      );
    }
  }
}

function inspectDependencies(dependencies: unknown, warnings: string[]) {
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    return;
  }

  for (const name of Object.keys(dependencies)) {
    if (/clerk|auth|oauth/i.test(name)) {
      warnings.push(
        `auth package ${name} may require local demo bypass or mocks`,
      );
    }
  }
}
