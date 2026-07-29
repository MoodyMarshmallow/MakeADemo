import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SubmittedCodeToolchainPlan } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import { RailwayPreparationWorkspaceProvider } from "./railway-preparation-workspace-provider";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";

describe("RailwayPreparationWorkspaceProvider", () => {
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
