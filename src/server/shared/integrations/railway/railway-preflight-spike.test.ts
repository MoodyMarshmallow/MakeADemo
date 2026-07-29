import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { SubmittedCodeToolchainPlan } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import {
  runRailwayPreflightSpike,
  runRailwayPreflightSpikeCli,
} from "./railway-preflight-spike";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";
import { RailwaySpikePreparationWorkspaceProvider } from "./railway-spike-preparation-workspace-provider";
import { railwaySpikeTemplateRevision } from "./railway-spike-template-recipe";

describe("runRailwayPreflightSpike", () => {
  it("composes the real Railway provider with the absolute pinned-Node inspector command", async () => {
    const evidenceRootDirectory = await mkdtemp(
      `${tmpdir()}/makeademo-railway-composition-test-`,
    );
    const screenshotPath = `${evidenceRootDirectory}/source.png`;
    await writeFile(screenshotPath, pngBytes);
    const { gateway, inspectorCommands } = statefulRailwayGateway();
    let resolvedPlan: SubmittedCodeToolchainPlan | undefined;
    try {
      const report = await runRailwayPreflightSpike({
        dependencies: {
          browserValidator: {
            async validate(input) {
              await input.preparationWorkspace?.workspace.uploadFiles([
                {
                  destinationPath:
                    "/workspace/.makeademo/demo-runtime-preflight/browser.png",
                  sourcePath: screenshotPath,
                },
              ]);
              return {
                blockedNetworkAttempts: [],
                interactable: true,
                logs: [],
                screenshot: {
                  mimeType: "image/png",
                  path: "/workspace/.makeademo/demo-runtime-preflight/browser.png",
                  sizeBytes: pngBytes.length,
                },
                screenshotArtifactId: "",
              };
            },
          },
          createGateway: () => gateway,
          createProvider: (providerGateway) =>
            new RailwaySpikePreparationWorkspaceProvider({
              gateway: providerGateway,
            }),
          sandboxRunner: {
            async runValidation(input) {
              const plan = input.preparationWorkspace.toolchainPlan;
              if (plan === undefined) {
                throw new Error("Preflight did not retain the pinned plan.");
              }
              resolvedPlan = plan;
              await input.preparationWorkspace.workspace.provisionSubmittedCodeToolchain?.(
                plan,
              );
              await input.preparationWorkspace.workspace.syncSubmittedCodeWorkspace?.();
              await input.preparationWorkspace.workspace.executeSubmittedRuntime?.(
                { command: "node server.mjs", plan },
              );
              return {
                blockedNetworkAttempts: [],
                browserUrl: "http://127.0.0.1:4173/",
                localUrl: "http://127.0.0.1:4173/",
                logs: [],
                repoFiles: ["package-lock.json", "package.json", "server.mjs"],
                runtimeExitCode: 0,
              };
            },
          },
        },
        environment: enabledEnvironment(),
        evidenceRootDirectory,
      });

      expect(report.status).toBe("succeeded");
      expect(inspectorCommands).toEqual([
        "/opt/makeademo/toolchains/node/versions/22.23.1/bin/node /usr/local/bin/makeademo-inspect-submitted-code-toolchain",
      ]);
      expect(resolvedPlan).toMatchObject({
        node: { version: "22.23.1" },
        packageManager: { name: "npm", version: "11.6.2" },
        projectRoot: ".",
      });
    } finally {
      await rm(evidenceRootDirectory, { force: true, recursive: true });
    }
  });

  it("resolves the uploaded fixture through the real preflight toolchain contract", async () => {
    let resolvedPlan: SubmittedCodeToolchainPlan | undefined;
    const { handle } = statefulPreflightHandle();

    const report = await runRailwayPreflightSpike({
      dependencies: {
        createGateway: () => fakeGateway(),
        createProvider: () => ({
          async create() {
            return handle;
          },
        }),
        sandboxRunner: {
          async runValidation(input) {
            resolvedPlan = input.preparationWorkspace?.toolchainPlan;
            return {
              blockedNetworkAttempts: [],
              browserUrl: "http://127.0.0.1:4173/",
              localUrl: "http://127.0.0.1:4173/",
              logs: [],
              repoFiles: ["package-lock.json", "package.json", "server.mjs"],
              runtimeExitCode: 0,
            };
          },
        },
      },
      environment: enabledEnvironment(),
    });

    expect(resolvedPlan).toMatchObject({
      node: { version: "22.23.1" },
      packageManager: { name: "npm", version: "11.6.2" },
      projectRoot: ".",
    });
    await rm(report.evidenceDirectory, { force: true, recursive: true });
  });

  it("composes the real preflight runner and Playwright validator through a stateful workspace", async () => {
    const { events, handle } = statefulPreflightHandle();

    const report = await runRailwayPreflightSpike({
      dependencies: {
        createGateway: () => fakeGateway(),
        createProvider: () => ({
          async create() {
            return handle;
          },
        }),
      },
      environment: enabledEnvironment(),
    });

    expect(report.status).toBe("succeeded");
    expect(JSON.stringify(report)).not.toMatch(
      /project-token|ambient-browser-token|browser-secret/,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        "provision:22.23.1:npm@11.6.2",
        "sync",
        "runtime:node server.mjs",
        "browser:http://127.0.0.1:4173/",
        "screenshot:child-to-parent",
      ]),
    );
    await rm(report.evidenceDirectory, { force: true, recursive: true });
  });

  it("persists verified PNG and toolchain evidence before releasing the workspace", async () => {
    const evidenceRootDirectory = await mkdtemp(
      `${tmpdir()}/makeademo-railway-report-test-`,
    );
    try {
      const { events, handle } = statefulPreflightHandle();
      const report = await runRailwayPreflightSpike({
        dependencies: {
          createGateway: () => fakeGateway(),
          createProvider: () => ({
            async create() {
              return handle;
            },
          }),
        },
        environment: enabledEnvironment(),
        evidenceRootDirectory,
      });

      expect(await readFile(report.screenshot.path)).toEqual(pngBytes);
      expect(report.screenshot).toMatchObject({
        sha256: `sha256:${createHash("sha256").update(pngBytes).digest("hex")}`,
        sizeBytes: pngBytes.length,
      });
      expect(report).toMatchObject({
        templateRevision: railwaySpikeTemplateRevision,
        pinnedToolVersions: {
          node: "22.23.1",
          npm: "11.6.2",
          playwright: "1.49.1",
        },
      });
      expect(JSON.parse(await readFile(report.reportPath, "utf8"))).toEqual(
        report,
      );
      expect(events.indexOf("screenshot:parent-to-report")).toBeLessThan(
        events.indexOf("release"),
      );
    } finally {
      await rm(evidenceRootDirectory, { force: true, recursive: true });
    }
  });

  it("retains completed evidence with redacted cleanup metadata when release fails", async () => {
    const evidenceRootDirectory = await mkdtemp(
      `${tmpdir()}/makeademo-railway-release-test-`,
    );
    try {
      const { handle } = statefulPreflightHandle({
        releaseError: new Error("token=release-secret cleanup failed"),
      });
      await expect(
        runRailwayPreflightSpike({
          dependencies: {
            createGateway: () => fakeGateway(),
            createProvider: () => ({
              async create() {
                return handle;
              },
            }),
          },
          environment: enabledEnvironment(),
          evidenceRootDirectory,
        }),
      ).rejects.toThrow("token=[redacted] cleanup failed");

      const [evidenceName] = await readdir(evidenceRootDirectory);
      expect(evidenceName).toBeDefined();
      const evidenceDirectory = `${evidenceRootDirectory}/${evidenceName}`;
      const retainedReport = JSON.parse(
        await readFile(`${evidenceDirectory}/report.json`, "utf8"),
      );
      expect(await readFile(`${evidenceDirectory}/browser.png`)).toEqual(
        pngBytes,
      );
      expect(retainedReport.cleanupFailure).toEqual({
        message: "token=[redacted] cleanup failed",
        name: "Error",
      });
    } finally {
      await rm(evidenceRootDirectory, { force: true, recursive: true });
    }
  });

  it("aborts an active preflight and awaits workspace release without returning a report", async () => {
    const controller = new AbortController();
    let settleValidation: (() => void) | undefined;
    let validationStarted: (() => void) | undefined;
    let releaseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const validation = new Promise<never>((_resolve, reject) => {
      settleValidation = () => reject(new Error("validation cancelled"));
    });
    const released = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const { events, handle } = statefulPreflightHandle({
      onRelease: () => {
        releaseStarted?.();
        settleValidation?.();
      },
    });
    const run = runRailwayPreflightSpike({
      dependencies: {
        createGateway: () => fakeGateway(),
        createProvider: () => ({
          async create() {
            return handle;
          },
        }),
        sandboxRunner: {
          async runValidation() {
            validationStarted?.();
            return validation;
          },
        },
      },
      environment: enabledEnvironment(),
      signal: controller.signal,
    });
    await started;

    controller.abort(new Error("SIGINT"));
    await released;

    await expect(run).rejects.toThrow("SIGINT");
    expect(events).toContain("release");
  });

  it("defers signal exit state until the active run finishes cleanup and prints no report", async () => {
    const cliProcess = new FakeCliProcess();
    let finishRelease: (() => void) | undefined;
    const releaseFinished = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const cli = runRailwayPreflightSpikeCli({
      process: cliProcess,
      run: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await releaseFinished;
        throw signal?.reason;
      },
    });

    cliProcess.emit("SIGTERM");
    await Promise.resolve();
    expect(cliProcess.exitCode).toBeUndefined();
    expect(cliProcess.stdoutWrites).toEqual([]);

    finishRelease?.();
    await cli;
    expect(cliProcess.exitCode).toBe(143);
    expect(cliProcess.stdoutWrites).toEqual([]);
    expect(cliProcess.listenerCount("SIGINT")).toBe(0);
    expect(cliProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("passes the CLI abort signal into provider creation and waits for its cleanup", async () => {
    const cliProcess = new FakeCliProcess();
    let creationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    let finishCreationCleanup: (() => void) | undefined;
    const creationCleanup = new Promise<void>((resolve) => {
      finishCreationCleanup = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const cli = runRailwayPreflightSpikeCli({
      process: cliProcess,
      run: ({ signal }) =>
        runRailwayPreflightSpike({
          dependencies: {
            createGateway: () => fakeGateway(),
            createProvider: () => ({
              async create(options = {}) {
                creationStarted?.();
                receivedSignal = options.signal;
                if (options.signal === undefined) {
                  throw new Error("provider create did not receive signal");
                }
                await new Promise<void>((resolve) => {
                  options.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                await creationCleanup;
                throw options.signal.reason;
              },
            }),
          },
          environment: enabledEnvironment(),
          ...(signal === undefined ? {} : { signal }),
        }),
    });
    await started;

    cliProcess.emit("SIGINT");
    await Promise.resolve();
    expect(receivedSignal?.aborted).toBe(true);
    expect(cliProcess.exitCode).toBeUndefined();
    expect(cliProcess.stdoutWrites).toEqual([]);

    finishCreationCleanup?.();
    await cli;
    expect(cliProcess.exitCode).toBe(130);
    expect(cliProcess.stdoutWrites).toEqual([]);
  });

  it("prints structured redacted lifecycle and nested cleanup diagnostics", async () => {
    const cliProcess = new FakeCliProcess();
    const lifecycleFailure = Object.assign(
      new Error("token=project-secret readiness timed out"),
      {
        cleanup: "failed",
        elapsedMs: 630_000,
        id: "sandbox-safe-id",
        lastStatus: "CREATING",
        phase: "sdk-create",
        resource: "sandbox",
      },
    );

    await runRailwayPreflightSpikeCli({
      process: cliProcess,
      run: async () => {
        throw new AggregateError(
          [lifecycleFailure, new Error("Authorization: Bearer cleanup-secret")],
          "Railway operation and cleanup failed",
        );
      },
    });

    expect(cliProcess.exitCode).toBe(1);
    const output = cliProcess.stderrWrites.join("");
    expect(output).not.toMatch(/project-secret|cleanup-secret/);
    expect(JSON.parse(output)).toEqual({
      error: {
        errors: [
          {
            cleanup: "failed",
            elapsedMs: 630_000,
            message: "token=[redacted] readiness timed out",
            name: "Error",
            phase: "sdk-create",
            resource: "sandbox",
            resourceId: "sandbox-safe-id",
            status: "CREATING",
          },
          {
            message: "Authorization: Bearer [redacted]",
            name: "Error",
          },
        ],
        message: "Railway operation and cleanup failed",
        name: "AggregateError",
      },
      event: "railway-preflight-spike-failed",
    });
  });

  it("redacts complete authorization values and common secret key variants", async () => {
    const cliProcess = new FakeCliProcess();

    await runRailwayPreflightSpikeCli({
      process: cliProcess,
      run: async () => {
        throw new Error(
          "Authorization: Basic basic-value; client_secret=client-value db_password=password-value credentials=credential-value secretKey=secret-value",
        );
      },
    });

    const output = cliProcess.stderrWrites.join("");
    expect(output).not.toMatch(
      /basic-value|client-value|password-value|credential-value|secret-value/,
    );
    expect(JSON.parse(output)).toEqual({
      error: {
        message:
          "Authorization: [redacted]; client_secret=[redacted] db_password=[redacted] credentials=[redacted] secretKey=[redacted]",
        name: "Error",
      },
      event: "railway-preflight-spike-failed",
    });
  });

  it("serializes cyclic error causes, aggregate entries, and lifecycle metadata", async () => {
    const cliProcess = new FakeCliProcess();
    const cyclicCause = new Error("credential=cause-secret");
    cyclicCause.cause = cyclicCause;
    const cyclicCleanup: Record<string, unknown> = {};
    cyclicCleanup.self = cyclicCleanup;
    const aggregate = Object.assign(
      new AggregateError([cyclicCause], "token=aggregate-secret"),
      {
        cleanup: cyclicCleanup,
        elapsedMs: 630_000,
        phase: "sdk-create",
        resource: "sandbox",
        status: "deadline-exceeded",
      },
    );
    aggregate.errors.push(aggregate);

    await runRailwayPreflightSpikeCli({
      process: cliProcess,
      run: ({ signal }) =>
        runRailwayPreflightSpike({
          dependencies: {
            createGateway: () => fakeGateway(),
            createProvider: () => ({
              async create() {
                throw aggregate;
              },
            }),
          },
          environment: enabledEnvironment(),
          ...(signal === undefined ? {} : { signal }),
        }),
    });

    const output = cliProcess.stderrWrites.join("");
    expect(output).not.toMatch(/cause-secret|aggregate-secret/);
    expect(JSON.parse(output)).toEqual({
      error: {
        cleanup: "[circular]",
        elapsedMs: 630_000,
        errors: [
          {
            cause: { message: "[circular]", name: "Error" },
            message: "credential=[redacted]",
            name: "Error",
          },
          { message: "[circular]", name: "Error" },
        ],
        message: "token=[redacted]",
        name: "AggregateError",
        phase: "sdk-create",
        resource: "sandbox",
        status: "deadline-exceeded",
      },
      event: "railway-preflight-spike-failed",
    });
  });

  it("does not construct a Railway gateway until its explicit opt-in gate and dedicated inputs are present", async () => {
    let gatewayCreated = false;

    await expect(
      runRailwayPreflightSpike({
        dependencies: {
          createGateway() {
            gatewayCreated = true;
            throw new Error("must not create Railway resources");
          },
        },
        environment: {
          MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID: "env_canary",
          MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: "project-token",
        },
      }),
    ).rejects.toThrow("RUN_RAILWAY_SANDBOX_SPIKE=1");

    expect(gatewayCreated).toBe(false);

    await expect(
      runRailwayPreflightSpike({
        dependencies: {
          createGateway() {
            gatewayCreated = true;
            throw new Error("must not create Railway resources");
          },
        },
        environment: {
          RAILWAY_API_TOKEN: "ambient-api-token",
          RAILWAY_ENVIRONMENT_ID: "ambient-environment",
          RAILWAY_TOKEN: "ambient-token",
          RUN_RAILWAY_SANDBOX_SPIKE: "1",
        },
      }),
    ).rejects.toThrow("MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN");

    expect(gatewayCreated).toBe(false);
  });

  it("passes explicit Railway agent attribution into the SDK gateway boundary", async () => {
    let gatewayInput: unknown;

    await expect(
      runRailwayPreflightSpike({
        dependencies: {
          createGateway(input) {
            gatewayInput = input;
            return fakeGateway();
          },
          createProvider: () => ({
            async create() {
              throw new Error("stop after gateway composition");
            },
          }),
        },
        environment: {
          ...enabledEnvironment(),
          RAILWAY_AGENT_SESSION: "railway-session",
          RAILWAY_CALLER: "skill:use-railway@1.3.6",
        },
      }),
    ).rejects.toThrow("stop after gateway composition");

    expect(gatewayInput).toEqual({
      environmentId: "env_canary",
      projectToken: "project-token",
      railwayAgentSession: "railway-session",
      railwayCaller: "skill:use-railway@1.3.6",
    });
  });

  it("aggregates operation and release failures while recursively redacting token-like diagnostics", async () => {
    const handle: PreparationWorkspaceHandle = {
      id: "railway-parent",
      async release() {
        throw new Error("Authorization: Bearer release-secret");
      },
      workspace: {
        async execute() {
          throw new Error("not reached");
        },
        async uploadFiles() {
          throw new AggregateError(
            [
              new Error("token=project-token"),
              new Error('{"apiKey":"sk-nested-secret"}'),
            ],
            "RAILWAY_TOKEN=ambient-secret",
          );
        },
      },
    };

    const caught = await runRailwayPreflightSpike({
      dependencies: {
        createGateway: () => fakeGateway(),
        createProvider: () => ({
          async create() {
            return handle;
          },
        }),
      },
      environment: enabledEnvironment(),
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AggregateError);
    const diagnostics = serializeError(caught);
    expect(diagnostics).toContain("[redacted]");
    for (const secret of [
      "project-token",
      "ambient-secret",
      "sk-nested-secret",
      "release-secret",
    ]) {
      expect(diagnostics).not.toContain(secret);
    }
  });

  it("releases only the run-owned workspace when preflight fails", async () => {
    const released: string[] = [];
    const handle = fakeHandle([], released);

    await expect(
      runRailwayPreflightSpike({
        dependencies: {
          createGateway: () => fakeGateway(),
          createProvider: () => ({
            async create() {
              return handle;
            },
          }),
        },
        environment: enabledEnvironment(),
      }),
    ).rejects.toThrow("Submitted-project toolchain inspection");

    expect(released).toEqual(["railway-parent"]);
  });
});

function enabledEnvironment(): Record<string, string> {
  return {
    MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID: "env_canary",
    MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: "project-token",
    RUN_RAILWAY_SANDBOX_SPIKE: "1",
  };
}

function fakeHandle(
  uploaded: unknown[],
  released: string[],
): PreparationWorkspaceHandle {
  return {
    id: "railway-parent",
    async release() {
      released.push("railway-parent");
    },
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadFiles(files) {
        uploaded.push(files);
      },
    },
  };
}

function fakeGateway(): RailwaySandboxGateway {
  return {
    async createSandbox() {
      throw new Error("fake gateway must not be used by injected provider");
    },
    async destroySandbox() {
      throw new Error("fake gateway must not be used by injected provider");
    },
    async execute() {
      throw new Error("fake gateway must not be used by injected provider");
    },
    async readFile() {
      throw new Error("fake gateway must not be used by injected provider");
    },
    async writeFile() {
      throw new Error("fake gateway must not be used by injected provider");
    },
  };
}

function statefulRailwayGateway(): {
  gateway: RailwaySandboxGateway;
  inspectorCommands: string[];
} {
  const files = new Map<string, Map<string, Buffer>>([
    ["parent", new Map()],
    ["child", new Map()],
  ]);
  const inspectorCommands: string[] = [];
  let created = 0;
  const gateway: RailwaySandboxGateway = {
    async createSandbox() {
      created += 1;
      return { id: created === 1 ? "parent" : "child" };
    },
    async destroySandbox() {},
    async drainPendingCreations() {},
    async execute(sandbox, command) {
      const sandboxFiles = files.get(sandbox.id);
      if (sandboxFiles === undefined) throw new Error("Unknown fake sandbox.");
      let result = { exitCode: 0, stderr: "", stdout: "" };
      if (command.includes("makeademo-inspect-submitted-code-toolchain")) {
        inspectorCommands.push(command);
        const expected =
          "/opt/makeademo/toolchains/node/versions/22.23.1/bin/node /usr/local/bin/makeademo-inspect-submitted-code-toolchain";
        result =
          command === expected
            ? toolchainInspectionResult(sandboxFiles)
            : {
                exitCode: 127,
                stderr: "env: 'node': No such file or directory",
                stdout: "",
              };
      } else {
        const archivePath = command.match(/-czf '([^']+)'/)?.[1];
        if (archivePath !== undefined) {
          sandboxFiles.set(archivePath, Buffer.from("fake-workspace-archive"));
        }
        const removedPath = command.match(/^rm -f '([^']+)'$/)?.[1];
        if (removedPath !== undefined) sandboxFiles.delete(removedPath);
      }
      return {
        async kill() {},
        async result() {
          return { ...result, timedOut: false, truncated: false };
        },
      };
    },
    async readFile(sandbox, path) {
      const bytes = files.get(sandbox.id)?.get(path);
      if (bytes === undefined) throw new Error(`Missing fake file ${path}.`);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async writeFile(sandbox, path, content) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content()) chunks.push(chunk);
      files.get(sandbox.id)?.set(path, Buffer.concat(chunks));
    },
  };
  return { gateway, inspectorCommands };
}

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

function statefulPreflightHandle(
  options: { onRelease?: () => void; releaseError?: Error } = {},
): {
  events: string[];
  handle: PreparationWorkspaceHandle;
} {
  const events: string[] = [];
  const uploadedFiles = new Map<string, Buffer>();
  const handle: PreparationWorkspaceHandle = {
    id: "railway-parent",
    async release() {
      events.push("release");
      options.onRelease?.();
      if (options.releaseError !== undefined) throw options.releaseError;
    },
    workspace: {
      async downloadFiles(files) {
        for (const file of files) {
          const bytes = uploadedFiles.get(file.sourcePath);
          if (bytes === undefined) throw new Error("Missing parent artifact.");
          await mkdir(dirname(file.destinationPath), { recursive: true });
          await writeFile(file.destinationPath, bytes);
          events.push("screenshot:parent-to-report");
        }
      },
      async downloadSubmittedCodeFiles(files) {
        for (const file of files) {
          await mkdir(dirname(file.destinationPath), { recursive: true });
          await writeFile(file.destinationPath, pngBytes);
        }
      },
      async execute(command) {
        if (command !== "makeademo-inspect-submitted-code-toolchain") {
          throw new Error(`Unexpected parent command: ${command}`);
        }
        return toolchainInspectionResult(uploadedFiles);
      },
      async executeSubmittedCode(command) {
        if (command.includes("MAKEADEMO_BROWSER_VALIDATION")) {
          events.push("browser:http://127.0.0.1:4173/");
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              interactable: true,
              logs: [
                "Loaded http://127.0.0.1:4173/",
                "Captured screenshot proof.",
                "token=project-token",
                "RAILWAY_TOKEN=ambient-browser-token",
                "Authorization: Bearer browser-secret",
              ],
              screenshot: {
                mimeType: "image/png",
                path: "/workspace/.makeademo/validation-screenshot.png",
                sizeBytes: pngBytes.length,
              },
              screenshotArtifactId: "",
            }),
          };
        }
        if (command.startsWith("find /workspace")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: "package-lock.json\npackage.json\nserver.mjs\n",
          };
        }
        if (command.includes("makeademo-demo.log")) {
          return { exitCode: 0, stderr: "", stdout: "fixture ready\n" };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedRuntime(request) {
        events.push(
          `runtime:${request.command.includes("node server.mjs") ? "node server.mjs" : "unexpected"}`,
        );
        return { exitCode: 0, stderr: "", stdout: "123\n" };
      },
      async provisionSubmittedCodeToolchain(plan) {
        events.push(
          `provision:${plan.node.version}:${plan.packageManager?.name}@${plan.packageManager?.version}`,
        );
      },
      async syncSubmittedCodeWorkspace() {
        events.push("sync");
      },
      async uploadFiles(files) {
        for (const file of files) {
          const bytes = await readFile(file.sourcePath);
          uploadedFiles.set(file.destinationPath, bytes);
          if (
            file.destinationPath ===
            "/workspace/.makeademo/demo-runtime-preflight/browser.png"
          ) {
            events.push("screenshot:child-to-parent");
          }
        }
      },
    },
  };
  return { events, handle };
}

function serializeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return JSON.stringify({
      errors: error.errors.map(serializeError),
      message: error.message,
      name: error.name,
    });
  }
  if (error instanceof Error) {
    return JSON.stringify({ message: error.message, name: error.name });
  }
  return JSON.stringify(error);
}

function toolchainInspectionResult(uploadedFiles: Map<string, Buffer>) {
  const packageJson = uploadedFiles.get("/workspace/package.json")?.toString();
  const packageLock = uploadedFiles.get("/workspace/package-lock.json");
  if (packageJson === undefined || packageLock === undefined) {
    throw new Error("Fixture metadata was not uploaded.");
  }
  return {
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      candidates: [
        {
          files: {
            "package-lock.json": {
              kind: "canonical-lockfile",
              prefixBase64: packageLock.toString("base64"),
              sha256: `sha256:${createHash("sha256").update(packageLock).digest("hex")}`,
              size: packageLock.length,
            },
            "package.json": packageJson,
          },
          projectRoot: ".",
        },
      ],
    }),
  };
}

class FakeCliProcess extends EventEmitter {
  exitCode: number | undefined;
  stderrWrites: string[] = [];
  stdoutWrites: string[] = [];
  stderr = { write: (value: string) => this.stderrWrites.push(value) };
  stdout = { write: (value: string) => this.stdoutWrites.push(value) };
}
