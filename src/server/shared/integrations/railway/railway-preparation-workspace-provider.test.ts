import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SubmittedCodeToolchainPlan } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import { makeADemoSubmittedRuntimeEnvironmentKeys } from "../../../pipeline/03-repo-preparation/submitted-runtime-environment";
import { PreparedWorkspaceSandboxRunner } from "../sandbox/prepared-workspace-sandbox-runner";
import { RailwayPreparationWorkspaceProvider } from "./railway-preparation-workspace-provider";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";

describe("RailwayPreparationWorkspaceProvider", () => {
  it("publishes the exact Pipeline-owned submitted environment keys", () => {
    expect(makeADemoSubmittedRuntimeEnvironmentKeys).toEqual([
      "CHILD_CONCURRENCY",
      "CI",
      "CMAKE_BUILD_PARALLEL_LEVEL",
      "HUSKY",
      "MAKEFLAGS",
      "NODE_ENV",
      "NO_UPDATE_NOTIFIER",
      "PLAYWRIGHT_CLI_SESSION",
      "PLAYWRIGHT_MCP_ALLOWED_ORIGINS",
      "PLAYWRIGHT_MCP_OUTPUT_DIR",
      "TURBO_CONCURRENCY",
      "YARN_NETWORK_CONCURRENCY",
      "YARN_TASK_POOL_CONCURRENCY",
    ]);
  });

  it.each([
    "CHILD_CONCURRENCY",
    "CI",
    "CMAKE_BUILD_PARALLEL_LEVEL",
    "HUSKY",
    "MAKEFLAGS",
    "NODE_ENV",
    "NO_UPDATE_NOTIFIER",
    "PLAYWRIGHT_CLI_SESSION",
    "PLAYWRIGHT_MCP_ALLOWED_ORIGINS",
    "PLAYWRIGHT_MCP_OUTPUT_DIR",
    "TURBO_CONCURRENCY",
    "YARN_NETWORK_CONCURRENCY",
    "YARN_TASK_POOL_CONCURRENCY",
    "PUBLIC_DEMO_MODE",
    "VITE_PUBLIC_DEMO_MODE",
    "NEXT_PUBLIC_DEMO_MODE",
  ])("accepts the approved submitted-code environment key %s", async (key) => {
    const events: unknown[] = [];
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();

    await handle.workspace.executeSubmittedCode?.("true", {
      env: { [key]: "approved-value" },
    });

    expect(executedCommands(events, "child").at(-1)).toContain(
      `${key}='approved-value'`,
    );
  });

  it.each([
    "PATH",
    "HOME",
    "TMPDIR",
    "COREPACK_HOME",
    "MAKEADEMO_PLAYWRIGHT_MODULE_ROOT",
    "PLAYWRIGHT_BROWSERS_PATH",
    "OPENAI_API_KEY",
    "RAILWAY_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "ARBITRARY_INHERITED_VARIABLE",
    "HOST",
    "PORT",
  ])(
    "rejects the unapproved submitted-code environment key %s",
    async (key) => {
      const events: unknown[] = [];
      const provider = new RailwayPreparationWorkspaceProvider({
        gateway: fakeGateway(events),
      });
      const handle = await provider.create();

      await expect(
        handle.workspace.executeSubmittedCode?.("true", {
          env: { [key]: "must-not-cross-the-boundary" },
        }),
      ).rejects.toThrow(
        `Railway submitted-code environment variable is not allowlisted: ${key}.`,
      );
      expect(executedCommands(events, "child")).toEqual([]);
    },
  );

  it("accepts the PreparedWorkspaceSandboxRunner dependency-install environment", async () => {
    const events: unknown[] = [];
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();
    const plan = pnpmPlan(".");

    await expect(
      new PreparedWorkspaceSandboxRunner({
        readinessPollIntervalMs: 0,
      }).runValidation({
        demoCommand: "pnpm run demo",
        preparationManifest: {
          assumptions: [],
          createdFiles: [],
          demoCommand: "pnpm run demo",
          dependencyInstall: "inferred",
          diffArtifactId: "artifact-diff",
          existingDemoEvidence: [],
          mockedServices: [],
          modifiedFiles: [],
          repoUrl: "https://github.com/example/app",
          risks: [],
          scriptGenerationContext: [],
          setupSummary: "Prepared demo runtime.",
          status: "created-new-demo",
          url: "http://127.0.0.1:3000",
          workspaceId: handle.id,
        },
        preparationWorkspace: { ...handle, toolchainPlan: plan },
        repoUrl: "https://github.com/example/app",
        url: "http://127.0.0.1:3000",
      }),
    ).resolves.toMatchObject({ runtimeExitCode: 0 });

    const install = executedCommands(events, "child").find((command) =>
      command.includes("CHILD_CONCURRENCY='2'"),
    );
    expect(install).toContain("CHILD_CONCURRENCY='2'");
    expect(install).toContain("CMAKE_BUILD_PARALLEL_LEVEL='2'");
    expect(install).toContain("HUSKY='0'");
    expect(install).toContain("MAKEFLAGS='-j2'");
    expect(install).toContain("TURBO_CONCURRENCY='2'");
  });

  it("routes trusted metadata inspection through pinned Node without exposing that runtime on agent or repository PATH", async () => {
    const events: unknown[] = [];
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();

    await handle.workspace.execute(
      "makeademo-inspect-submitted-code-toolchain",
    );
    await handle.workspace.executeAgentCommand?.("command -v node");
    await handle.workspace.executeRepositoryCommand?.("git status --short");

    const executions = executedCalls(events, "parent");
    expect(executions[0]).toEqual(
      expect.objectContaining({
        command: "makeademo-inspect-submitted-code-toolchain",
        options: expect.objectContaining({
          env: {
            PATH: "/opt/makeademo/toolchains/node/versions/22.23.1/bin:/usr/local/bin:/usr/bin:/bin",
          },
        }),
      }),
    );
    expect(executions[1]?.command).toContain(
      "runuser -u 'makeademo' -- env -i",
    );
    expect(executions[1]?.command).toContain("HOME='/home/makeademo'");
    expect(executions[1]?.command).toContain("TMPDIR='/tmp/makeademo'");
    expect(executions[1]?.command).toContain(
      "PATH='/opt/makeademo/capture-runtime/bin:/usr/local/bin:/usr/bin:/bin'",
    );
    expect(executions[1]?.command).toContain(
      Buffer.from("command -v node", "utf8").toString("base64"),
    );
    expect(executions[2]?.command).toContain(
      "PATH='/opt/makeademo/capture-runtime/bin:/usr/local/bin:/usr/bin:/bin'",
    );
    expect(executions[2]?.command).toContain(
      Buffer.from("git status --short", "utf8").toString("base64"),
    );
    expect(
      executions
        .slice(1)
        .map(({ command }) => command)
        .join("\n"),
    ).not.toContain("/opt/makeademo/toolchains/node/versions/22.23.1/bin");
  });

  it("hands the prepared workspace to the unprivileged agent and writes durable sandbox logs", async () => {
    const events: unknown[] = [];
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();

    await handle.workspace.prepareForAgent?.();
    await handle.workspace.writeSandboxLog?.({
      event: "repo-preparation.started",
      level: "info",
      workspaceId: "workspace-1",
    });

    const commands = executedCommands(events, "parent");
    expect(commands).toContainEqual(
      expect.stringContaining(
        "find '/workspace' -xdev -exec chown --no-dereference 'makeademo:makeademo' {} +",
      ),
    );
    expect(commands).toContainEqual(expect.stringContaining("/opt/makeademo"));
    expect(commands).toContainEqual(
      expect.stringContaining("/workspace/.makeademo/sandbox-audit.jsonl"),
    );
    expect(commands.join("\n")).toContain("repo-preparation.started");
  });

  it("creates nested upload destinations and runs a synchronized nested pnpm project only through its plan", async () => {
    const events: unknown[] = [];
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();
    const plan = pnpmPlan("apps/demo");
    const directory = await mkdtemp(
      join(tmpdir(), "makeademo-railway-upload-"),
    );
    const sourcePath = join(directory, "fixture.txt");
    await writeFile(sourcePath, "fixture");

    try {
      await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
      await handle.workspace.uploadFiles([
        {
          destinationPath: "/workspace/.makeademo/nested/fixture.txt",
          sourcePath,
        },
      ]);
      await handle.workspace.syncSubmittedCodeWorkspace?.();
      await handle.workspace.executeSubmittedProject?.(
        {
          argv: [
            "install",
            "--frozen-lockfile",
            "--child-concurrency=2",
            "--network-concurrency=4",
          ],
          executable: "pnpm",
          installProfile: "bounded",
          plan,
        },
        { env: { VITE_PUBLIC_DEMO_MODE: "1" } },
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }

    const parentCommands = executedCommands(events, "parent");
    const childCommands = executedCommands(events, "child");
    expect(parentCommands).toContainEqual(
      expect.stringContaining("mkdir -p '/workspace/.makeademo/nested'"),
    );
    expect(childCommands).toContainEqual(expect.stringContaining("sha256sum"));
    expect(childCommands).toContainEqual(
      expect.stringContaining("cd '/workspace/apps/demo'"),
    );
    expect(childCommands.join("\n")).toContain(
      Buffer.from(
        "cd '/workspace/apps/demo' && 'pnpm' 'install' '--frozen-lockfile' '--child-concurrency=2' '--network-concurrency=4'",
        "utf8",
      ).toString("base64"),
    );
    expect(childCommands.join("\n")).toContain("VITE_PUBLIC_DEMO_MODE");
    expect(childCommands.join("\n")).not.toContain("DAYTONA_API_KEY");
    expect(childCommands.join("\n")).not.toContain(
      "/opt/makeademo/toolchains/node/versions/22.23.1/bin",
    );
  });

  it("rejects a changed lockfile after synchronization before it runs a submitted install", async () => {
    const events: unknown[] = [];
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway(events, { integrityExitCode: 1 }),
    });
    const handle = await provider.create();
    const plan = pnpmPlan(".");

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow("lockfile integrity did not match");
    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
        plan,
      }),
    ).rejects.toThrow("requires synchronization");
  });

  it("rebinds repaired lockfile authority without rehydrating a compatible runtime and rejects an incompatible runtime", async () => {
    const events: unknown[] = [];
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();
    const initial = pnpmPlan(".");
    const repaired = pnpmPlan(".", "b");

    await handle.workspace.provisionSubmittedCodeToolchain?.(initial);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    const hydrationCount = executedCommands(events, "child").filter((command) =>
      command.includes("distribution="),
    ).length;

    await handle.workspace.provisionSubmittedCodeToolchain?.(repaired);
    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: repaired.install?.argv ?? [],
        executable: repaired.install?.executable ?? "pnpm",
        plan: repaired,
      }),
    ).rejects.toThrow("requires synchronization");
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    expect(
      executedCommands(events, "child").filter((command) =>
        command.includes("distribution="),
      ),
    ).toHaveLength(hydrationCount);
    expect(executedCommands(events, "child")).toContainEqual(
      expect.stringContaining("b".repeat(64)),
    );

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.({
        ...repaired,
        node: { family: 22, lifecycle: "supported", version: "22.23.1" },
      }),
    ).rejects.toThrow("different exact runtime");
  });

  it("keeps an installed dependency tree when repaired source is synchronized before runtime", async () => {
    const state = {
      childHasInstalledSentinel: false,
      childHasRepairedSource: false,
      parentHasRepairedSource: false,
    };
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: dependencyPersistenceGateway(state),
    });
    const handle = await provider.create();
    const plan = pnpmPlan(".");
    const directory = await mkdtemp(
      join(tmpdir(), "makeademo-railway-repair-"),
    );
    const repairedSource = join(directory, "repaired-source.ts");
    await writeFile(repairedSource, "export const repaired = true;\n");

    try {
      await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
      await handle.workspace.syncSubmittedCodeWorkspace?.();
      const install = await handle.workspace.executeSubmittedProject?.({
        argv: plan.install?.argv ?? [],
        executable: plan.install?.executable ?? "pnpm",
        plan,
      });
      expect(install?.exitCode).toBe(0);

      await handle.workspace.uploadFiles([
        {
          destinationPath: "/workspace/repaired-source.ts",
          sourcePath: repairedSource,
        },
      ]);
      await handle.workspace.syncSubmittedCodeWorkspace?.();

      const runtime = await handle.workspace.executeSubmittedRuntime?.({
        command:
          "test -f node_modules/.makeademo-installed && test -f repaired-source.ts",
        plan,
      });
      expect(runtime?.exitCode).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      generation: "npm-modern" as const,
      install: ["ci", "--maxsockets=4"],
      lockfile: "package-lock.json",
      name: "npm" as const,
      version: "11.6.2",
    },
    {
      generation: "pnpm-modern" as const,
      install: [
        "install",
        "--frozen-lockfile",
        "--child-concurrency=2",
        "--network-concurrency=4",
      ],
      lockfile: "pnpm-lock.yaml",
      name: "pnpm" as const,
      version: "11.17.0",
    },
    {
      generation: "yarn-classic" as const,
      install: ["install", "--frozen-lockfile", "--network-concurrency", "4"],
      lockfile: "yarn.lock",
      name: "yarn" as const,
      version: "1.22.22",
    },
  ])(
    "provisions $name with the exact submitted Node runtime available to npm and the hydrated launcher",
    async ({ generation, install, lockfile, name, version }) => {
      const events: unknown[] = [];
      const provider = new RailwayPreparationWorkspaceProvider({
        gateway: fakeGateway(events),
      });
      const handle = await provider.create();
      const plan = {
        catalogRevision: "submitted-js-2026-07-26.1" as const,
        evidence: [
          { kind: "lockfile" as const, source: lockfile, value: name },
        ],
        install: { argv: install, executable: name },
        node: {
          family: 22 as const,
          lifecycle: "supported" as const,
          version: "22.23.2",
        },
        packageManager: {
          generation,
          name,
          projectIntegrity: `sha256:${"a".repeat(64)}` as const,
          version,
        },
        projectRoot: ".",
      };

      await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
      await handle.workspace.syncSubmittedCodeWorkspace?.();
      await handle.workspace.executeSubmittedProject?.({
        argv: install,
        executable: name,
        plan,
      });
      await handle.workspace.executeSubmittedRuntime?.({
        command: `${name} --version`,
        plan,
      });

      const provisionCommand = executedCommands(events, "child").find(
        (command) => command.includes('distribution="https://nodejs.org'),
      );
      expect(provisionCommand).toBeDefined();
      expect(provisionCommand).toContain(
        'PATH="$node_dir/bin:/usr/local/bin:/usr/bin:/bin" "$node_dir/bin/node" "$node_dir/lib/node_modules/npm/bin/npm-cli.js" install --global',
      );
      expect(provisionCommand).toContain(`${name}@${version}`);
      expect(provisionCommand).toMatch(
        new RegExp(
          `PATH="\\$node_dir/bin:/usr/local/bin:/usr/bin:/bin" '/opt/makeademo/submitted-toolchains/[a-f0-9]{32}/manager/bin/${name}' --version`,
        ),
      );
      expect(provisionCommand).not.toContain('"$node_dir/bin/npm"');
      expect(provisionCommand).not.toContain("/usr/local/bin/node");
      const submittedWrappers = executedCommands(events, "child").filter(
        (command) => command.includes("runuser -u 'makeademo' -- env -i"),
      );
      expect(submittedWrappers.slice(-2)).toEqual([
        expect.stringMatching(
          /PATH='\/opt\/makeademo\/submitted-toolchains\/[a-f0-9]{32}\/manager\/bin:\/opt\/makeademo\/submitted-toolchains\/[a-f0-9]{32}\/node\/bin:\/opt\/makeademo\/capture-runtime\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin'/,
        ),
        expect.stringMatching(
          /PATH='\/opt\/makeademo\/submitted-toolchains\/[a-f0-9]{32}\/manager\/bin:\/opt\/makeademo\/submitted-toolchains\/[a-f0-9]{32}\/node\/bin:\/opt\/makeademo\/capture-runtime\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin'/,
        ),
      ]);
    },
  );

  it("waits for a command accepted during release to be cancelled and settled before destroying either sandbox", async () => {
    const events: string[] = [];
    let acceptCommand!: () => void;
    let settleCommand!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptCommand = resolve;
    });
    const result = new Promise<{
      exitCode: number;
      stderr: string;
      stdout: string;
      timedOut: boolean;
      truncated: boolean;
    }>((resolve) => {
      settleCommand = () =>
        resolve({
          exitCode: -1,
          stderr: "",
          stdout: "",
          timedOut: false,
          truncated: false,
        });
    });
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async destroySandbox(sandbox) {
        events.push(`destroy:${sandbox.id}`);
      },
      async execute() {
        await accepted;
        return {
          async kill() {
            events.push("kill");
          },
          async result() {
            return result;
          },
        };
      },
    };
    const provider = new RailwayPreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();
    const execution = handle.workspace.execute("sleep forever");
    const release = handle.release();

    await Promise.resolve();
    expect(events).toEqual([]);
    acceptCommand();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["kill"]);
    expect(events).not.toContain("destroy:child");

    settleCommand();
    await Promise.all([execution, release]);
    expect(events).toEqual(["kill", "destroy:child", "destroy:parent"]);
  });

  it("rejects a package-manager version outside the catalog exact allowlist", async () => {
    const provider = new RailwayPreparationWorkspaceProvider({
      gateway: fakeGateway([]),
    });
    const handle = await provider.create();
    const plan = pnpmPlan(".");
    const packageManager = plan.packageManager;
    if (packageManager === undefined) throw new Error("Expected pnpm plan.");

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.({
        ...plan,
        packageManager: { ...packageManager, version: "11.16.0" },
      }),
    ).rejects.toThrow("supported catalog install capability");
  });
});

