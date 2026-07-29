import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SubmittedCodeToolchainPlan } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import { createStartDemoScript } from "../sandbox/prepared-workspace-sandbox-runner";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";
import { RailwaySpikePreparationWorkspaceProvider } from "./railway-spike-preparation-workspace-provider";

describe("RailwaySpikePreparationWorkspaceProvider", () => {
  it("starts both isolated sandbox creations before either sandbox becomes ready", async () => {
    const started: string[] = [];
    let finishParent!: () => void;
    let finishChild!: () => void;
    let createCount = 0;
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async createSandbox() {
        createCount += 1;
        const id = createCount === 1 ? "parent" : "child";
        started.push(id);
        await new Promise<void>((resolve) => {
          if (id === "parent") finishParent = resolve;
          else finishChild = resolve;
        });
        return { id };
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    let settled = false;

    const creation = provider.create().finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(started).toEqual(["parent", "child"]);
    finishParent();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishChild();

    await expect(creation).resolves.toMatchObject({ id: "parent" });
  });

  it("creates isolated empty-environment parent and submitted-code sandboxes and routes commands to their boundary", async () => {
    const events: unknown[] = [];
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });

    const handle = await provider.create();
    await handle.workspace.execute("printf parent");
    await handle.workspace.executeSubmittedCode?.("printf child");

    expect(events).toEqual([
      {
        create: {
          env: {},
          idleTimeoutMinutes: 15,
          networkIsolation: "ISOLATED",
          timeoutMs: 630000,
        },
      },
      {
        create: {
          env: {},
          idleTimeoutMinutes: 15,
          networkIsolation: "ISOLATED",
          timeoutMs: 630000,
        },
      },
      {
        exec: {
          command: "printf parent",
          id: "parent",
          options: { cwd: "/workspace", env: {}, timeoutMs: 600000 },
        },
      },
      {
        exec: {
          command: expect.stringContaining("runuser -u 'makeademo' -- env -i"),
          id: "child",
          options: {
            cwd: "/workspace",
            env: {},
            timeoutMs: 600000,
          },
        },
      },
    ]);
  });

  it("refuses submitted project execution until the fixed canary toolchain has been provisioned", async () => {
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway([]),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: ["ci"],
        executable: "npm",
        plan: fixedCanaryPlan(),
      }),
    ).rejects.toThrow("has not been provisioned");
  });

  it("requires the exact provisioned canary plan to synchronize before submitted runtime execution", async () => {
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway([]),
    });
    const handle = await provider.create();
    const plan = fixedCanaryPlan();

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);

    await expect(
      handle.workspace.executeSubmittedRuntime?.({
        command: "npm run demo",
        plan,
      }),
    ).rejects.toThrow("requires synchronization");

    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await expect(
      handle.workspace.executeSubmittedRuntime?.({
        command: "npm run demo",
        plan,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    await expect(
      handle.workspace.executeSubmittedRuntime?.({
        command: "npm run demo",
        plan: { ...plan, install: { argv: ["ci"], executable: "npm" } },
      }),
    ).rejects.toThrow("not the exact provisioned canary plan");
    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: ["ci"],
        executable: "npm",
        plan,
      }),
    ).rejects.toThrow("declares no immutable install request");
  });

  it("runs agent and synchronized submitted runtime commands as the fixed unprivileged recipe user with a sealed environment", async () => {
    const events: unknown[] = [];
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();
    const plan = fixedCanaryPlan();
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await handle.workspace.executeAgentCommand?.("id");
    await handle.workspace.executeSubmittedRuntime?.(
      { command: "npm run demo", plan },
      { env: { NODE_ENV: "production" } },
    );

    const commands = events
      .filter(
        (event): event is { exec: { command: string; options: unknown } } =>
          typeof event === "object" && event !== null && "exec" in event,
      )
      .map((event) => event.exec.command);
    expect(commands.length).toBeGreaterThanOrEqual(4);
    expect(commands.slice(-2)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("runuser -u 'makeademo' -- env -i"),
        expect.stringContaining("PLAYWRIGHT_BROWSERS_PATH='/ms-playwright'"),
      ]),
    );
    expect(JSON.stringify(events)).toContain("NODE_ENV='production'");

    await expect(
      handle.workspace.executeSubmittedRuntime?.(
        { command: "npm run demo", plan },
        { env: { PATH: "/attacker/bin" } },
      ),
    ).rejects.toThrow("cannot override trusted environment variable PATH");
  });

  it("executes trusted inspection and validated npm installs with pinned absolute runtimes", async () => {
    const events: unknown[] = [];
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();
    const plan: SubmittedCodeToolchainPlan = {
      ...fixedCanaryPlan(),
      install: { argv: ["ci"], executable: "npm" },
    };

    await handle.workspace.execute(
      "makeademo-inspect-submitted-code-toolchain",
    );
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedProject?.({
      argv: ["ci"],
      executable: "npm",
      plan,
    });

    const commands = events
      .filter(
        (event): event is { exec: { command: string; options: unknown } } =>
          typeof event === "object" && event !== null && "exec" in event,
      )
      .map((event) => event.exec.command);
    expect(commands).toContain(
      "/opt/makeademo/toolchains/node/versions/22.23.1/bin/node /usr/local/bin/makeademo-inspect-submitted-code-toolchain",
    );
    expect(commands.at(-1)).toContain(
      Buffer.from(
        "'/opt/makeademo/toolchains/node/versions/22.23.1/bin/npm' 'ci'",
        "utf8",
      ).toString("base64"),
    );
    expect(JSON.stringify(events)).not.toContain('"PATH":');
  });

  it("rolls back a created parent when child creation fails", async () => {
    const destroyed: string[] = [];
    let createCount = 0;
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async createSandbox() {
        createCount += 1;
        if (createCount === 1) return { id: "parent" };
        throw new Error("child unavailable");
      },
      async destroySandbox(sandbox) {
        destroyed.push(sandbox.id);
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });

    await expect(provider.create()).rejects.toThrow("child unavailable");
    expect(destroyed).toEqual(["parent"]);
  });

  it("fails closed when Railway reports timed-out or truncated command evidence", async () => {
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async execute() {
        return {
          async kill() {},
          async result() {
            return {
              exitCode: 0,
              stderr: "partial stderr",
              stdout: "partial stdout",
              timedOut: true,
              truncated: true,
            };
          },
        };
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();

    await expect(handle.workspace.execute("printf incomplete")).rejects.toThrow(
      "timedOut=true, truncated=true",
    );
  });

  it("starts submitted demo runtimes through an acknowledged durable detach", async () => {
    const events: unknown[] = [];
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();
    const plan = fixedCanaryPlan();
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await handle.workspace.executeSubmittedRuntime?.({
      command: createStartDemoScript("node server.mjs"),
      plan,
    });

    const runtimeExecution = [...events]
      .reverse()
      .find(isRuntimeExecutionEvent);
    expect(runtimeExecution).toEqual(
      expect.objectContaining({
        exec: expect.objectContaining({
          id: "child",
          options: expect.objectContaining({
            detachAfterFirstStdout: true,
            detachTimeoutMs: 5_000,
          }),
        }),
      }),
    );
  });

  it("settles an ordinary submitted runtime command without detaching it", async () => {
    const events: unknown[] = [];
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();
    const plan = fixedCanaryPlan();
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await expect(
      handle.workspace.executeSubmittedRuntime?.({
        command: "printf ordinary-runtime-check",
        plan,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const runtimeExecution = [...events]
      .reverse()
      .find(isOrdinaryRuntimeExecutionEvent);
    expect(runtimeExecution).toEqual(
      expect.objectContaining({
        exec: expect.objectContaining({
          options: {
            cwd: "/workspace",
            env: {},
            timeoutMs: 600_000,
          },
        }),
      }),
    );
  });

  it("attempts child and parent destruction and aggregates cleanup failures", async () => {
    const destroyed: string[] = [];
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async destroySandbox(sandbox) {
        destroyed.push(sandbox.id);
        if (sandbox.id === "child") throw new Error("child destroy failed");
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();

    await expect(handle.release()).rejects.toThrow(
      "Railway spike preparation workspace release failed",
    );
    expect(destroyed).toEqual(["child", "parent"]);
    await expect(handle.release()).rejects.toThrow(
      "Railway spike preparation workspace release failed",
    );
    expect(destroyed).toEqual(["child", "parent"]);
  });

  it("settles active command cancellation before destroying either sandbox", async () => {
    const destroyed: string[] = [];
    const events: string[] = [];
    let finishKill: (() => void) | undefined;
    let finishResult: (() => void) | undefined;
    let commandResult:
      | Promise<{
          exitCode: number;
          stderr: string;
          stdout: string;
          timedOut: boolean;
          truncated: boolean;
        }>
      | undefined;
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async destroySandbox(sandbox) {
        destroyed.push(sandbox.id);
      },
      async execute(_sandbox, command) {
        if (command === "echo after-release") {
          return {
            async kill() {},
            async result() {
              return {
                exitCode: 0,
                stderr: "",
                stdout: "",
                timedOut: false,
                truncated: false,
              };
            },
          };
        }
        return {
          async kill() {
            events.push("kill");
            await new Promise<void>((resolve) => {
              finishKill = resolve;
            });
          },
          async result() {
            commandResult ??= new Promise((resolve) => {
              finishResult = () =>
                resolve({
                  exitCode: -1,
                  stderr: "",
                  stdout: "",
                  timedOut: false,
                  truncated: false,
                });
            });
            return commandResult;
          },
        };
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();
    void handle.workspace.execute("sleep 99");
    await Promise.resolve();

    const release = handle.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["kill"]);
    expect(destroyed).toEqual([]);

    finishKill?.();
    finishResult?.();
    await release;
    expect(destroyed).toEqual(["child", "parent"]);
  });

  it("atomically rejects new workspace operations once release starts", async () => {
    let releaseKill: (() => void) | undefined;
    let settleResult: (() => void) | undefined;
    const commandResult = new Promise<{
      exitCode: number;
      stderr: string;
      stdout: string;
      timedOut: boolean;
      truncated: boolean;
    }>((resolve) => {
      settleResult = () =>
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
      async execute(_sandbox, command) {
        if (command === "echo after-release") {
          return {
            async kill() {},
            async result() {
              return {
                exitCode: 0,
                stderr: "",
                stdout: "",
                timedOut: false,
                truncated: false,
              };
            },
          };
        }
        return {
          async kill() {
            await new Promise<void>((resolve) => {
              releaseKill = resolve;
            });
          },
          async result() {
            return commandResult;
          },
        };
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();
    void handle.workspace.execute("sleep 99");
    await Promise.resolve();

    const release = handle.release();
    await expect(
      handle.workspace.execute("echo after-release"),
    ).rejects.toThrow("is releasing");

    releaseKill?.();
    settleResult?.();
    await release;
  });

  it("synchronizes the prepared parent through a bounded host archive without VCS or MakeADemo state", async () => {
    const events: unknown[] = [];
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      gateway: fakeGateway(events),
    });
    const handle = await provider.create();

    await handle.workspace.provisionSubmittedCodeToolchain?.(fixedCanaryPlan());

    await handle.workspace.syncSubmittedCodeWorkspace?.();

    expect(events).toContainEqual(
      expect.objectContaining({
        exec: expect.objectContaining({
          command: expect.stringContaining("--exclude='./.git'"),
          id: "parent",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        exec: expect.objectContaining({
          command: expect.stringContaining("--exclude='./.makeademo'"),
          id: "parent",
        }),
      }),
    );
    expect(events).toContainEqual({
      download: expect.objectContaining({
        id: "parent",
        path: expect.stringMatching(
          /^\/root\/\.makeademo-railway-sync-[a-f0-9]{32}\.tar\.gz$/,
        ),
      }),
    });
    expect(events).toContainEqual({
      upload: expect.objectContaining({
        id: "child",
        path: expect.stringMatching(
          /^\/root\/\.makeademo-railway-sync-[a-f0-9]{32}\.tar\.gz$/,
        ),
      }),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        exec: expect.objectContaining({
          command: expect.stringContaining(
            "tar --no-same-owner --no-same-permissions -xzf",
          ),
          id: "child",
        }),
      }),
    );
  });

  it("bounds an upload by its total timeout and still releases both sandboxes", async () => {
    const destroyed: string[] = [];
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async destroySandbox(sandbox) {
        destroyed.push(sandbox.id);
      },
      async writeFile() {
        return new Promise(() => undefined);
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();

    await expect(
      handle.workspace.uploadFiles(
        [
          {
            destinationPath: "/workspace/package.json",
            sourcePath: "package.json",
          },
        ],
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow("upload timed out");
    await expect(handle.release()).resolves.toBeUndefined();
    expect(destroyed).toEqual(["child", "parent"]);
  });

  it("does not publish or retain partial output when a timed-out download settles late", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-railway-test-"));
    const destinationPath = join(directory, "artifact.txt");
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async readFile() {
        return new ReadableStream<Uint8Array>({
          start() {},
          cancel() {
            return cancellation;
          },
        });
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();
    try {
      await expect(
        handle.workspace.downloadFiles?.(
          [{ destinationPath, sourcePath: "/workspace/artifact.txt" }],
          { timeoutMs: 5 },
        ),
      ).rejects.toThrow("download timed out");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(readFile(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(`${destinationPath}.railway-partial`),
      ).rejects.toMatchObject({ code: "ENOENT" });
      finishCancellation();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(readFile(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(`${destinationPath}.railway-partial`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finishCancellation();
      await handle.release();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("preserves a colliding sidecar and removes its own staging file after a failed download", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-railway-test-"));
    const destinationPath = join(directory, "artifact.txt");
    const sidecarPath = `${destinationPath}.railway-partial`;
    const sidecarBytes = Buffer.from([0, 255, 1, 254, 2]);
    await writeFile(sidecarPath, sidecarBytes);
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async readFile() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.close();
          },
        });
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();
    try {
      await expect(
        handle.workspace.downloadFiles?.(
          [{ destinationPath, sourcePath: "/workspace/artifact.txt" }],
          { maxBytes: 2 },
        ),
      ).rejects.toThrow("2-byte limit");

      await expect(readFile(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(sidecarPath)).resolves.toEqual(sidecarBytes);
      await expect(readdir(directory)).resolves.toEqual([
        "artifact.txt.railway-partial",
      ]);
    } finally {
      await handle.release();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("observes caller abort while the remote download stream is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-railway-test-"));
    const destinationPath = join(directory, "artifact.txt");
    let finishRead!: (stream: ReadableStream<Uint8Array>) => void;
    const pendingRead = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      finishRead = resolve;
    });
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async readFile() {
        return pendingRead;
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();
    const controller = new AbortController();
    const download = handle.workspace.downloadFiles?.(
      [{ destinationPath, sourcePath: "/workspace/artifact.txt" }],
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    try {
      controller.abort();
      await expect(
        Promise.race([
          download,
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("caller abort was not observed promptly")),
              25,
            );
          }),
        ]),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(readFile(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      finishRead(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.close();
          },
        }),
      );
      await download?.catch(() => undefined);
      await handle.release();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rolls back every published download when a later destination cannot be replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-railway-test-"));
    const newDestination = join(directory, "new.txt");
    const existingDestination = join(directory, "existing.txt");
    const directoryDestination = join(directory, "existing-directory");
    await writeFile(existingDestination, "original");
    await mkdir(directoryDestination);
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async readFile(_sandbox, sourcePath) {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sourcePath));
            controller.close();
          },
        });
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });
    const handle = await provider.create();
    try {
      await expect(
        handle.workspace.downloadFiles?.([
          { destinationPath: newDestination, sourcePath: "/new" },
          {
            destinationPath: existingDestination,
            sourcePath: "/replacement",
          },
          {
            destinationPath: directoryDestination,
            sourcePath: "/directory",
          },
        ]),
      ).rejects.toMatchObject({ code: "EISDIR" });

      await expect(readFile(newDestination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(existingDestination, "utf8")).resolves.toBe(
        "original",
      );
      await expect(readdir(directoryDestination)).resolves.toEqual([]);
      expect((await readdir(directory)).sort()).toEqual([
        "existing-directory",
        "existing.txt",
      ]);
    } finally {
      await handle.release();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("aborts while the parent sandbox creation is still pending", async () => {
    const controller = new AbortController();
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async createSandbox(options) {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException(
                  "Railway sandbox creation was aborted.",
                  "AbortError",
                ),
              ),
            { once: true },
          );
        });
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({
      createTimeoutMs: 500,
      gateway,
      pendingCreationDrainTimeoutMs: 5,
    });

    const creation = provider.create({ signal: controller.signal });
    controller.abort();

    await expect(creation).rejects.toThrow("aborted");
  }, 1_000);

  it("on child-create abort destroys the parent and drains the late child", async () => {
    const controller = new AbortController();
    const destroyed: string[] = [];
    let creates = 0;
    let lateChildPending = false;
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async createSandbox(options) {
        creates += 1;
        if (creates === 1) return { id: "parent" };
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              lateChildPending = true;
              reject(
                new DOMException(
                  "Railway sandbox creation was aborted.",
                  "AbortError",
                ),
              );
            },
            { once: true },
          );
        });
      },
      async destroySandbox(sandbox) {
        destroyed.push(sandbox.id);
      },
      async drainPendingCreations() {
        if (lateChildPending) destroyed.push("late-child");
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });

    const creation = provider.create({ signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(creation).rejects.toThrow("aborted");
    expect(destroyed).toEqual(["parent", "late-child"]);
  });

  it("aggregates a create failure with an incomplete pending-creation drain", async () => {
    const drainTimeouts: number[] = [];
    const gateway: RailwaySandboxGateway = {
      ...fakeGateway([]),
      async createSandbox() {
        throw new Error("parent create failed");
      },
      async drainPendingCreations(options) {
        drainTimeouts.push(options.timeoutMs);
        throw new Error(
          "Railway pending sandbox creation reconciliation timed out.",
        );
      },
    };
    const provider = new RailwaySpikePreparationWorkspaceProvider({ gateway });

    const failure = await provider.create().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "parent create failed" }),
      expect.objectContaining({ message: "parent create failed" }),
      expect.objectContaining({
        message: "Railway pending sandbox creation reconciliation timed out.",
      }),
    ]);
    expect(drainTimeouts).toEqual([640_000]);
  });
});

