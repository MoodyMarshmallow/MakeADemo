import { describe, expect, it } from "vitest";

import { createPipelineEventLogger } from "../../shared/logging/pipeline-event-logger";
import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../03-repo-preparation/preparation-workspace.interface";
import { readRepoSecurityInput } from "./pre-capture-repo-security";

describe("readRepoSecurityInput", () => {
  it("screens the exact requested repository commit", async () => {
    const commands: string[] = [];

    await readRepoSecurityInput(
      new FakePreparationWorkspaceProvider(commands),
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
    const workspace = new FakePreparationWorkspace({
      commands,
      fileStats:
        "package.json\t17\n.env\t31\napps/web/.env.production\t42\n.env.test.local.template\t27\n",
      textByPath: {
        ".env": `API_KEY=${sentinel}`,
        ".env.test.local.template": `API_KEY=${sentinel}`,
        "apps/web/.env.production": `API_KEY=${sentinel}`,
        "package.json": '{"name":"app"}',
      },
    });

    const result = await readRepoSecurityInput(
      new FakePreparationWorkspaceProvider(workspace),
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
    const workspace = new FakePreparationWorkspace({
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
      new FakePreparationWorkspaceProvider(workspace),
      "https://github.com/example/app",
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(workspace.cloneAttempts).toBe(2);
  });

  it("does not retry deterministic git clone failures", async () => {
    const lines: string[] = [];
    const workspace = new FakePreparationWorkspace({
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
        new FakePreparationWorkspaceProvider(workspace),
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
    const firstWorkspace = new FakePreparationWorkspace({
      cloneError: new Error("Daytona command did not finish within 600000ms"),
    });
    const secondWorkspace = new FakePreparationWorkspace();
    const provider = new FakePreparationWorkspaceProvider([
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
    expect(firstWorkspace.networkAccessChanges).toEqual([true, false]);
    expect(secondWorkspace.networkAccessChanges).toEqual([true, false]);
    expect(provider.releasedWorkspaceIds).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
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
    const firstWorkspace = new FakePreparationWorkspace({
      cloneError: new Error(
        "connect ETIMEDOUT 140.82.112.4:443 while cloning repository",
      ),
    });
    const secondWorkspace = new FakePreparationWorkspace();
    const provider = new FakePreparationWorkspaceProvider([
      firstWorkspace,
      secondWorkspace,
    ]);

    const result = await readRepoSecurityInput(
      provider,
      "https://github.com/example/app",
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(firstWorkspace.networkAccessChanges).toEqual([true, false]);
    expect(secondWorkspace.networkAccessChanges).toEqual([true, false]);
    expect(provider.releasedWorkspaceIds).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
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
    const firstWorkspace = new FakePreparationWorkspace({
      cloneError: firstCloneError,
    });
    const secondWorkspace = new FakePreparationWorkspace();
    const provider = new FakePreparationWorkspaceProvider([
      firstWorkspace,
      secondWorkspace,
    ]);

    const result = await readRepoSecurityInput(
      provider,
      "https://github.com/example/app",
      { cloneWorkspaceRetryDelaysMs: [] },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(provider.releasedWorkspaceIds).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
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
      new FakePreparationWorkspaceProvider(commands),
      "https://github.com/example/app",
      { logger },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(commands[0]).toContain("sudo mkdir -p '/workspace'");
    expect(commands[0]).toContain("sudo chown -R");
    expect(commands[0]).toContain(
      "git clone --depth 1 'https://github.com/example/app' '/workspace'",
    );
    expect(commands[0]).toContain("/etc/ssl/certs/ca-certificates.crt");
    expect(commands[0]).toContain("/etc/pki/tls/certs/ca-bundle.crt");
    expect(commands[0]).toContain("/etc/openshell-tls/ca-bundle.pem");
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
      new FakePreparationWorkspaceProvider(),
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

  it("logs and bounds workspace release timeouts after repo stats succeed", async () => {
    const lines: string[] = [];
    const logger = createPipelineEventLogger({
      base: { component: "repo-security-screen" },
      sinks: [{ write: (line) => void lines.push(line) }],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    const result = await readRepoSecurityInput(
      new FakePreparationWorkspaceProvider(new FakePreparationWorkspace(), {
        release: () => new Promise(() => undefined),
      }),
      "https://github.com/example/app",
      { releaseTimeoutMs: 1, logger },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "repo-security-screen.workspace_release.started",
          externalCall: "daytona.workspace_release",
          level: "info",
          message: "Daytona workspace release started.",
          stage: "repo-security-screen",
          workspaceId: "workspace-1",
        }),
        expect.objectContaining({
          durationMs: expect.any(Number),
          event: "repo-security-screen.workspace_release.timeout",
          externalCall: "daytona.workspace_release",
          level: "warn",
          message: "Daytona workspace release timeout.",
          stage: "repo-security-screen",
          timeoutMs: 1,
          workspaceId: "workspace-1",
        }),
      ]),
    );
  });
});

class FakePreparationWorkspaceProvider implements PreparationWorkspaceProvider {
  readonly releasedWorkspaceIds: string[] = [];

  constructor(
    private readonly input:
      | PreparationWorkspace
      | PreparationWorkspace[]
      | string[] = new FakePreparationWorkspace(),
    private readonly options: {
      release?: () => Promise<void>;
    } = {},
  ) {}

  private createCount = 0;

  async create(): Promise<PreparationWorkspaceHandle> {
    const workspace = isWorkspaceList(this.input)
      ? readWorkspaceAt(this.input, this.createCount)
      : Array.isArray(this.input)
        ? new FakePreparationWorkspace({ commands: this.input })
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
  input: PreparationWorkspace | PreparationWorkspace[] | string[],
): input is PreparationWorkspace[] {
  return (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((item) => typeof item !== "string")
  );
}

function readWorkspaceAt(
  workspaces: PreparationWorkspace[],
  index: number,
): PreparationWorkspace {
  const workspace = workspaces[index] ?? workspaces[workspaces.length - 1];
  if (workspace === undefined) {
    throw new Error("Expected at least one workspace");
  }
  return workspace;
}

class FakePreparationWorkspace implements PreparationWorkspace {
  cloneAttempts = 0;
  readonly cloneTimeoutsMs: number[] = [];
  readonly networkAccessChanges: boolean[] = [];

  constructor(
    private readonly input: {
      cloneError?: Error;
      cloneResults?: PreparationWorkspaceCommandResult[];
      commands?: string[];
      fileStats?: string;
      textByPath?: Record<string, string>;
    } = {},
  ) {}

  async execute(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<PreparationWorkspaceCommandResult> {
    this.input.commands?.push(command);
    if (command.includes("git clone")) {
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

    if (command.includes("-printf '%P\\t%s\\n'")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: this.input.fileStats ?? "package.json\t17\n",
      };
    }

    if (command.startsWith("cat ")) {
      const path = Object.keys(this.input.textByPath ?? {}).find((candidate) =>
        command.includes(`/${candidate}'`),
      );
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          path === undefined
            ? '{"name":"app"}'
            : (this.input.textByPath?.[path] ?? ""),
      };
    }

    throw new Error(`Unexpected command: ${command}`);
  }

  async getPreviewUrl(): Promise<string> {
    throw new Error("getPreviewUrl should not be called");
  }

  async setOutboundNetworkAccess(enabled: boolean): Promise<void> {
    this.networkAccessChanges.push(enabled);
  }

  async uploadFiles(): Promise<void> {
    throw new Error("uploadFiles should not be called");
  }
}
