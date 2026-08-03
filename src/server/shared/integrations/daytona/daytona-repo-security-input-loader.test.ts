import { describe, expect, it } from "vitest";

import { screenRepoSecurity } from "../../../pipeline/02-repo-security-screen/repo-security-screen";
import { readRepoSecurityInputTextPolicy } from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-input";
import { createPipelineEventLogger } from "../../logging/pipeline-event-logger";
import {
  DaytonaRepoSecurityInputLoader,
  type DaytonaRepoSecurityInputLoaderOptions,
  type RepositoryLoadingWorkspace,
  type RepositoryLoadingWorkspaceCommandResult,
  type RepositoryLoadingWorkspaceHandle,
  type RepositoryLoadingWorkspaceProvider,
} from "./daytona-repo-security-input-loader";

describe("DaytonaRepoSecurityInputLoader", () => {
  it("retains the pinned parent workspace and source baseline for Repo Preparation", async () => {
    const provider = new FakeRepositoryLoadingWorkspaceProvider(
      new FakeRepositoryLoadingWorkspace(),
    );
    const loaded = await new DaytonaRepoSecurityInputLoader({ provider }).load({
      commitSha: "a".repeat(40),
      repoUrl: "https://github.com/example/app",
      shouldReadText: readRepoSecurityInputTextPolicy,
    });

    expect(loaded.preparationWorkspace.id).toBe("workspace-1");
    expect(loaded.baselineSourceControlledPaths).toEqual(["package.json"]);
    expect(provider.releasedWorkspaceIds).toEqual([]);
  });

  it("treats an installation-selected public repo as public source", async () => {
    const commands: string[] = [];
    const loaded = await new DaytonaRepoSecurityInputLoader({
      provider: new FakeRepositoryLoadingWorkspaceProvider(
        new FakeRepositoryLoadingWorkspace({ commands }),
      ),
    }).load({
      commitSha: "c".repeat(40),
      githubInstallationId: "installation-123",
      repoUrl: "https://github.com/example/public-app",
      repoVisibility: "public",
      shouldReadText: readRepoSecurityInputTextPolicy,
    });

    expect(loaded.baselineSourceControlledPaths).toEqual(["package.json"]);
    expect(commands.find((command) => command.includes("git clone"))).toContain(
      "https://github.com/example/public-app",
    );
    expect(commands.join("\n")).not.toContain("installation-123");
  });

  it("fails closed for private source until installation authority is server-bound", async () => {
    const commands: string[] = [];
    const provider = new FakeRepositoryLoadingWorkspaceProvider(
      new FakeRepositoryLoadingWorkspace({ commands }),
    );

    await expect(
      new DaytonaRepoSecurityInputLoader({ provider }).load({
        commitSha: "b".repeat(40),
        githubInstallationId: "installation-123",
        repoUrl: "https://github.com/example/private-app",
        repoVisibility: "private",
        shouldReadText: readRepoSecurityInputTextPolicy,
      }),
    ).rejects.toThrow("requires a server-bound GitHub installation grant");

    expect(commands).toEqual([]);
    expect(provider.releasedWorkspaceIds).toEqual(["workspace-1"]);
  });
  it("inspects supported manifests independently of the generic evidence budget", async () => {
    const rootManifest = JSON.stringify({
      scripts: { install: "rm -rf /" },
    });
    const dummyManifest = `${" ".repeat(32 * 1_024 - 2)}{}`;
    const textByPath: Record<string, string> = {
      "package.json": rootManifest,
    };
    const stats = [
      { path: "package.json", sizeBytes: Buffer.byteLength(rootManifest) },
      ...Array.from({ length: 17 }, (_, index) => {
        const path = `apps/app-${index.toString().padStart(2, "0")}/package.json`;
        textByPath[path] = dummyManifest;
        return { path, sizeBytes: 32 * 1_024 };
      }),
    ];
    const result = await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(
        new FakeRepositoryLoadingWorkspace({
          fileStats: inventoryRecords(stats),
          textByPath,
        }),
      ),
      "https://github.com/example/app",
    );

    expect(result.files.filter((file) => file.text !== undefined)).toHaveLength(
      18,
    );
    expect(screenRepoSecurity(result)).toMatchObject({
      rejections: expect.arrayContaining([
        expect.objectContaining({ code: "lifecycle-root-delete" }),
      ]),
      status: "rejected",
    });
  });

  it("loads bounded static review evidence without executing repository content", async () => {
    const commands: string[] = [];
    const largeScript = "x".repeat(40_000);
    const workspace = new FakeRepositoryLoadingWorkspace({
      commands,
      fileStats: inventoryRecords([
        { path: "scripts/review.sh", sizeBytes: 40_000 },
        { path: "package.json", sizeBytes: 17 },
        { path: ".env", sizeBytes: 31 },
        { path: "keys/id_rsa", sizeBytes: 128 },
        { path: "src/app.ts", sizeBytes: 20 },
      ]),
      textByPath: {
        ".env": "EVIDENCE_SECRET",
        "keys/id_rsa": "PRIVATE_KEY_SECRET",
        "package.json": '{"name":"app"}',
        "scripts/review.sh": largeScript,
        "src/app.ts": "console.log('app')",
      },
    });

    const result = await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(workspace),
      "https://github.com/example/app",
    );

    expect(result.evidence?.files.map((file) => file.path)).toEqual([
      "package.json",
      "scripts/review.sh",
    ]);
    expect(result.evidence?.files[1]).toMatchObject({
      excerptBytes: 32 * 1_024,
      excerptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      path: "scripts/review.sh",
      truncated: true,
    });
    expect(result.evidence?.coverage).toMatchObject({
      selectedFileCount: 2,
      truncatedFileCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("EVIDENCE_SECRET");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY_SECRET");
    const evidenceReads = commands.filter((command) =>
      command.startsWith("head -c "),
    );
    expect(evidenceReads).toEqual([
      "head -c 18 -- '/workspace/package.json'",
      "head -c 32769 -- '/workspace/scripts/review.sh'",
    ]);
    expect(commands.some((command) => command.startsWith("cat "))).toBe(false);
    expect(commands.join("\n")).not.toMatch(
      /(?:^|\s)(?:bun|node|npm|pnpm|yarn)\s/,
    );
  });

  it("bounds concurrent static file reads", async () => {
    const textByPath: Record<string, string> = {};
    const fileStats = Array.from({ length: 12 }, (_, index) => {
      const path = `scripts/read-${index.toString().padStart(2, "0")}.sh`;
      textByPath[path] = "#!/bin/sh\necho reviewed";
      return { path, sizeBytes: 24 };
    });
    const workspace = new FakeRepositoryLoadingWorkspace({
      evidenceReadDelayMs: 5,
      fileStats: inventoryRecords(fileStats),
      textByPath,
    });

    await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(workspace),
      "https://github.com/example/app",
    );

    expect(workspace.maxConcurrentEvidenceReads).toBeGreaterThan(1);
    expect(workspace.maxConcurrentEvidenceReads).toBeLessThanOrEqual(4);
  });

  it("parses NUL-delimited inventory paths containing tabs and newlines", async () => {
    const tabPath = "scripts/with\ttab.sh";
    const newlinePath = "scripts/with\nnewline.sh";
    const workspace = new FakeRepositoryLoadingWorkspace({
      fileStats: inventoryRecords([
        { path: tabPath, sizeBytes: 8 },
        { path: newlinePath, sizeBytes: 8 },
        { path: "package.json", sizeBytes: 2 },
      ]),
      textByPath: {
        [newlinePath]: "echo two",
        "package.json": "{}",
        [tabPath]: "echo one",
      },
    });

    const result = await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(workspace),
      "https://github.com/example/app",
    );

    expect(result.repoStats).toEqual({ fileCount: 3, sizeBytes: 18 });
    expect(result.files.map((file) => file.path)).toEqual([
      tabPath,
      newlinePath,
      "package.json",
    ]);
    expect(result.evidence?.files.map((file) => file.path)).toEqual([
      "package.json",
    ]);
    expect(result.evidence?.inventory.sampledPaths).toEqual(["package.json"]);
    expect(result.evidence?.inventory.sampledPathOmissionCount).toBe(2);
  });

  it("rejects inventory transport larger than its fixed output bound", async () => {
    const workspace = new FakeRepositoryLoadingWorkspace({
      fileStats: "x".repeat(4 * 1_024 * 1_024 + 1),
    });

    await expect(
      readRepoSecurityInput(
        new FakeRepositoryLoadingWorkspaceProvider(workspace),
        "https://github.com/example/app",
      ),
    ).rejects.toThrow(
      "Repo security inventory exceeds the 4194304-byte transport limit.",
    );
  });

  it("screens the exact requested repository commit", async () => {
    const commands: string[] = [];

    await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(commands),
      "https://github.com/example/app",
      { commitSha: "0123456789abcdef0123456789abcdef01234567" },
    );

    expect(commands[0]).toContain(
      "checkout --detach '0123456789abcdef0123456789abcdef01234567'",
    );
    expect(commands[0]).toContain(
      `test "$(git -C '/workspace' rev-parse HEAD)" = '0123456789abcdef0123456789abcdef01234567'`,
    );
  });

  it("inventories dotenv paths without reading or returning their contents", async () => {
    const commands: string[] = [];
    const sentinel = "DOTENV_CANARY_ORIGINAL";
    const workspace = new FakeRepositoryLoadingWorkspace({
      commands,
      fileStats: inventoryRecords([
        { path: "package.json", sizeBytes: 17 },
        { path: ".env", sizeBytes: 31 },
        { path: "apps/web/.env.production", sizeBytes: 42 },
        { path: ".env.test.local.template", sizeBytes: 27 },
      ]),
      textByPath: {
        ".env": `API_KEY=${sentinel}`,
        ".env.test.local.template": `API_KEY=${sentinel}`,
        "apps/web/.env.production": `API_KEY=${sentinel}`,
        "package.json": '{"name":"app"}',
      },
    });

    const result = await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(workspace),
      "https://github.com/example/app",
    );

    expect(result.files).toEqual([
      { path: "package.json", text: '{"name":"app"}' },
      { path: ".env" },
      { path: "apps/web/.env.production" },
      { path: ".env.test.local.template" },
    ]);
    expect(
      commands.filter(
        (command) => command.startsWith("cat ") && command.includes(".env"),
      ),
    ).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("retries transient Daytona clone failures before reading repo security input", async () => {
    const workspace = new FakeRepositoryLoadingWorkspace({
      cloneResults: [
        {
          exitCode: 128,
          stderr:
            "fatal: unable to access 'https://github.com/example/app/': Could not resolve host: github.com",
          stdout: "",
        },
        { exitCode: 0, stderr: "", stdout: "" },
      ],
    });

    const result = await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(workspace),
      "https://github.com/example/app",
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(workspace.cloneAttempts).toBe(2);
  });

  it("does not retry deterministic git clone failures", async () => {
    const lines: string[] = [];
    const workspace = new FakeRepositoryLoadingWorkspace({
      cloneResults: [
        {
          exitCode: 128,
          stderr:
            "remote: Repository not found.\nfatal: repository 'https://github.com/example/missing/' not found",
          stdout: "",
        },
      ],
    });

    await expect(
      readRepoSecurityInput(
        new FakeRepositoryLoadingWorkspaceProvider(workspace),
        "https://github.com/example/missing",
        {
          logger: createPipelineEventLogger({
            base: { component: "repo-security-screen" },
            sinks: [{ write: (line) => void lines.push(line) }],
          }),
        },
      ),
    ).rejects.toThrow("Repository not found");
    expect(workspace.cloneAttempts).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "repo-security-screen.clone.failed",
        level: "error",
      }),
    );
  });

  it("logs thrown Daytona clone timeouts and retries in a fresh workspace", async () => {
    const lines: string[] = [];
    const firstWorkspace = new FakeRepositoryLoadingWorkspace({
      cloneError: new Error("Daytona command did not finish within 600000ms"),
    });
    const secondWorkspace = new FakeRepositoryLoadingWorkspace();
    const provider = new FakeRepositoryLoadingWorkspaceProvider([
      firstWorkspace,
      secondWorkspace,
    ]);
    const logger = createPipelineEventLogger({
      base: { component: "repo-security-screen" },
      sinks: [{ write: (line) => void lines.push(line) }],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    const result = await readRepoSecurityInput(
      provider,
      "https://github.com/example/app",
      { logger },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(provider.releasedWorkspaceIds).toEqual(["workspace-1"]);
    expect(firstWorkspace.cloneAttempts).toBe(1);
    expect(secondWorkspace.cloneAttempts).toBe(1);
    expect(firstWorkspace.cloneTimeoutsMs).toEqual([120_000]);
    expect(secondWorkspace.cloneTimeoutsMs).toEqual([120_000]);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        durationMs: expect.any(Number),
        errorMessage: "Daytona command did not finish within 600000ms",
        errorType: "Error",
        event: "repo-security-screen.clone.failed",
        level: "warn",
        repoUrl: "https://github.com/example/app",
      }),
    );
  });

  it("retries thrown clone ETIMEDOUT errors in a fresh workspace", async () => {
    const firstWorkspace = new FakeRepositoryLoadingWorkspace({
      cloneError: new Error(
        "connect ETIMEDOUT 140.82.112.4:443 while cloning repository",
      ),
    });
    const secondWorkspace = new FakeRepositoryLoadingWorkspace();
    const provider = new FakeRepositoryLoadingWorkspaceProvider([
      firstWorkspace,
      secondWorkspace,
    ]);

    const result = await readRepoSecurityInput(
      provider,
      "https://github.com/example/app",
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(provider.releasedWorkspaceIds).toEqual(["workspace-1"]);
    expect(firstWorkspace.cloneAttempts).toBe(1);
    expect(secondWorkspace.cloneAttempts).toBe(1);
    expect(firstWorkspace.cloneTimeoutsMs).toEqual([120_000]);
    expect(secondWorkspace.cloneTimeoutsMs).toEqual([120_000]);
  });

  it("retries a Daytona socket connection failure in a fresh workspace", async () => {
    const firstCloneError = new Error(
      "The socket connection was closed unexpectedly",
    );
    firstCloneError.name = "DaytonaConnectionError";
    const firstWorkspace = new FakeRepositoryLoadingWorkspace({
      cloneError: firstCloneError,
    });
    const secondWorkspace = new FakeRepositoryLoadingWorkspace();
    const provider = new FakeRepositoryLoadingWorkspaceProvider([
      firstWorkspace,
      secondWorkspace,
    ]);

    const result = await readRepoSecurityInput(
      provider,
      "https://github.com/example/app",
      { cloneWorkspaceRetryDelaysMs: [] },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(provider.releasedWorkspaceIds).toEqual(["workspace-1"]);
    expect(firstWorkspace.cloneAttempts).toBe(1);
    expect(secondWorkspace.cloneAttempts).toBe(1);
    expect(firstWorkspace.cloneTimeoutsMs).toEqual([120_000]);
    expect(secondWorkspace.cloneTimeoutsMs).toEqual([120_000]);
  });

  it("logs Daytona clone progress through Pino JSON", async () => {
    const lines: string[] = [];
    const commands: string[] = [];
    const logger = createPipelineEventLogger({
      base: { component: "repo-security-screen" },
      sinks: [{ write: (line) => void lines.push(line) }],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    const result = await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(commands),
      "https://github.com/example/app",
      { logger },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(commands[0]).toContain("sudo mkdir -p '/workspace'");
    expect(commands[0]).toContain("sudo chown -R");
    expect(commands[0]).toContain(
      "git clone --depth 1 --no-checkout 'https://github.com/example/app' '/workspace'",
    );
    expect(commands[0]).toContain("/etc/ssl/certs/ca-certificates.crt");
    expect(commands[0]).toContain("/etc/pki/tls/certs/ca-bundle.crt");
    expect(commands[0]).toContain("/etc/daytona/netleash/ca.crt");
    expect(commands[0]).toContain("/etc/openshell-tls/ca-bundle.pem");
    const cloneCommand = commands[0];
    if (cloneCommand === undefined) {
      throw new Error("Expected a Daytona clone command");
    }
    expect(cloneCommand.indexOf("/etc/daytona/netleash/ca.crt")).toBeLessThan(
      cloneCommand.indexOf("/etc/ssl/certs/ca-certificates.crt"),
    );
    expect(commands[0]).toMatch(/export GIT_SSL_CAINFO=.*git clone/s);
    expect(commands[0]).not.toContain("GIT_SSL_NO_VERIFY");
    expect(commands[0]).not.toContain("sslVerify=false");
    expect(
      lines
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.externalCall === "daytona.git_clone"),
    ).toEqual([
      {
        component: "repo-security-screen",
        event: "repo-security-screen.clone.started",
        externalCall: "daytona.git_clone",
        level: "info",
        message: "Daytona clone started.",
        repoUrl: "https://github.com/example/app",
        service: "makeademo",
        stage: "repo-security-screen",
        time: "2026-06-17T00:00:00.000Z",
      },
      {
        component: "repo-security-screen",
        event: "repo-security-screen.clone.succeeded",
        externalCall: "daytona.git_clone",
        level: "info",
        message: "Daytona clone succeeded.",
        repoUrl: "https://github.com/example/app",
        service: "makeademo",
        stage: "repo-security-screen",
        time: "2026-06-17T00:00:00.000Z",
      },
    ]);
  });

  it("logs repo stats progress with file counts and duration", async () => {
    const lines: string[] = [];
    const logger = createPipelineEventLogger({
      base: { component: "repo-security-screen" },
      sinks: [{ write: (line) => void lines.push(line) }],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    const result = await readRepoSecurityInput(
      new FakeRepositoryLoadingWorkspaceProvider(),
      "https://github.com/example/app",
      { logger },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "repo-security-screen.stats.started",
          externalCall: "daytona.repo_stats",
          level: "info",
          message: "Daytona repo stats started.",
          stage: "repo-security-screen",
        }),
        expect.objectContaining({
          durationMs: expect.any(Number),
          event: "repo-security-screen.stats.succeeded",
          externalCall: "daytona.repo_stats",
          fileCount: 1,
          level: "info",
          message: "Daytona repo stats succeeded.",
          sizeBytes: 17,
          stage: "repo-security-screen",
        }),
      ]),
    );
  });

  it("cancels and releases repository-loading workspace before propagating Pipeline cancellation", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let rejectClone: ((error: Error) => void) | undefined;
    let markCloneStarted: (() => void) | undefined;
    const cloneStarted = new Promise<void>((resolve) => {
      markCloneStarted = resolve;
    });
    const workspace: RepositoryLoadingWorkspace = {
      async cancelActiveCommands() {
        events.push("clone-cancelled");
        rejectClone?.(new Error("clone cancelled"));
      },
      async execute() {
        throw new Error(
          "Repository loading must not use privileged execution.",
        );
      },
      async executeRepositoryCommand(command) {
        if (!command.includes("git clone")) {
          throw new Error(`Unexpected command: ${command}`);
        }
        events.push("clone-started");
        markCloneStarted?.();
        return await new Promise((_, reject) => {
          rejectClone = reject;
        });
      },
      async uploadFiles() {},
    };
    const provider: RepositoryLoadingWorkspaceProvider = {
      async create() {
        return {
          id: "repo-loader-1",
          async release() {
            events.push("workspace-released");
          },
          workspace,
        };
      },
    };
    const loading = new DaytonaRepoSecurityInputLoader({ provider }).load({
      commitSha: "a".repeat(40),
      repoUrl: "https://github.com/example/app",
      shouldReadText: readRepoSecurityInputTextPolicy,
      signal: controller.signal,
    });
    await cloneStarted;

    controller.abort();

    await expect(loading).rejects.toMatchObject({ reason: "signal" });
    expect(events).toEqual([
      "clone-started",
      "clone-cancelled",
      "workspace-released",
    ]);
  });
});

