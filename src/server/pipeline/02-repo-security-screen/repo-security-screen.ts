import { isRepoSecurityPackageManifestPath } from "./repo-security-package-manifest";
import type { RepoSecurityEvidence } from "./repository-loading/repo-security-evidence";

type RepoSecurityFile = {
  path: string;
  text?: string;
};

export type RepoSecurityInput = {
  /** Bounded static evidence available to the read-only Stage 02 reviewer. */
  evidence: RepoSecurityEvidence;
  files: RepoSecurityFile[];
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
};

type RepoSecurityFindingCode =
  | "auth-dependency"
  | "large-repository"
  | "lifecycle-postinstall"
  | "lifecycle-remote-code-execution"
  | "lifecycle-root-delete"
  | "lifecycle-suspicious-command"
  | "malformed-application-manifest"
  | "missing-lockfile"
  | "missing-supported-application-manifest"
  | "nested-application-manifest"
  | "non-object-application-manifest"
  | "private-key-filename"
  | "unreadable-application-manifest";

/**
 * Stable deterministic Repo Security Screen finding. Only
 * `lifecycle-root-delete` may use `hard-rejection`; all ambiguous evidence is
 * a warning for the read-only agent reviewer to decide.
 */
type RepoSecurityFinding = {
  code: RepoSecurityFindingCode;
  dependencyName?: string;
  message: string;
  path?: string;
  scriptName?: string;
  severity: "hard-rejection" | "warning";
};

export type RepoSecurityResult = {
  rejections: RepoSecurityFinding[];
  status: "passed" | "rejected";
  warnings: RepoSecurityFinding[];
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
  const rejections: RepoSecurityFinding[] = [];
  const warnings: RepoSecurityFinding[] = [];
  const packageFiles = normalizedFiles.filter((file) =>
    isRepoSecurityPackageManifestPath(file.path),
  );

  if (packageFiles.length === 0) {
    warnings.push(
      warning(
        "missing-supported-application-manifest",
        "repo has no supported JavaScript application manifest; Repo Preparation must locate a browser app before execution",
      ),
    );
  } else if (!paths.has("package.json")) {
    for (const packageFile of packageFiles) {
      warnings.push(
        warning(
          "nested-application-manifest",
          `repo uses a bounded nested JavaScript application manifest at ${packageFile.path}`,
          { path: packageFile.path },
        ),
      );
    }
  }

  for (const file of normalizedFiles) {
    if (isCommittedPrivateKey(file.path)) {
      warnings.push(
        warning(
          "private-key-filename",
          `repo contains private-key filename ${file.path} and requires agent safety review`,
          { path: file.path },
        ),
      );
    }
  }

  for (const packageFile of packageFiles) {
    if (packageFile.text === undefined) {
      warnings.push(
        warning(
          "unreadable-application-manifest",
          `package manifest ${packageFile.path} could not be inspected and requires agent safety review`,
          { path: packageFile.path },
        ),
      );
      continue;
    }
    inspectPackageJson(
      packageFile.path,
      packageFile.text,
      rejections,
      warnings,
    );
  }

  if (
    input.repoStats.fileCount > LARGE_REPO_FILE_COUNT ||
    input.repoStats.sizeBytes > LARGE_REPO_SIZE_BYTES
  ) {
    warnings.push(
      warning(
        "large-repository",
        "repo size or file count may degrade agent exploration quality",
      ),
    );
  }

  if (
    packageFiles.length > 0 &&
    !packageFiles.some((file) => hasSiblingLockfile(file.path, paths))
  ) {
    warnings.push(
      warning(
        "missing-lockfile",
        "repo has no lockfile; dependency installation may be less deterministic",
      ),
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
  path: string,
  text: string,
  rejections: RepoSecurityFinding[],
  warnings: RepoSecurityFinding[],
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push(
      warning(
        "malformed-application-manifest",
        `package manifest ${path} is malformed and requires agent safety review`,
        { path },
      ),
    );
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(
      warning(
        "non-object-application-manifest",
        `package manifest ${path} is not an object and requires agent safety review`,
        { path },
      ),
    );
    return;
  }

  const packageRecord = parsed as Record<string, unknown>;
  inspectScripts(path, packageRecord.scripts, rejections, warnings);
  inspectDependencies(path, packageRecord.dependencies, warnings);
  inspectDependencies(path, packageRecord.devDependencies, warnings);
}

function inspectScripts(
  packagePath: string,
  scripts: unknown,
  rejections: RepoSecurityFinding[],
  warnings: RepoSecurityFinding[],
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

    const normalizedCommand = command.trim().replace(/\s+/g, " ");
    if (normalizedCommand === "rm -rf /") {
      rejections.push({
        code: "lifecycle-root-delete",
        message: `package script ${name} contains a destructive command`,
        path: packagePath,
        scriptName: name,
        severity: "hard-rejection",
      });
    } else if (/rm\s+-rf\s+\/|mkfs|forkbomb|crypto.?miner/i.test(command)) {
      warnings.push(
        warning(
          "lifecycle-suspicious-command",
          `package script ${packagePath}#${name} contains suspicious command text and requires agent safety review`,
          { path: packagePath, scriptName: name },
        ),
      );
    }

    if (/(?:curl|wget)\b[^\n]*(?:\||&&)\s*(?:ba)?sh\b/i.test(command)) {
      warnings.push(
        warning(
          "lifecycle-remote-code-execution",
          `package script ${packagePath}#${name} downloads and executes remote code and requires agent safety review`,
          { path: packagePath, scriptName: name },
        ),
      );
    }

    if (name === "postinstall") {
      warnings.push(
        warning(
          "lifecycle-postinstall",
          `package script ${packagePath}#postinstall requires agent safety review`,
          { path: packagePath, scriptName: name },
        ),
      );
    }
  }
}

function hasSiblingLockfile(packagePath: string, paths: Set<string>): boolean {
  const directory = packagePath.slice(0, -"package.json".length);
  return [...lockfiles].some((lockfile) =>
    paths.has(`${directory}${lockfile}`),
  );
}

function inspectDependencies(
  packagePath: string,
  dependencies: unknown,
  warnings: RepoSecurityFinding[],
) {
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
        warning(
          "auth-dependency",
          `auth package ${name} may require local demo bypass or mocks`,
          { dependencyName: name, path: packagePath },
        ),
      );
    }
  }
}

function warning(
  code: Exclude<RepoSecurityFindingCode, "lifecycle-root-delete">,
  message: string,
  details: Pick<
    RepoSecurityFinding,
    "dependencyName" | "path" | "scriptName"
  > = {},
): RepoSecurityFinding {
  return { code, message, severity: "warning", ...details };
}
