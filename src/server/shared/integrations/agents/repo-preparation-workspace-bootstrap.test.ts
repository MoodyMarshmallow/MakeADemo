import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { createPipelineEventLogger } from "../../logging/pipeline-event-logger";
import { createMakeADemoOpenCodeConfigFiles } from "./prepared-opencode-config";
import { createDaytonaRepoPreparationPrompt } from "./repo-preparation-prompt-policy";
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

    expect(result).toEqual({});
    expect(events).toEqual([
      "parent-network:true",
      "parent-clone",
      "parent-network:false",
      "submitted-network:true",
      "submitted-clone",
      "submitted-network:false",
      "config",
    ]);
    expect(await readFile(join(parent, ".env"), "utf8")).toContain(sentinel);
    expect(await readFile(join(submitted, ".env"), "utf8")).toContain(sentinel);
    expect(await readAllGitText(parent)).toContain(sentinel);
    expect(await readAllGitText(submitted)).toContain(sentinel);
    expect(JSON.stringify(createMakeADemoOpenCodeConfigFiles())).not.toContain(
      sentinel,
    );
    expect(
      createDaytonaRepoPreparationPrompt({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["local configuration"] },
        workspaceId: "workspace_123",
      }),
    ).not.toContain("key-only skeletons");
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
    async setOutboundNetworkAccess(enabled) {
      input.events.push(`parent-network:${enabled}`);
    },
    async setSubmittedCodeNetworkAccess(enabled) {
      input.events.push(`submitted-network:${enabled}`);
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
    if (command.includes("plugins/makeademo-tools.ts")) {
      events.push("config");
      return { exitCode: 0, stderr: "", stdout: "" };
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