function pnpmPlan(
  projectRoot: string,
  integrityCharacter = "a",
): SubmittedCodeToolchainPlan {
  return {
    catalogRevision: "submitted-js-2026-07-26.1",
    evidence: [{ kind: "lockfile", source: "pnpm-lock.yaml", value: "pnpm" }],
    install: {
      argv: [
        "install",
        "--frozen-lockfile",
        "--child-concurrency=2",
        "--network-concurrency=4",
      ],
      executable: "pnpm",
    },
    node: { family: 24, lifecycle: "supported", version: "24.3.2" },
    packageManager: {
      generation: "pnpm-modern",
      name: "pnpm",
      projectIntegrity: `sha256:${integrityCharacter.repeat(64)}`,
      version: "11.17.0",
    },
    projectRoot,
  };
}

function fakeGateway(
  events: unknown[],
  options: { integrityExitCode?: number } = {},
): RailwaySandboxGateway {
  let creation = 0;
  return {
    async createSandbox(createOptions) {
      events.push({ create: createOptions });
      creation += 1;
      return { id: creation === 1 ? "parent" : "child" };
    },
    async destroySandbox(sandbox) {
      events.push({ destroy: sandbox.id });
    },
    async execute(sandbox, command, executeOptions) {
      events.push({
        execute: { command, id: sandbox.id, options: executeOptions },
      });
      return {
        async kill() {},
        async result() {
          return {
            exitCode: command.includes("MAKEADEMO_VERIFY_SUBMITTED_LOCKFILE")
              ? (options.integrityExitCode ?? 0)
              : 0,
            stderr: "",
            stdout: "",
            timedOut: false,
            truncated: false,
          };
        },
      };
    },
    async readFile() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    },
    async writeFile(sandbox, path) {
      events.push({ write: { id: sandbox.id, path } });
    },
  };
}

