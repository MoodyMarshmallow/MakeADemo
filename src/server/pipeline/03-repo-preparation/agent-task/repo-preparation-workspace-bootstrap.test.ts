import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createPipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../preparation-workspace.interface";
import { bootstrapRepoPreparationWorkspace } from "./repo-preparation-workspace-bootstrap";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("bootstrapRepoPreparationWorkspace", () => {
  it("uses the provider's repository-command boundary for the parent clone and Git inventory", async () => {
    const repositoryCommands: string[] = [];
    const trustedCommands: string[] = [];
    const workspace: PreparationWorkspace = {
      async execute(command) {
        trustedCommands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeRepositoryCommand(command) {
        repositoryCommands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command === "git -C /workspace ls-files -z"
              ? "README.md\0package.json\0"
              : "cloned",
        };
      },
      async uploadFiles() {},
    };

    const result = await bootstrapRepoPreparationWorkspace({
      logger: createPipelineEventLogger({ sinks: [] }),
      repoUrl: "https://github.com/example/app",
      workspace,
    });

    expect(result).toEqual({
      baselineSourceControlledPaths: ["README.md", "package.json"],
    });
    expect(repositoryCommands).toHaveLength(2);
    expect(repositoryCommands[0]).toContain("git clone");
    expect(repositoryCommands[1]).toBe("git -C /workspace ls-files -z");
    expect(trustedCommands).toEqual([]);
  });

  it("preserves committed dotenv files and Git history in both workspaces", async () => {
    const sentinel = "DOTENV_CANARY_ORIGINAL";
    const root = await createTemporaryDirectory();
    const source = join(root, "source");
    const parent = join(root, "parent");
    const submitted = join(root, "submitted");
    await mkdir(join(source, "apps", "web"), { recursive: true });
    await writeFile(
      join(source, ".env"),
      `API_KEY=${sentinel}\nPUBLIC_URL=https://remote.example.test\n`,
    );
    await writeFile(
      join(source, "apps", "web", ".env.production"),
      `DATABASE_URL=${sentinel}\n`,
    );
    await writeFile(join(source, "package.json"), '{"name":"fixture"}\n');
    await git(source, ["init", "--quiet"]);
    await git(source, ["config", "user.name", "Fixture"]);
    await git(source, ["config", "user.email", "fixture@example.test"]);
    await git(source, ["add", "-A"]);
    await git(source, ["commit", "--quiet", "-m", "original"]);
    await cp(source, parent, { recursive: true });
    await cp(source, submitted, { recursive: true });
    const events: string[] = [];
    const commands: string[] = [];
    const logs: unknown[] = [];
    const workspace = createLocalBootstrapWorkspace({
      commands,
      events,
      logs,
      parent,
      submitted,
    });

    const result = await bootstrapRepoPreparationWorkspace({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      logger: createPipelineEventLogger({ sinks: [] }),
      repoUrl: "https://github.com/example/app",
      workspace,
    });

    expect(result.baselineSourceControlledPaths).toEqual([
      ".env",
      "apps/web/.env.production",
      "package.json",
    ]);
    expect(events).toEqual(["parent-clone", "submitted-clone"]);
    expect(await readFile(join(parent, ".env"), "utf8")).toContain(sentinel);
    expect(await readFile(join(submitted, ".env"), "utf8")).toContain(sentinel);
    expect(await readAllGitText(parent)).toContain(sentinel);
    expect(await readAllGitText(submitted)).toContain(sentinel);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "makeademo-bootstrap-"));
  temporaryDirectories.push(path);
  return path;
}

function createLocalBootstrapWorkspace(input: {
  commands: string[];
  events: string[];
  logs: unknown[];
  parent: string;
  submitted: string;
}): PreparationWorkspace {
  return {
    execute: createExecutor(input.commands, input.events, "parent"),
    executeSubmittedCode: createExecutor(
      input.commands,
      input.events,
      "submitted",
    ),
    async getPreviewUrl() {
      throw new Error("getPreviewUrl should not be called");
    },
    async uploadFiles() {
      throw new Error("uploadFiles should not be called");
    },
    async writeSandboxLog(entry) {
      input.logs.push(entry);
    },
  };
}

function createExecutor(
  commands: string[],
  events: string[],
  kind: "parent" | "submitted",
): (command: string) => Promise<PreparationWorkspaceCommandResult> {
  return async (command) => {
    commands.push(command);
    if (command.includes("git clone")) {
      events.push(`${kind}-clone`);
      return { exitCode: 0, stderr: "", stdout: "cloned" };
    }
    if (command === "git -C /workspace ls-files -z") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: ".env\0apps/web/.env.production\0package.json\0",
      };
    }
    throw new Error(`Unexpected ${kind} command.`);
  };
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args]);
  return result.stdout.trim();
}

async function readAllGitText(directory: string): Promise<string> {
  const objects = await git(directory, ["rev-list", "--objects", "--all"]);
  const values: string[] = [];
  for (const line of objects.split("\n")) {
    const [object] = line.split(" ");
    if (object === undefined || object.length === 0) continue;
    try {
      values.push(await git(directory, ["cat-file", "-p", object]));
    } catch {
      // Tree objects are not dotenv content and may not decode as text.
    }
  }
  return values.join("\n");
}

import { execFile } from "node:child_process";
