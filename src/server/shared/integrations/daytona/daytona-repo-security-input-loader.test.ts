import { describe, expect, it } from "vitest";

import { createApplicationIdentityBaseline } from "../../../pipeline/03-repo-preparation/application-identity-evidence";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import {
  DaytonaRepoSecurityInputLoader,
  type RepositoryLoadingWorkspaceHandle,
  type RepositoryLoadingWorkspaceProvider,
} from "./daytona-repo-security-input-loader";

describe("DaytonaRepoSecurityInputLoader", () => {
  it("captures the pinned Application Identity Baseline before static scanning", async () => {
    const commands: string[] = [];
    const workspace = new FakeRepositoryLoadingWorkspace({ commands });
    const provider = new FakeRepositoryLoadingWorkspaceProvider([workspace]);

    const loaded = await new DaytonaRepoSecurityInputLoader({ provider }).load({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
    });

    expect(loaded.preparationWorkspace.workspace).toBe(workspace);
    expect(loaded.applicationIdentityBaseline).toEqual(
      createApplicationIdentityBaseline({
        pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
        repoUrl: "https://github.com/example/app",
        sourceControlledPaths: ["package.json", "src/app.ts"],
        sourceTreeObjectId: "89abcdef0123456789abcdef0123456789abcdef",
      }),
    );
    expect(
      loaded.repoSecurity.scannerReports.map((report) => report.scanner),
    ).toEqual(["osv-scanner", "guarddog", "semgrep"]);
    expect(provider.releasedWorkspaceIds).toEqual([]);
    expect(commands[0]).toContain(
      "fetch --depth=1 --no-tags --recurse-submodules=no origin '0123456789abcdef0123456789abcdef01234567'",
    );
    expect(commands.findIndex(isGitAcquisitionCommand)).toBeLessThan(
      commands.indexOf("capture-application-identity-baseline"),
    );
    expect(
      commands.indexOf("capture-application-identity-baseline"),
    ).toBeLessThan(
      commands.findIndex((command) => command.includes("osv-scanner")),
    );
    const backendCommands = commands.filter(
      (command) => !command.includes("/opt/makeademo/security-tools/"),
    );
    expect(backendCommands.join("\n")).not.toMatch(/(?:head -c|-printf '%P)/);
  });

  it("does not expose installation authority or clone private source without a bound grant", async () => {
    const commands: string[] = [];
    const provider = new FakeRepositoryLoadingWorkspaceProvider([
      new FakeRepositoryLoadingWorkspace({ commands }),
    ]);

    await expect(
      new DaytonaRepoSecurityInputLoader({ provider }).load({
        commitSha: "a".repeat(40),
        githubInstallationId: "installation-123",
        repoUrl: "https://github.com/example/private-app",
        repoVisibility: "private",
      }),
    ).rejects.toThrow("requires a server-bound GitHub installation grant");

    expect(commands).toEqual([]);
    expect(provider.releasedWorkspaceIds).toEqual(["workspace-1"]);
  });

  it("retries a transient clone failure in a fresh parent", async () => {
    const first = new FakeRepositoryLoadingWorkspace({
      cloneError: Object.assign(new Error("socket connection was closed"), {
        name: "DaytonaConnectionError",
      }),
    });
    const second = new FakeRepositoryLoadingWorkspace();
    const provider = new FakeRepositoryLoadingWorkspaceProvider([
      first,
      second,
    ]);

    const loaded = await new DaytonaRepoSecurityInputLoader({
      cloneWorkspaceRetryDelaysMs: [0],
      provider,
    }).load({
      commitSha: "b".repeat(40),
      repoUrl: "https://github.com/example/app",
    });

    expect(loaded.preparationWorkspace.id).toBe("workspace-2");
    expect(provider.releasedWorkspaceIds).toEqual(["workspace-1"]);
    expect(first.cloneAttempts).toBe(1);
    expect(second.cloneAttempts).toBe(1);
  });

  it("cancels and releases its parent before propagating Pipeline cancellation", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let rejectClone: ((error: Error) => void) | undefined;
    let markCloneStarted: (() => void) | undefined;
    const cloneStarted = new Promise<void>((resolve) => {
      markCloneStarted = resolve;
    });
    const workspace: PreparationWorkspace = {
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
        if (!isGitAcquisitionCommand(command)) {
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
    const provider = new FakeRepositoryLoadingWorkspaceProvider([workspace], {
      onRelease: () => void events.push("workspace-released"),
    });
    const loading = new DaytonaRepoSecurityInputLoader({ provider }).load({
      commitSha: "c".repeat(40),
      repoUrl: "https://github.com/example/app",
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

class FakeRepositoryLoadingWorkspaceProvider
  implements RepositoryLoadingWorkspaceProvider
{
  readonly releasedWorkspaceIds: string[] = [];
  private createCount = 0;

  constructor(
    private readonly workspaces: PreparationWorkspace[],
    private readonly options: { onRelease?: () => void } = {},
  ) {}

  async create(): Promise<RepositoryLoadingWorkspaceHandle> {
    const workspace =
      this.workspaces[this.createCount] ?? this.workspaces.at(-1);
    if (workspace === undefined) throw new Error("Expected a fake workspace.");
    const id = `workspace-${this.createCount + 1}`;
    this.createCount += 1;
    return {
      id,
      release: async () => {
        this.releasedWorkspaceIds.push(id);
        this.options.onRelease?.();
      },
      workspace,
    };
  }
}

class FakeRepositoryLoadingWorkspace implements PreparationWorkspace {
  cloneAttempts = 0;

  constructor(
    private readonly input: {
      cloneError?: Error;
      commands?: string[];
    } = {},
  ) {}

  async execute(): Promise<PreparationWorkspaceCommandResult> {
    throw new Error("Repository loading must not use privileged execution.");
  }

  async captureApplicationIdentityBaseline() {
    this.input.commands?.push("capture-application-identity-baseline");
    return createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: ["package.json", "src/app.ts"],
      sourceTreeObjectId: "89abcdef0123456789abcdef0123456789abcdef",
    });
  }

  async executeRepositoryCommand(command: string) {
    this.input.commands?.push(command);
    if (isGitAcquisitionCommand(command) || command.includes("tar -xzf")) {
      this.cloneAttempts += 1;
      if (this.input.cloneError !== undefined) throw this.input.cloneError;
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (command.includes("find '/workspace' -mindepth 1")) {
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (command.includes("security-tools/osv-scanner")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ results: [] }),
      };
    }
    if (command.includes("security-tools/guarddog")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ package: "/workspace", sourcecode: {} }),
      };
    }
    if (command.includes("security-tools/semgrep")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ errors: [], results: [] }),
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  }

  async uploadFiles() {}
}

function isGitAcquisitionCommand(command: string): boolean {
  return command.includes("git init --quiet") && command.includes(" fetch ");
}