function dependencyPersistenceGateway(state: {
  childHasInstalledSentinel: boolean;
  childHasRepairedSource: boolean;
  parentHasRepairedSource: boolean;
}): RailwaySandboxGateway {
  let creation = 0;
  return {
    async createSandbox() {
      creation += 1;
      return { id: creation === 1 ? "parent" : "child" };
    },
    async destroySandbox() {},
    async execute(sandbox, command) {
      const submittedCommand = decodeUnprivilegedCommand(command);
      let exitCode = 0;
      if (
        sandbox.id === "child" &&
        command.includes("tar --no-same-owner --no-same-permissions -xzf")
      ) {
        if (!command.includes("MAKEADEMO_PRESERVE_INSTALLED_DEPENDENCIES")) {
          state.childHasInstalledSentinel = false;
        }
        state.childHasRepairedSource = state.parentHasRepairedSource;
      } else if (
        sandbox.id === "child" &&
        submittedCommand.includes("'pnpm' 'install'")
      ) {
        state.childHasInstalledSentinel = true;
      } else if (
        sandbox.id === "child" &&
        submittedCommand.includes("node_modules/.makeademo-installed")
      ) {
        exitCode =
          state.childHasInstalledSentinel && state.childHasRepairedSource
            ? 0
            : 1;
      }
      return {
        async kill() {},
        async result() {
          return {
            exitCode,
            stderr: "",
            stdout: "",
            timedOut: false,
            truncated: false,
          };
        },
      };
    },
    async readFile() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    },
    async writeFile(sandbox, path) {
      if (sandbox.id === "parent" && path === "/workspace/repaired-source.ts") {
        state.parentHasRepairedSource = true;
      }
    },
  };
}

