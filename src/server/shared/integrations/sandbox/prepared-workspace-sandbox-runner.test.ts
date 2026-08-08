import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspaceResourceDiagnostics,
  SubmittedProjectRuntimeRequest,
  SubmittedRuntimeQuiescenceRequest,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { submittedCodeKnownGoodNodeReleaseSnapshot } from "../../../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { resolveSubmittedCodeToolchain } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";
import {
  parseSubmittedRuntimeLaunchIdentity,
  submittedRuntimeIdentityMarker,
} from "../../submitted-runtime-launch-identity";
import {
  PreparedWorkspaceSandboxRunner as RuntimePreparedWorkspaceSandboxRunner,
  createStartDemoScript,
  parseDemoProcessState,
  restartPreparedDemoForFreshCapture,
} from "./prepared-workspace-sandbox-runner";

type DaytonaSandboxRunnerOptions = NonNullable<
  ConstructorParameters<typeof RuntimePreparedWorkspaceSandboxRunner>[0]
>;

class DaytonaSandboxRunner extends RuntimePreparedWorkspaceSandboxRunner {
  constructor(options: DaytonaSandboxRunnerOptions = {}) {
    super(options);
  }
}

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

  it("retains the runtime session leader when the session launcher forks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-wrapper-"));
    const state = await mkdtemp(join(tmpdir(), "makeademo-state-"));
    const forkingSessionLauncher = join(state, "forking-session-launcher");
    const observedPidsPath = join(state, "observed-pids");
    let observedPids: number[] = [];
    try {
      await writeFile(forkingSessionLauncher, '#!/bin/sh\n"$@" &\nexit 0\n');
      await chmod(forkingSessionLauncher, 0o755);
      const command = createStartDemoScript(
        `sh -c 'printf "%s %s\\n" "$PPID" "$$" > ${observedPidsPath}; sleep 30'`,
        workspace,
        state,
        forkingSessionLauncher,
      );

      const { stdout } = await execFileAsync("sh", ["-lc", command]);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          observedPids = (await readFile(observedPidsPath, "utf8"))
            .trim()
            .split(/\s+/)
            .map(Number);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      expect(observedPids).toHaveLength(2);
      expect(Number(stdout.trim())).toBe(observedPids[0]);
    } finally {
      for (const pid of [...observedPids].reverse()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The short-lived launcher or shell may already have exited.
        }
      }
      await rm(workspace, { force: true, recursive: true });
      await rm(state, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "reports the real setsid process birth identity over the trusted descriptor",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "makeademo-wrapper-"));
      const state = await mkdtemp(join(tmpdir(), "makeademo-state-"));
      const token = "trusted-runtime-report";
      let processGroupId: number | undefined;
      try {
        const command = createStartDemoScript("sleep 30", workspace, state);
        const { stdout } = await execFileAsync(
          "sh",
          ["-lc", `{ ${command}; } 3>&1`],
          {
            env: { ...process.env, MAKEADEMO_RUNTIME_REPORT_TOKEN: token },
          },
        );
        const identity = parseSubmittedRuntimeLaunchIdentity(stdout, token);
        expect(stdout).toContain(submittedRuntimeIdentityMarker);
        expect(identity).toMatchObject({
          processGroupId: identity?.processId,
          sessionId: identity?.processId,
        });
        if (identity === undefined) {
          throw new Error("Expected a submitted runtime launch identity.");
        }
        const stat = await readFile(`/proc/${identity.processId}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        expect(identity.processStartTimeTicks).toBe(Number(fields[19]));
        processGroupId = identity.processGroupId;
      } finally {
        if (processGroupId !== undefined) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch {
            // The runtime may already have exited.
          }
        }
        await rm(workspace, { force: true, recursive: true });
        await rm(state, { force: true, recursive: true });
      }
    },
  );
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
    expect(workspace.plannedInstalls).toEqual([
      {
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
        nodeVersion: "22.23.1",
      },
    ]);
    expect(workspace.quiescenceRequests).toEqual([
      { port: 3000, timeoutMs: 10_000 },
    ]);
    expect(workspace.plannedRuntimes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("exec npm run demo"),
        nodeVersion: "22.23.1",
      }),
    ]);
    expect(workspace.submittedCommands[1]).toContain(
      "fresh-capture-baseline.tgz",
    );
    expect(workspace.submittedCommands[2]).toContain("fetch");
    expect(workspace.submittedCommands[3]).toBe(
      "if test -f /tmp/makeademo-demo.log; then tail -c 16384 /tmp/makeademo-demo.log; fi",
    );
    expect(result).toMatchObject({
      browserUrl: "https://preview.example.test:3000/",
      blockedNetworkAttempts: [],
      logs: [
        "package-lock.json\npackage.json\n",
        "planned install",
        "planned runtime",
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
    workspace.toolchainMetadata = runtimeOnlyToolchainMetadata();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "node server.js",
      preparationManifest: manifest("workspace_123", "not-required"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.submittedCommands).not.toContain("yarn install");
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fetch"),
        expect.stringContaining("fresh-capture-baseline.tgz"),
      ]),
    );
    expect(workspace.plannedRuntimes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("exec node server.js"),
      }),
    ]);
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "demo-runtime-preflight.dependency-install.skipped",
          reason: "manifest-not-required",
        }),
      ]),
    );
    expect(result.runtimeExitCode).toBe(0);
  });

  it("uses the authoritative preflight plan without rescanning repaired metadata", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.toolchainMetadata = unsupportedToolchainMetadata();

    await expect(
      new DaytonaSandboxRunner().runValidation({
        demoCommand: "npm run demo",
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).resolves.toMatchObject({ runtimeExitCode: 0 });
    expect(workspace.plannedInstalls).toHaveLength(1);
    expect(workspace.plannedRuntimes).toHaveLength(1);
    expect(workspace.commands).not.toContain(
      "makeademo-inspect-submitted-code-toolchain",
    );
  });

  it("uses one catalog plan for dependency installation and demo startup while leaving control commands raw", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.toolchainPlan = supportedPlan();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "pnpm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.plannedInstalls).toEqual([
      {
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
        nodeVersion: "22.23.1",
      },
    ]);
    expect(workspace.plannedRuntimes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("exec pnpm run demo"),
        nodeVersion: "22.23.1",
      }),
    ]);
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("find /workspace"),
        expect.stringContaining("fetch"),
        expect.stringContaining("fresh-capture-baseline.tgz"),
      ]),
    );
    expect(workspace.submittedCommands).not.toContain(
      "pnpm i --frozen-lockfile",
    );
    expect(workspace.submittedCommands).not.toEqual(
      expect.arrayContaining([expect.stringContaining("exec pnpm run demo")]),
    );
  });

  it("still starts the demo with the catalog runtime when dependencies are not required", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.toolchainPlan = supportedPlan();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "pnpm run demo",
      preparationManifest: manifest("workspace_123", "not-required"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.plannedInstalls).toEqual([]);
    expect(workspace.plannedRuntimes).toEqual([
      expect.objectContaining({ nodeVersion: "22.23.1" }),
    ]);
  });

  it("quiesces before sync and creates the Fresh Capture baseline after install but before runtime start", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.events).toEqual([
      "provisionSubmittedCodeToolchain",
      "quiesceSubmittedRuntime:3000",
      "syncSubmittedCodeWorkspace",
      expect.stringContaining("find /workspace"),
      "executeSubmittedProject",
      expect.stringContaining("fresh-capture-baseline.tgz"),
      "executeSubmittedRuntime",
      expect.stringContaining("fetch"),
      expect.stringContaining("makeademo-demo.log"),
    ]);
  });

  it("does not synchronize after submitted runtime quiescence fails", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      failRuntimeQuiescence: true,
    });

    await expect(
      new DaytonaSandboxRunner().runValidation({
        demoCommand: "npm run demo",
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrow("runtime quiescence failed");
    expect(workspace.events).toEqual([
      "provisionSubmittedCodeToolchain",
      "quiesceSubmittedRuntime:3000",
    ]);
  });

  it("writes Demo Runtime Preflight progress and demo server output to sandbox logs", async () => {
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
          event: "demo-runtime-preflight.started",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.repo-files.started",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.repo-files.succeeded",
          repoFileCount: 2,
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.dependency-install.started",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.dependency-install.succeeded",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.demo-readiness.started",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.demo-readiness.succeeded",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.fresh-capture-baseline.started",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.fresh-capture-baseline.created",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.browser-preview.started",
          port: 3000,
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.browser-preview.created",
          stage: "demo-runtime-preflight",
        }),
        expect.objectContaining({
          event: "demo-runtime-preflight.demo-server-log",
          log: "demo server failed",
          stage: "demo-runtime-preflight",
        }),
      ]),
    );
  });

  it("continues Demo Runtime Preflight when sandbox progress logging fails", async () => {
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

  it("continues Demo Runtime Preflight when sandbox progress logging never settles", async () => {
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

  it("does not wait on a hanging fallback logger after Demo Runtime Preflight sandbox log writes fail", async () => {
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
    ).rejects.toThrow(
      "Prepared workspace validation requires the prepared workspace",
    );
  });

  it("requires the authoritative preflight plan before submitted-code execution", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    (
      workspace as unknown as {
        toolchainPlan: ReturnType<typeof supportedPlan> | undefined;
      }
    ).toolchainPlan = undefined;
    const runner = new DaytonaSandboxRunner();

    await expect(
      runner.runValidation({
        demoCommand: "npm run demo",
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrow("requires an authoritative toolchain plan");
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
    expect(workspace.plannedInstalls).toHaveLength(1);
    expect(workspace.released).toBe(false);
  });

  it("retains exit 137 as an inconclusive dependency-install SIGKILL with safe resource evidence", async () => {
    const workspace = new FakePreparationWorkspaceHandle(
      new Map([["npm ci", 137]]),
      undefined,
      {
        installResourceDiagnostics: {
          classification: "cgroup-oom-kill",
          memoryOomKillDelta: 1,
          memoryPeakBytes: 4_294_967_296,
        },
      },
    );

    const result = await new DaytonaSandboxRunner().runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result).toMatchObject({
      failureKind: "dependency-install-sigkill",
      resourceDiagnostics: {
        classification: "cgroup-oom-kill",
        memoryOomKillDelta: 1,
      },
      runtimeExitCode: 137,
    });
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "demo-runtime-preflight.dependency-install.failed",
          resourceDiagnostics: expect.objectContaining({
            classification: "cgroup-oom-kill",
            memoryOomKillDelta: 1,
          }),
        }),
      ]),
    );
  });

  it("keeps the workspace available when install execution throws", async () => {
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
    expect(workspace.plannedRuntimes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("exec npm run demo"),
      }),
    ]);
    expect(result.runtimeExitCode).toBe(0);
  });

  it("uses the narrow runtime-quiescence boundary before launching validation", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.quiescenceRequests).toEqual([
      { port: 3000, timeoutMs: 10_000 },
    ]);
    expect(workspace.submittedCommands.join("\n")).not.toContain(
      "/proc/[0-9]*/cmdline",
    );
    expect(workspace.plannedRuntimes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("exec npm run demo"),
      }),
    ]);
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

    expect(result).toMatchObject({
      failureKind: "demo-process-exited",
      serverLog: "demo server failed",
    });
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("makeademo-demo.exit-code"),
        expect.stringContaining("kill -0"),
      ]),
    );

    expect(result.runtimeExitCode).toBe(1);
    expect(result.logs).not.toContain("demo server failed");
  });

  it("bounds a stalled demo readiness probe by the readiness deadline", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      hangUnboundedReadiness: true,
    });
    workspace.readinessResults = [1];
    const runner = new DaytonaSandboxRunner({
      readinessPollIntervalMs: 0,
      readinessTimeoutMs: 10,
    });

    const outcome = await Promise.race([
      runner
        .runValidation({
          demoCommand: "npm run demo",
          preparationManifest: manifest("workspace_123"),
          preparationWorkspace: workspace,
          repoUrl: "https://github.com/example/app",
          url: "http://localhost:3000",
        })
        .then(() => "settled" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).toBe("settled");
    expect(workspace.readinessTimeouts.length).toBeGreaterThan(0);
    expect(
      workspace.readinessTimeouts.every(
        (timeoutMs) =>
          timeoutMs !== undefined && timeoutMs > 0 && timeoutMs <= 10,
      ),
    ).toBe(true);
  });

  it("finishes as not ready instead of starting a probe that cannot settle within the readiness deadline", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      minimumReadinessCommandTimeoutMs: 25,
      readinessProbeDelayMs: 30,
    });
    workspace.readinessResults = [1, 1];
    const runner = new DaytonaSandboxRunner({
      readinessPollIntervalMs: 0,
      readinessTimeoutMs: 50,
    });

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result).toMatchObject({
      failureKind: "demo-process-exited",
      runtimeExitCode: 1,
    });
    expect(workspace.readinessTimeouts).toHaveLength(1);
    expect(workspace.readinessTimeouts[0]).toBeGreaterThanOrEqual(25);
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

  it("falls back to the manifest URL when the workspace has no public preview URL", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined);
    (workspace.workspace as { getPreviewUrl?: unknown }).getPreviewUrl =
      undefined;
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:4173/articles?tab=global#/feed",
    });

    expect(result.browserUrl).toBe(
      "http://localhost:4173/articles?tab=global#/feed",
    );
    expect(result.previewUrl).toBeUndefined();
    expect(workspace.previewPorts).toEqual([]);
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

  it("baselines repository application caches while preserving dependency stores", async () => {
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
    expect(baselineCommand).toContain("./*/.pnpm-store");
    expect(baselineCommand).toContain("./*/.yarn/cache");
    expect(baselineCommand).not.toContain("./*/.cache");
    expect(baselineCommand).not.toContain("./*/.bun");
    expect(baselineCommand).not.toContain("./*/.npm");
    expect(baselineCommand).not.toContain(".next/dev/cache");

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
    expect(restoreCommand).toContain("/workspace/*/.pnpm-store");
    expect(restoreCommand).toContain("/workspace/*/.yarn/cache");
    expect(restoreCommand).not.toContain("/workspace/*/.cache");
    expect(restoreCommand).not.toContain("/workspace/*/.bun");
    expect(restoreCommand).not.toContain("/workspace/*/.npm");
    expect(restoreCommand).not.toContain(".next/dev/cache");
    expect(restoreCommand).not.toContain("-exec rm -rf");
  });

  it("restores the prepared baseline before Footage Capture and returns a fresh preview URL", async () => {
    const workspace = new FakePreparationWorkspaceHandle();

    const result = await restartPreparedDemoForFreshCapture({
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      readinessPollIntervalMs: 0,
    });

    expect(workspace.quiescenceRequests).toEqual([
      { port: 3000, timeoutMs: 10_000 },
    ]);
    expect(workspace.submittedCommands[0]).toContain(
      "fresh-capture-baseline.tgz && find",
    );
    expect(workspace.plannedRuntimes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("exec npm run demo:makeademo"),
      }),
    ]);
    expect(workspace.submittedCommands[1]).toContain(
      "signal: AbortSignal.timeout",
    );
    expect(workspace.submittedCommands[1]).toContain("'http://localhost:3000'");
    expect(workspace.readinessTimeouts).toHaveLength(1);
    expect(workspace.readinessTimeouts[0]).toBeGreaterThan(0);
    expect(workspace.readinessTimeouts[0]).toBeLessThanOrEqual(30_000);
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

  it("restarts fresh Footage Capture with the retained catalog runtime", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.toolchainPlan = supportedPlan();

    await restartPreparedDemoForFreshCapture({
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      readinessPollIntervalMs: 0,
    });

    expect(workspace.plannedRuntimes).toEqual([
      {
        command: expect.stringContaining("exec npm run demo:makeademo"),
        nodeVersion: "22.23.1",
      },
    ]);
    expect(workspace.provisionedToolchains).toEqual([]);
    expect(workspace.submittedCommands).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("exec npm run demo:makeademo"),
      ]),
    );
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fresh-capture-baseline.tgz && find"),
        expect.stringContaining("fetch"),
      ]),
    );
  });

  it("requires the authoritative preflight toolchain plan for fresh Footage Capture", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    (
      workspace as unknown as {
        toolchainPlan: ReturnType<typeof supportedPlan> | undefined;
      }
    ).toolchainPlan = undefined;

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
      }),
    ).rejects.toThrow("requires an authoritative toolchain plan");
  });

  it("reuses the retained preflight plan without rescanning repaired metadata", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.toolchainMetadata = unsupportedToolchainMetadata();

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ browserUrl: expect.any(String) });
    expect(workspace.plannedRuntimes).toHaveLength(1);
    expect(workspace.commands).not.toContain(
      "makeademo-inspect-submitted-code-toolchain",
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
    expect(workspace.quiescenceRequests).toEqual([
      { port: 3000, timeoutMs: 10_000 },
    ]);
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
    expect(workspace.quiescenceRequests).toEqual([
      { port: 3000, timeoutMs: 10_000 },
    ]);
    expect(workspace.submittedCommands[0]).toContain(
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

  it("does not restore or restart Footage Capture after quiescence fails", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      failRuntimeQuiescence: true,
    });

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
      }),
    ).rejects.toThrow("runtime quiescence failed");
    expect(workspace.submittedCommands).toEqual([]);
    expect(workspace.plannedRuntimes).toEqual([]);
  });
});

class FakePreparationWorkspaceHandle implements PreparationWorkspaceHandle {
  commands: string[] = [];
  released = false;
  id = "daytona_workspace";
  previewPorts: number[] = [];
  quiescenceRequests: SubmittedRuntimeQuiescenceRequest[] = [];
  plannedInstalls: Array<{
    argv: string[];
    executable: string;
    nodeVersion: string;
  }> = [];
  plannedRuntimes: Array<{ command: string; nodeVersion: string }> = [];
  provisionedToolchains: string[] = [];
  readinessResults: number[] = [];
  readinessTimeouts: Array<number | undefined> = [];
  sandboxLogs: Record<string, unknown>[] = [];
  submittedCommands: string[] = [];
  toolchainPlan: ReturnType<typeof supportedPlan> = supportedPlan();
  toolchainMetadata: unknown = supportedToolchainMetadata();
  events: string[] = [];
  private readonly options: {
    failRuntimeQuiescence?: boolean;
    failFreshCaptureRestore?: boolean;
    failSandboxLogWrites?: boolean;
    hangUnboundedReadiness?: boolean;
    installResourceDiagnostics?: PreparationWorkspaceResourceDiagnostics;
    minimumReadinessCommandTimeoutMs?: number;
    neverSettleSandboxLogWrites?: boolean;
    readinessProbeDelayMs?: number;
    repoFilesOutput?: string;
  };

  constructor(
    private readonly exitCodesByCommand = new Map<string, number>(),
    private readonly commandToThrow?: string,
    options: {
      failRuntimeQuiescence?: boolean;
      failFreshCaptureRestore?: boolean;
      failSandboxLogWrites?: boolean;
      hangUnboundedReadiness?: boolean;
      installResourceDiagnostics?: PreparationWorkspaceResourceDiagnostics;
      minimumReadinessCommandTimeoutMs?: number;
      neverSettleSandboxLogWrites?: boolean;
      readinessProbeDelayMs?: number;
      repoFilesOutput?: string;
    } = {},
  ) {
    this.options = options;
  }

  workspace = {
    execute: async (command: string) => {
      this.commands.push(command);
      if (command === "makeademo-inspect-submitted-code-toolchain") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(this.toolchainMetadata),
        };
      }
      return { exitCode: 0, stderr: "", stdout: `outer ${command}` };
    },
    executeSubmittedCode: async (
      command: string,
      options: { timeoutMs?: number } = {},
    ) => {
      this.submittedCommands.push(command);
      this.events.push(command);
      if (command.includes("fetch")) {
        this.readinessTimeouts.push(options.timeoutMs);
        if (
          options.timeoutMs !== undefined &&
          options.timeoutMs <
            (this.options.minimumReadinessCommandTimeoutMs ?? 0)
        ) {
          throw new Error(
            `Daytona command did not finish within ${options.timeoutMs}ms.`,
          );
        }
        if ((this.options.readinessProbeDelayMs ?? 0) > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.readinessProbeDelayMs),
          );
        }
        if (
          this.options.hangUnboundedReadiness === true &&
          options.timeoutMs === undefined
        ) {
          return await new Promise<never>(() => undefined);
        }
      }
      return this.runCommand(command);
    },
    executeSubmittedProject: async (request: {
      argv: readonly string[];
      executable: string;
      plan: ReturnType<typeof supportedPlan>;
    }) => {
      this.events.push("executeSubmittedProject");
      this.plannedInstalls.push({
        argv: [...request.argv],
        executable: request.executable,
        nodeVersion: request.plan.node.version,
      });
      if (this.commandToThrow === "npm ci") {
        throw new Error("npm ci exploded");
      }
      const exitCode = this.exitCodesByCommand.get("npm ci") ?? 0;
      if (exitCode !== 0) {
        return {
          exitCode,
          ...(this.options.installResourceDiagnostics === undefined
            ? {}
            : {
                resourceDiagnostics: this.options.installResourceDiagnostics,
              }),
          stderr: "",
          stdout: "planned install",
        };
      }
      return { exitCode: 0, stderr: "", stdout: "planned install" };
    },
    provisionSubmittedCodeToolchain: async (
      plan: ReturnType<typeof supportedPlan>,
    ) => {
      this.provisionedToolchains.push(
        `${plan.packageManager?.name}@${plan.packageManager?.version}`,
      );
      this.events.push("provisionSubmittedCodeToolchain");
    },
    executeSubmittedRuntime: async (
      request: SubmittedProjectRuntimeRequest,
    ) => {
      this.events.push("executeSubmittedRuntime");
      this.plannedRuntimes.push({
        command: request.command,
        nodeVersion: request.plan.node.version,
      });
      return { exitCode: 0, stderr: "", stdout: "planned runtime" };
    },
    getPreviewUrl: async (port: number) => {
      this.previewPorts.push(port);
      return `https://preview.example.test:${port}`;
    },
    quiesceSubmittedRuntime: async (
      request: SubmittedRuntimeQuiescenceRequest,
    ) => {
      this.quiescenceRequests.push(request);
      this.events.push(`quiesceSubmittedRuntime:${request.port}`);
      if (this.options.failRuntimeQuiescence === true) {
        throw new Error("runtime quiescence failed");
      }
    },
    syncSubmittedCodeWorkspace: async () => {
      this.events.push("syncSubmittedCodeWorkspace");
    },
    uploadFiles: async () => {
      throw new Error(
        "Demo Runtime Preflight should use the retained workspace.",
      );
    },
    writeSandboxLog: async (entry: Record<string, unknown>) => {
      if (
        this.options.neverSettleSandboxLogWrites === true &&
        typeof entry.event === "string" &&
        entry.event.startsWith("demo-runtime-preflight.")
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

function supportedPlan() {
  return resolveSubmittedCodeToolchain(
    supportedToolchainMetadata(),
    submittedCodeKnownGoodNodeReleaseSnapshot,
  );
}

function supportedToolchainMetadata() {
  return {
    candidates: [
      {
        files: {
          "package.json": JSON.stringify({
            engines: { node: "22" },
            packageManager: "pnpm@11.13.0",
          }),
          "pnpm-lock.yaml": "",
        },
        projectRoot: ".",
      },
    ],
  };
}

function runtimeOnlyToolchainMetadata() {
  return {
    candidates: [
      {
        files: {
          "package.json": JSON.stringify({ engines: { node: "22" } }),
        },
        projectRoot: ".",
      },
    ],
  };
}

function unsupportedToolchainMetadata() {
  return {
    candidates: [
      {
        files: {
          "package.json": JSON.stringify({
            engines: { node: "16" },
            packageManager: "pnpm@11.13.0",
          }),
          "pnpm-lock.yaml": "",
        },
        projectRoot: ".",
      },
    ],
  };
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
    mockingPlan: {
      boundaries: [],
      fixturePaths: [],
      loadedPlaybooks: [],
      nativeUiRoots: ["src/App.tsx"],
      plannedPresentationChanges: [],
    },
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
