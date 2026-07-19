import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";
import {
  DaytonaSandboxRunner,
  createStartDemoScript,
  parseDemoProcessState,
  restartPreparedDemoForFreshCapture,
} from "./daytona-sandbox-runner";

const execFileAsync = promisify(execFile);

describe("DaytonaSandboxRunner", () => {
  it("parses authoritative exit markers before process liveness", () => {
    expect(parseDemoProcessState("running")).toEqual({ running: true });
    expect(parseDemoProcessState("exited:0")).toEqual({
      exitCode: 0,
      running: false,
    });
    expect(parseDemoProcessState("exited:137")).toEqual({
      exitCode: 137,
      running: false,
    });
  });

  it("runs the exact start wrapper with quoted commands and authoritative exit markers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-wrapper-"));
    const state = await mkdtemp(join(tmpdir(), "makeademo-state-"));
    try {
      await writeFile(join(state, "makeademo-demo.exit-code"), "137\n");
      const command = createStartDemoScript(
        "sh -c 'exit 1'",
        workspace,
        state,
        "",
      );
      await execFileAsync("sh", ["-lc", command]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(
        await readFile(join(state, "makeademo-demo.exit-code"), "utf8"),
      ).toBe("1\n");
      expect(createStartDemoScript("true")).toContain("nohup setsid");
      expect(command).toContain("rm -f");
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(state, { force: true, recursive: true });
    }
  });
  it("validates the retained prepared Daytona workspace", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.commands).toEqual([]);
    expect(workspace.submittedCommands[0]).toContain("find /workspace");
    expect(workspace.submittedCommands[1]).toBe("npm ci");
    expect(workspace.submittedCommands[2]).toContain("/tmp/makeademo-demo.pid");
    expect(workspace.submittedCommands[2]).toContain("/proc/[0-9]*/cmdline");
    expect(workspace.submittedCommands[2]).toContain("npm run demo");
    expect(workspace.submittedCommands[3]).toContain("exec npm run demo");
    expect(workspace.submittedCommands[4]).toContain("fetch");
    expect(workspace.submittedCommands[5]).toContain(
      "fresh-capture-baseline.tgz",
    );
    expect(workspace.submittedCommands[6]).toBe(
      "if test -f /tmp/makeademo-demo.log; then cat /tmp/makeademo-demo.log; fi",
    );
    expect(workspace.submittedNetworkAccess).toEqual([true, false]);
    expect(result).toMatchObject({
      browserUrl: "https://preview.example.test:3000/",
      blockedNetworkAttempts: [],
      logs: [
        "package-lock.json\npackage.json\n",
        "ran npm ci",
        expect.stringContaining("exec npm run demo"),
      ],
      repoFiles: ["package-lock.json", "package.json"],
      runtimeExitCode: 0,
    });

    await result.cleanup?.();

    expect(workspace.released).toBe(false);
  });

  it("skips inferred dependency installation when the manifest says it is not required", async () => {
    const workspace = new FakePreparationWorkspaceHandle(
      new Map([["yarn install", 137]]),
      undefined,
      { repoFilesOutput: "package.json\nyarn.lock\n" },
    );
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "node server.js",
      preparationManifest: manifest("workspace_123", "not-required"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.submittedCommands).not.toContain("yarn install");
    expect(workspace.submittedNetworkAccess).toEqual([]);
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exec node server.js"),
        expect.stringContaining("fetch"),
        expect.stringContaining("fresh-capture-baseline.tgz"),
      ]),
    );
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "project-validation.dependency-install.skipped",
          reason: "manifest-not-required",
        }),
      ]),
    );
    expect(result.runtimeExitCode).toBe(0);
  });

  it("syncs prepared parent workspace changes before submitted-code validation", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.events.slice(0, 2)).toEqual([
      "syncSubmittedCodeWorkspace",
      expect.stringContaining("find /workspace"),
    ]);
  });

  it("writes Project Validation progress and demo server output to sandbox logs", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "project-validation.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.repo-files.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.repo-files.succeeded",
          repoFileCount: 2,
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.dependency-install.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.dependency-install.succeeded",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.demo-readiness.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.demo-readiness.succeeded",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.fresh-capture-baseline.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.fresh-capture-baseline.created",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.browser-preview.started",
          port: 3000,
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.browser-preview.created",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.demo-server-log",
          log: "demo server failed",
          stage: "project-validation",
        }),
      ]),
    );
  });

  it("continues Project Validation when sandbox progress logging fails", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      failSandboxLogWrites: true,
    });
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result.runtimeExitCode).toBe(0);
    expect(result.browserUrl).toBe("https://preview.example.test:3000/");
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([expect.stringContaining("find /workspace")]),
    );
  });

  it("continues Project Validation when sandbox progress logging never settles", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      neverSettleSandboxLogWrites: true,
    });
    const runner = new DaytonaSandboxRunner();

    const result = await Promise.race([
      runner
        .runValidation({
          demoCommand: "npm run demo",
          preparationManifest: manifest("workspace_123"),
          preparationWorkspace: workspace,
          repoUrl: "https://github.com/example/app",
          url: "http://localhost:3000",
        })
        .then((validation) => validation.runtimeExitCode),
      delay(100).then(() => "timed-out"),
    ]);

    expect(result).toBe(0);
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([expect.stringContaining("find /workspace")]),
    );
  });

  it("does not wait on a hanging fallback logger after Project Validation sandbox log writes fail", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      failSandboxLogWrites: true,
    });
    const runner = new DaytonaSandboxRunner({
      logger: neverSettlingWarnLogger(),
    });

    const result = await Promise.race([
      runner
        .runValidation({
          demoCommand: "npm run demo",
          preparationManifest: manifest("workspace_123"),
          preparationWorkspace: workspace,
          repoUrl: "https://github.com/example/app",
          url: "http://localhost:3000",
        })
        .then((validation) => validation.runtimeExitCode),
      delay(100).then(() => "timed-out"),
    ]);

    expect(result).toBe(0);
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([expect.stringContaining("find /workspace")]),
    );
  });

  it("requires the retained Repo Preparation workspace", async () => {
    const runner = new DaytonaSandboxRunner();

    await expect(
      runner.runValidation({
        demoCommand: "npm run demo",
        preparationManifest: manifest("workspace_123"),
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrow("Daytona validation requires the prepared workspace");
  });

  it("destroys the Daytona workspace when dependency installation fails", async () => {
    const workspace = new FakePreparationWorkspaceHandle(
      new Map([["npm ci", 1]]),
    );
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result.runtimeExitCode).toBe(1);
    expect(workspace.submittedCommands[0]).toContain("find /workspace");
    expect(workspace.submittedCommands[1]).toBe("npm ci");
    expect(workspace.released).toBe(false);
  });

  it("closes outbound network and destroys the workspace when install execution throws", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), "npm ci");
    const runner = new DaytonaSandboxRunner();

    await expect(
      runner.runValidation({
        demoCommand: "npm run demo",
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrow("npm ci exploded");

    expect(workspace.submittedNetworkAccess).toEqual([true, false]);
    expect(workspace.released).toBe(false);
  });

  it("starts long-running demo commands without waiting for the server to exit", async () => {
    const workspace = new FakePreparationWorkspaceHandle(
      new Map([["npm run demo", 124]]),
    );
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.submittedCommands).not.toContain("npm run demo");
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([expect.stringContaining("exec npm run demo")]),
    );
    expect(result.runtimeExitCode).toBe(0);
  });

  it("stops the previous MakeADemo demo process before launching validation", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    const stopCommand = workspace.submittedCommands.find((command) =>
      command.includes("/tmp/makeademo-demo.pid"),
    );
    expect(stopCommand).toBeDefined();
    expect(stopCommand).toContain("/proc/[0-9]*/cmdline");
    expect(stopCommand).toContain("npm run demo");
    expect(stopCommand).toContain("apps/makeademo-demo/server.ts");
    expect(
      workspace.submittedCommands.indexOf(stopCommand as string),
    ).toBeLessThan(
      workspace.submittedCommands.findIndex((command) =>
        command.includes("exec npm run demo"),
      ),
    );
  });

  it("waits for the prepared demo URL before browser validation can run", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.readinessResults = [1, 0];
    const runner = new DaytonaSandboxRunner({ readinessPollIntervalMs: 0 });

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(
      workspace.submittedCommands.filter((command) =>
        command.includes("fetch"),
      ),
    ).toHaveLength(2);
    expect(result.runtimeExitCode).toBe(0);
  });

  it("returns demo logs when the prepared demo URL never becomes ready", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.readinessResults = [1, 1, 1];
    const runner = new DaytonaSandboxRunner({
      readinessPollIntervalMs: 0,
      readinessTimeoutMs: 3,
    });

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result.runtimeExitCode).toBe(1);
    expect(result.logs).toContain("demo server failed");
  });

  it("returns a Daytona preview URL for the submitted-code browser URL", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:4173",
    });

    expect(workspace.previewPorts).toEqual([4173]);
    expect(result.browserUrl).toBe("https://preview.example.test:4173/");
  });

  it("preserves the manifest URL path, query, and hash on submitted-code browser URLs", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:4173/articles?tab=global#/feed",
    });

    expect(result.browserUrl).toBe(
      "https://preview.example.test:4173/articles?tab=global#/feed",
    );
  });

  it("excludes nested dependency caches from the fresh baseline and preserves them during restore", async () => {
    const validationWorkspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: validationWorkspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    const baselineCommand = validationWorkspace.submittedCommands.find(
      (command) => command.includes("fresh-capture-baseline.tgz"),
    );
    expect(baselineCommand).toContain("./*/node_modules");
    expect(baselineCommand).toContain("./*/node_modules/*");
    expect(baselineCommand).toContain("./*/.vite");

    const restoreWorkspace = new FakePreparationWorkspaceHandle();
    await restartPreparedDemoForFreshCapture({
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: restoreWorkspace,
      readinessPollIntervalMs: 0,
    });

    const restoreCommand = restoreWorkspace.submittedCommands.find((command) =>
      command.includes("fresh-capture-baseline.tgz && find"),
    );
    expect(restoreCommand).toContain("/workspace/*/node_modules");
    expect(restoreCommand).toContain("/workspace/*/node_modules/*");
    expect(restoreCommand).toContain("/workspace/*/.vite");
    expect(restoreCommand).not.toContain("-exec rm -rf");
  });

  it("restores the prepared baseline before Footage Capture and returns a fresh preview URL", async () => {
    const workspace = new FakePreparationWorkspaceHandle();

    const result = await restartPreparedDemoForFreshCapture({
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      readinessPollIntervalMs: 0,
    });

    expect(workspace.submittedCommands[0]).toContain("/tmp/makeademo-demo.pid");
    expect(workspace.submittedCommands[0]).toContain("/proc/[0-9]*/cmdline");
    expect(workspace.submittedCommands[0]).toContain("npm run demo:makeademo");
    expect(workspace.submittedCommands[1]).toContain(
      "fresh-capture-baseline.tgz && find",
    );
    expect(workspace.submittedCommands[2]).toEqual(
      expect.stringContaining("exec npm run demo:makeademo"),
    );
    expect(workspace.submittedCommands[3]).toBe(
      "node -e 'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));' 'http://localhost:3000'",
    );
    expect(result.browserUrl).toBe("https://preview.example.test:3000/");
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "footage-capture.fresh-state.restart.started",
          stage: "footage-capture",
        }),
        expect.objectContaining({
          event: "footage-capture.fresh-state.restore.succeeded",
          stage: "footage-capture",
        }),
        expect.objectContaining({
          browserUrl: "https://preview.example.test:3000/",
          event: "footage-capture.fresh-state.restart.succeeded",
          stage: "footage-capture",
        }),
      ]),
    );
  });

  it("continues fresh Footage Capture restart when sandbox progress logging fails", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      failSandboxLogWrites: true,
    });

    const result = await restartPreparedDemoForFreshCapture({
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      readinessPollIntervalMs: 0,
    });

    expect(result.browserUrl).toBe("https://preview.example.test:3000/");
    expect(workspace.submittedCommands[0]).toContain("/tmp/makeademo-demo.pid");
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fresh-capture-baseline.tgz"),
      ]),
    );
  });

  it("fails the fresh capture boundary when the restarted demo never becomes ready", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.readinessResults = [1];

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
        readinessTimeoutMs: 1,
      }),
    ).rejects.toThrow("Fresh Footage Capture state did not become ready");
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "footage-capture.fresh-state.restart.failed",
          stage: "footage-capture",
        }),
      ]),
    );
  });

  it("fails the fresh capture boundary when the prepared baseline cannot be restored", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      failFreshCaptureRestore: true,
    });

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
      }),
    ).rejects.toThrow("Fresh Footage Capture baseline could not be restored");
    expect(workspace.submittedCommands[0]).toContain("/tmp/makeademo-demo.pid");
    expect(workspace.submittedCommands[0]).toContain("/proc/[0-9]*/cmdline");
    expect(workspace.submittedCommands[0]).toContain("npm run demo:makeademo");
    expect(workspace.submittedCommands[1]).toContain(
      "fresh-capture-baseline.tgz && find",
    );
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "footage-capture.fresh-state.restore.failed",
          stage: "footage-capture",
        }),
      ]),
    );
  });
});