function fixedCanaryPlan(): SubmittedCodeToolchainPlan {
  return {
    catalogRevision: "submitted-js-2026-07-26.1",
    evidence: [],
    node: { family: 22, lifecycle: "supported", version: "22.23.1" },
    packageManager: {
      generation: "npm-modern",
      name: "npm",
      version: "11.6.2",
    },
    projectRoot: ".",
  };
}

function fakeGateway(events: unknown[]): RailwaySandboxGateway {
  let created = 0;
  return {
    async createSandbox(options) {
      events.push({ create: options });
      created += 1;
      return { id: created === 1 ? "parent" : "child" };
    },
    async destroySandbox() {},
    async drainPendingCreations() {},
    async execute(sandbox, command, options) {
      events.push({ exec: { command, id: sandbox.id, options } });
      return {
        async kill() {},
        async result() {
          return {
            exitCode: 0,
            stderr: "",
            stdout: "",
            timedOut: false,
            truncated: false,
          };
        },
      };
    },
    async readFile(sandbox, path) {
      events.push({ download: { id: sandbox.id, path } });
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    },
    async writeFile(sandbox, path) {
      events.push({ upload: { id: sandbox.id, path } });
    },
  };
}

function isRuntimeExecutionEvent(
  event: unknown,
): event is { exec: { command: string; id: string; options: unknown } } {
  return isEncodedRuntimeExecutionEvent(
    event,
    createStartDemoScript("node server.mjs"),
  );
}

function isOrdinaryRuntimeExecutionEvent(
  event: unknown,
): event is { exec: { command: string; id: string; options: unknown } } {
  return isEncodedRuntimeExecutionEvent(event, "printf ordinary-runtime-check");
}

function isEncodedRuntimeExecutionEvent(
  event: unknown,
  expectedCommand: string,
): event is { exec: { command: string; id: string; options: unknown } } {
  return (
    typeof event === "object" &&
    event !== null &&
    "exec" in event &&
    (event as { exec: { command?: string } }).exec.command?.includes(
      Buffer.from(expectedCommand, "utf8").toString("base64"),
    ) === true
  );
}
