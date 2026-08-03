export type ReadOnlyCommandRequest = {
  argv: readonly string[];
};

export type ReadOnlyCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type ReadOnlyCommandExecuteOptions = {
  timeoutMs: number;
};

const enforcedRgArgs = [
  "--color=never",
  "--no-heading",
  "--max-count=2000",
  "--max-columns=1000",
  "--max-columns-preview",
] as const;

/** Validates a repository-inspection request and returns the only argv a provider may run. */
export function canonicalizeReadOnlyCommand(
  request: ReadOnlyCommandRequest,
): ReadOnlyCommandRequest {
  const [program, ...args] = request.argv;
  if (program === "rg") {
    return { argv: canonicalizeRg(args) };
  }
  if (program === "sed") {
    return { argv: canonicalizeSed(args) };
  }
  if (program === "git") {
    return { argv: canonicalizeGit(args) };
  }
  throw new Error(
    "exec_command only permits rg, sed, and selected git queries.",
  );
}

function canonicalizeRg(args: readonly string[]): string[] {
  const canonical: string[] = ["rg"];
  let filesMode = false;
  let index = 0;
  while (index < args.length && args[index]?.startsWith("-") === true) {
    const value = args[index];
    if (value === "--") {
      index += 1;
      break;
    }
    if (value === "--files") {
      filesMode = true;
      canonical.push("--files");
    } else if (value === "-n" || value === "--line-number") {
      canonical.push("--line-number");
    } else if (value === "-F" || value === "--fixed-strings") {
      canonical.push("--fixed-strings");
    } else if (value === "-i" || value === "--ignore-case") {
      canonical.push("--ignore-case");
    } else if (value === "-w" || value === "--word-regexp") {
      canonical.push("--word-regexp");
    } else if (value === "-x" || value === "--line-regexp") {
      canonical.push("--line-regexp");
    } else if (value === "--hidden") {
      canonical.push("--hidden");
    } else if (
      value === "-g" ||
      value === "--glob" ||
      value === "-t" ||
      value === "--type" ||
      value === "-T" ||
      value === "--type-not"
    ) {
      const optionValue = args[index + 1];
      if (
        optionValue === undefined ||
        optionValue.length === 0 ||
        optionValue.startsWith("-")
      ) {
        throw new Error(`rg option requires a value: ${value}`);
      }
      canonical.push(
        value === "-g" ? "--glob" : value === "-t" ? "--type" : value,
        optionValue,
      );
      index += 1;
    } else {
      throw new Error(`rg option is not allowed: ${value}`);
    }
    index += 1;
  }

  if (filesMode) {
    const paths = args.slice(index);
    for (const path of paths) assertSafeRelativePath(path);
    canonical.push(
      "--glob=!.git/**",
      "--glob=!.makeademo/**",
      "--",
      ...(paths.length === 0 ? ["."] : paths),
    );
    return canonical;
  }

  const pattern = args[index];
  if (pattern === undefined || pattern.length === 0) {
    throw new Error("rg search requires a non-empty pattern.");
  }
  index += 1;
  const paths = args.slice(index);
  for (const path of paths) assertSafeRelativePath(path);
  canonical.push(
    ...enforcedRgArgs,
    "--glob=!.git/**",
    "--glob=!.makeademo/**",
    "-e",
    pattern,
    "--",
    ...(paths.length === 0 ? ["."] : paths),
  );
  return canonical;
}