class FakePreparationWorkspaceHandle implements PreparationWorkspaceHandle {
  commands: string[] = [];
  released = false;
  id = "daytona_workspace";
  networkAccess: boolean[] = [];
  previewPorts: number[] = [];
  readinessResults: number[] = [];
  sandboxLogs: Record<string, unknown>[] = [];
  submittedCommands: string[] = [];
  submittedNetworkAccess: boolean[] = [];
  events: string[] = [];

  constructor(
    private readonly exitCodesByCommand = new Map<string, number>(),
    private readonly commandToThrow?: string,
    private readonly options: {
      failFreshCaptureRestore?: boolean;
      failSandboxLogWrites?: boolean;
      neverSettleSandboxLogWrites?: boolean;
      repoFilesOutput?: string;
    } = {},
  ) {}

  workspace = {
    execute: async (command: string) => {
      this.commands.push(command);
      return { exitCode: 0, stderr: "", stdout: `outer ${command}` };
    },
    executeSubmittedCode: async (command: string) => {
      this.submittedCommands.push(command);
      this.events.push(command);
      return this.runCommand(command);
    },
    getPreviewUrl: async (port: number) => {
      this.previewPorts.push(port);
      return `https://preview.example.test:${port}`;
    },
    setOutboundNetworkAccess: async (enabled: boolean) => {
      this.networkAccess.push(enabled);
    },
    setSubmittedCodeNetworkAccess: async (enabled: boolean) => {
      this.submittedNetworkAccess.push(enabled);
    },
    syncSubmittedCodeWorkspace: async () => {
      this.events.push("syncSubmittedCodeWorkspace");
    },
    uploadFiles: async () => {
      throw new Error("Project Validation should use the retained workspace.");
    },
    writeSandboxLog: async (entry: Record<string, unknown>) => {
      if (
        this.options.neverSettleSandboxLogWrites === true &&
        typeof entry.event === "string" &&
        entry.event.startsWith("project-validation.")
      ) {
        return new Promise<void>(() => undefined);
      }

      if (this.options.failSandboxLogWrites === true) {
        throw new Error("sandbox log mirror failed");
      }

      this.sandboxLogs.push(entry);
    },
  };