function decodeUnprivilegedCommand(command: string): string {
  const encoded = /^printf %s '([^']+)' \| base64 --decode \|/.exec(
    command,
  )?.[1];
  return encoded === undefined
    ? command
    : Buffer.from(encoded, "base64").toString("utf8");
}

function executedCommands(events: unknown[], id: string): string[] {
  return events.flatMap((event) => {
    if (
      typeof event !== "object" ||
      event === null ||
      !("execute" in event) ||
      typeof event.execute !== "object" ||
      event.execute === null
    ) {
      return [];
    }
    const execute = event.execute as { command?: unknown; id?: unknown };
    return execute.id === id && typeof execute.command === "string"
      ? [execute.command]
      : [];
  });
}

function executedCalls(
  events: unknown[],
  id: string,
): Array<{ command: string; options: unknown }> {
  return events.flatMap((event) => {
    if (
      typeof event !== "object" ||
      event === null ||
      !("execute" in event) ||
      typeof event.execute !== "object" ||
      event.execute === null
    ) {
      return [];
    }
    const execute = event.execute as {
      command?: unknown;
      id?: unknown;
      options?: unknown;
    };
    return execute.id === id && typeof execute.command === "string"
      ? [{ command: execute.command, options: execute.options }]
      : [];
  });
}