function canonicalizeSed(args: readonly string[]): string[] {
  const normalized =
    args[2] === "--" ? args : [args[0], args[1], "--", ...args.slice(2)];
  if (
    normalized.length !== 4 ||
    normalized[0] !== "-n" ||
    normalized[2] !== "--"
  ) {
    throw new Error("sed only permits: sed -n START[,END]p -- RELATIVE_FILE.");
  }
  const expression = normalized[1];
  const match = /^(\d{1,7})(?:,(\d{1,7}))?p$/.exec(expression ?? "");
  if (match === null) {
    throw new Error("sed expression must be a numeric print-only range.");
  }
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < start || end - start + 1 > 400) {
    throw new Error("sed may print at most 400 ordered lines per call.");
  }
  const path = normalized[3];
  if (path === undefined) {
    throw new Error("sed accepts exactly one repository file.");
  }
  assertSafeRelativePath(path);
  return [
    "sed",
    "-n",
    `${start}${end === start ? "" : `,${end}`}p`,
    "--",
    path,
  ];
}

function canonicalizeGit(args: readonly string[]): string[] {
  const [subcommand, ...rest] = args;
  if (
    subcommand === "rev-parse" &&
    (sameArgs(rest, ["HEAD"]) || sameArgs(rest, ["--verify", "HEAD"]))
  ) {
    return ["git", "rev-parse", "--verify", "HEAD"];
  }
  if (
    subcommand === "status" &&
    (rest.length === 0 || sameArgs(rest, ["--short"]))
  ) {
    return ["git", "status", "--short", "--untracked-files=no"];
  }
  if (subcommand === "ls-files") {
    const paths = rest[0] === "--" ? rest.slice(1) : rest;
    for (const path of paths) assertSafeGitPath(path);
    return ["git", "ls-files", "--", ...paths];
  }
  if (subcommand === "show") {
    return canonicalizeGitShow(rest);
  }
  if (subcommand === "log") {
    return canonicalizeGitLog(rest);
  }
  if (subcommand === "diff") {
    return canonicalizeGitDiff(rest);
  }
  throw new Error(`git query is not allowed: ${subcommand ?? "(missing)"}`);
}

function canonicalizeGitShow(args: readonly string[]): string[] {
  if (args.length === 1 && args[0]?.startsWith("HEAD:") === true) {
    const path = args[0].slice("HEAD:".length);
    assertSafeGitPath(path);
    return [
      "git",
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--format=",
      `HEAD:${path}`,
    ];
  }
  if (sameArgs(args, ["--stat"]) || sameArgs(args, ["--stat", "HEAD"])) {
    return [
      "git",
      "show",
      "--stat",
      "--oneline",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
    ];
  }
  throw new Error("git show only permits HEAD:RELATIVE_PATH or --stat HEAD.");
}

function canonicalizeGitLog(args: readonly string[]): string[] {
  let count = 20;
  if (args.length === 1) {
    const match = /^--max-count=(\d{1,2})$/.exec(args[0] ?? "");
    if (match === null) {
      throw new Error("git log only accepts --max-count=N.");
    }
    count = Number(match[1]);
  } else if (args.length > 0) {
    throw new Error("git log only accepts --max-count=N.");
  }
  if (count < 1 || count > 50) {
    throw new Error("git log is limited to 50 commits.");
  }
  return [
    "git",
    "log",
    `--max-count=${count}`,
    "--no-decorate",
    "--format=%H%x09%aI%x09%s",
  ];
}

function canonicalizeGitDiff(args: readonly string[]): string[] {
  if (args[0] !== "HEAD") {
    throw new Error("git diff must compare explicit repository paths to HEAD.");
  }
  const separator = args[1] === "--" ? 2 : 1;
  const paths = args.slice(separator);
  if (paths.length === 0) {
    throw new Error("git diff requires at least one repository path.");
  }
  for (const path of paths) assertSafeGitPath(path);
  return [
    "git",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "HEAD",
    "--",
    ...paths,
  ];
}

function assertSafeGitPath(path: string): void {
  if (path.startsWith(":")) {
    throw new Error("Git pathspec magic is not allowed.");
  }
  assertSafeRelativePath(path);
}

function sameArgs(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "..") ||
    path.split("/").some((part) => part === ".git" || part === ".makeademo")
  ) {
    throw new Error(`Repository path is not allowed: ${path}`);
  }
}