async function readRepoSecurityInput(
  provider: RepositoryLoadingWorkspaceProvider,
  repoUrl: string,
  options: Omit<DaytonaRepoSecurityInputLoaderOptions, "provider"> & {
    commitSha?: string;
  } = {},
) {
  const { commitSha, ...loaderOptions } = options;
  const loaded = await new DaytonaRepoSecurityInputLoader({
    ...loaderOptions,
    provider,
  }).load({
    commitSha: commitSha ?? "a".repeat(40),
    repoUrl,
    shouldReadText: readRepoSecurityInputTextPolicy,
  });
  return loaded.repoSecurity;
}

class FakeRepositoryLoadingWorkspaceProvider
  implements RepositoryLoadingWorkspaceProvider
{
  readonly releasedWorkspaceIds: string[] = [];

  constructor(
    private readonly input:
      | RepositoryLoadingWorkspace
      | RepositoryLoadingWorkspace[]
      | string[] = new FakeRepositoryLoadingWorkspace(),
    private readonly options: {
      release?: () => Promise<void>;
    } = {},
  ) {}

  private createCount = 0;

  async create(): Promise<RepositoryLoadingWorkspaceHandle> {
    const workspace = isWorkspaceList(this.input)
      ? readWorkspaceAt(this.input, this.createCount)
      : Array.isArray(this.input)
        ? new FakeRepositoryLoadingWorkspace({ commands: this.input })
        : this.input;
    const id = `workspace-${this.createCount + 1}`;
    this.createCount += 1;

    return {
      release: async () => {
        this.releasedWorkspaceIds.push(id);
        await this.options.release?.();
      },
      id,
      workspace,
    };
  }
}

