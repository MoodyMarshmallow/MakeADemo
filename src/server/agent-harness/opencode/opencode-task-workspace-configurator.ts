import { posix } from "node:path";

import {
  type PreparedOpenCodeFile,
  createMakeADemoOpenCodeConfigFiles,
} from "./prepared-opencode-config";

const defaultRootDirectory = "/tmp/makeademo";
const scopePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type OpenCodeTaskWorkspaceConfig = {
  scope: string;
  stageToolFiles?: readonly PreparedOpenCodeFile[];
};

export type OpenCodeTaskWorkspaceConfigurator = {
  baseConfigDirectory: string;
  configDirectoryForScope(scope: string): string;
  createTaskConfigFiles(
    stageToolFiles?: readonly PreparedOpenCodeFile[],
  ): PreparedOpenCodeFile[];
  createWriteCommand(
    configurations: readonly OpenCodeTaskWorkspaceConfig[],
  ): string;
};

/**
 * Builds isolated OpenCode configuration directories for Agent Harness tasks.
 * Each task receives universal runtime policy and Global Agent Tools together
 * with only its own Stage Agent Tools.
 */
export function createOpenCodeTaskWorkspaceConfigurator(
  input: {
    baseConfigFiles?: readonly PreparedOpenCodeFile[];
    globalToolFiles?: readonly PreparedOpenCodeFile[];
    rootDirectory?: string;
  } = {},
): OpenCodeTaskWorkspaceConfigurator {
  const rootDirectory = input.rootDirectory ?? defaultRootDirectory;
  const baseConfigDirectory = posix.join(rootDirectory, "opencode");
  const baseConfigFiles =
    input.baseConfigFiles ?? createMakeADemoOpenCodeConfigFiles();
  const globalToolFiles = input.globalToolFiles ?? [];

  function configDirectoryForScope(scope: string): string {
    assertScope(scope);
    return posix.join(rootDirectory, `opencode-${scope}`);
  }

  function createTaskConfigFiles(
    stageToolFiles: readonly PreparedOpenCodeFile[] = [],
  ): PreparedOpenCodeFile[] {
    return [...baseConfigFiles, ...globalToolFiles, ...stageToolFiles];
  }

  function createWriteCommand(
    configurations: readonly OpenCodeTaskWorkspaceConfig[],
  ): string {
    const scopedConfigurations = configurations.map((configuration) => ({
      ...configuration,
      directory: configDirectoryForScope(configuration.scope),
    }));
    assertUniqueDirectories(
      scopedConfigurations.map(({ directory }) => directory),
    );

    const directories = [
      baseConfigDirectory,
      ...scopedConfigurations.map(({ directory }) => directory),
    ];
    const commands = [
      `rm -rf ${directories.map(shellQuote).join(" ")}`,
      `mkdir -p ${directories.map(shellQuote).join(" ")}`,
      ...createWriteFileCommands(baseConfigDirectory, createTaskConfigFiles()),
      ...scopedConfigurations.flatMap(({ directory, stageToolFiles }) =>
        createWriteFileCommands(
          directory,
          createTaskConfigFiles(stageToolFiles),
        ),
      ),
    ];
    return commands.join("\n");
  }

  return {
    baseConfigDirectory,
    configDirectoryForScope,
    createTaskConfigFiles,
    createWriteCommand,
  };
}

function assertScope(scope: string): void {
  if (!scopePattern.test(scope)) {
    throw new Error(
      "OpenCode task scope must use lowercase letters, digits, and hyphens.",
    );
  }
}

function assertUniqueDirectories(directories: readonly string[]): void {
  if (new Set(directories).size !== directories.length) {
    throw new Error("OpenCode task configuration scopes must be unique.");
  }
}

function createWriteFileCommands(
  directory: string,
  files: readonly PreparedOpenCodeFile[],
): string[] {
  return files.map((file) => {
    const destination = posix.join(directory, safeRelativePath(file.path));
    return [
      `mkdir -p ${shellQuote(posix.dirname(destination))} && cat > ${shellQuote(destination)} <<'MAKEADEMO_OPENCODE_FILE'`,
      file.content,
      "MAKEADEMO_OPENCODE_FILE",
    ].join("\n");
  });
}

function safeRelativePath(path: string): string {
  const normalizedPath = posix.normalize(path);
  if (
    path.length === 0 ||
    posix.isAbsolute(path) ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    throw new Error("OpenCode configuration file paths must be relative.");
  }
  return normalizedPath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}