  async release() {
    this.released = true;
  }

  private runCommand(command: string) {
    if (command === this.commandToThrow) {
      throw new Error(`${command} exploded`);
    }

    if (
      this.options.failFreshCaptureRestore === true &&
      command.includes("fresh-capture-baseline.tgz && find")
    ) {
      return { exitCode: 1, stderr: "restore failed", stdout: "" };
    }

    if (command.includes("fetch")) {
      return {
        exitCode: this.readinessResults.shift() ?? 0,
        stderr: "",
        stdout: "",
      };
    }

    if (command.includes("/tmp/makeademo-demo.log")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: command.startsWith("if test -f")
          ? "demo server failed"
          : `ran ${command}`,
      };
    }

    return {
      exitCode: this.exitCodesByCommand.get(command) ?? 0,
      stderr: "",
      stdout: command.startsWith("find /workspace")
        ? (this.options.repoFilesOutput ?? "package-lock.json\npackage.json\n")
        : `ran ${command}`,
    };
  }
}

function manifest(
  workspaceId: string,
  dependencyInstall: "inferred" | "not-required" = "inferred",
) {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    dependencyInstall,
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId,
  };
}

function neverSettlingWarnLogger(): PipelineEventLogger {
  return {
    child: () => neverSettlingWarnLogger(),
    debug: async () => {},
    error: async () => {},
    flush: async () => {},
    info: async () => {},
    warn: () => new Promise(() => undefined),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