function isWorkspaceList(
  input: RepositoryLoadingWorkspace | RepositoryLoadingWorkspace[] | string[],
): input is RepositoryLoadingWorkspace[] {
  return (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((item) => typeof item !== "string")
  );
}

function readWorkspaceAt(
  workspaces: RepositoryLoadingWorkspace[],
  index: number,
): RepositoryLoadingWorkspace {
  const workspace = workspaces[index] ?? workspaces[workspaces.length - 1];
  if (workspace === undefined) {
    throw new Error("Expected at least one workspace");
  }
  return workspace;
}

function inventoryRecords(
  files: readonly { path: string; sizeBytes: number }[],
): string {
  return files.map((file) => `${file.path}\0${file.sizeBytes}\0`).join("");
}

class FakeRepositoryLoadingWorkspace implements RepositoryLoadingWorkspace {
  private activeEvidenceReads = 0;
  cloneAttempts = 0;
  readonly cloneTimeoutsMs: number[] = [];
  maxConcurrentEvidenceReads = 0;

  constructor(
    private readonly input: {
      cloneError?: Error;
      cloneResults?: RepositoryLoadingWorkspaceCommandResult[];
      commands?: string[];
      evidenceReadDelayMs?: number;
      fileStats?: string;
      textByPath?: Record<string, string>;
    } = {},
  ) {}

  async execute(): Promise<RepositoryLoadingWorkspaceCommandResult> {
    throw new Error("Repository loading must not use privileged execution.");
  }

  async executeRepositoryCommand(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<RepositoryLoadingWorkspaceCommandResult> {
    this.input.commands?.push(command);
    if (command.includes("git clone") || command.includes("tar -xzf")) {
      if (options?.timeoutMs !== undefined) {
        this.cloneTimeoutsMs.push(options.timeoutMs);
      }
      if (this.input.cloneError !== undefined) {
        this.cloneAttempts += 1;
        throw this.input.cloneError;
      }
      const result = this.input.cloneResults?.[this.cloneAttempts] ?? {
        exitCode: 0,
        stderr: "",
        stdout: "",
      };
      this.cloneAttempts += 1;
      return result;
    }
    if (command.includes("find '/workspace' -mindepth 1")) {
      return { exitCode: 0, stderr: "", stdout: "" };
    }

    if (command.includes("-printf '%P\\0%s\\0'")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          this.input.fileStats ??
          inventoryRecords([{ path: "package.json", sizeBytes: 17 }]),
      };
    }

    if (command === "git -C /workspace ls-files -z") {
      return { exitCode: 0, stderr: "", stdout: "package.json\0" };
    }

    if (command.startsWith("head -c ")) {
      this.activeEvidenceReads += 1;
      this.maxConcurrentEvidenceReads = Math.max(
        this.maxConcurrentEvidenceReads,
        this.activeEvidenceReads,
      );
      try {
        if ((this.input.evidenceReadDelayMs ?? 0) > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.input.evidenceReadDelayMs),
          );
        }
        const path = Object.keys(this.input.textByPath ?? {})
          .sort((left, right) => right.length - left.length)
          .find((candidate) => command.includes(`/${candidate}'`));
        const limit = Number(command.match(/^head -c (\d+)/)?.[1] ?? "0");
        const text =
          path === undefined
            ? '{"name":"app"}'
            : (this.input.textByPath?.[path] ?? "");
        return {
          exitCode: 0,
          stderr: "",
          stdout: Buffer.from(text, "utf8").subarray(0, limit).toString("utf8"),
        };
      } finally {
        this.activeEvidenceReads -= 1;
      }
    }

    throw new Error(`Unexpected command: ${command}`);
  }

  async uploadFiles() {}
}
