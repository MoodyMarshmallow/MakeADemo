import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { RailwaySandboxGatewaySandbox } from "../src/server/shared/integrations/railway/railway-sandbox-gateway.interface";
import { RailwaySdkSandboxGateway } from "../src/server/shared/integrations/railway/railway-sdk-sandbox-gateway";

const liveGate = "RUN_RAILWAY_SANDBOX_CROSS_PROCESS_ISOLATION";
const projectTokenVariable = "MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN";
const environmentIdVariable = "MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID";
const markerPath = "/tmp/makeademo-cross-process-isolation-marker";
const operationTimeoutMs = 180_000;

type WorkerCommand =
  | { type: "cleanup" }
  | { type: "create-preparation" }
  | { type: "create-security" }
  | { type: "verify" }
  | { type: "write" };

type WorkerResponse = Readonly<{
  count?: number;
  ids?: readonly string[];
  ok: boolean;
  type: string;
}>;

if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await runParent();
}

async function runParent(): Promise<void> {
  const configuration = readConfiguration();
  const workers: WorkerClient[] = [];
  try {
    workers.push(await WorkerClient.start("process-a", configuration));
    workers.push(await WorkerClient.start("process-b", configuration));
  } catch (error) {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    throw error;
  }
  let operationFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const security = await Promise.all(
      workers.map((worker) => worker.command({ type: "create-security" })),
    );
    const preparation = await Promise.all(
      workers.map((worker) => worker.command({ type: "create-preparation" })),
    );
    const ids = [...security, ...preparation].flatMap(
      (response) => response.ids ?? [],
    );
    if (ids.length !== 6 || new Set(ids).size !== 6) {
      throw new Error(
        "Railway cross-process isolation did not return six distinct sandbox identities.",
      );
    }

    await Promise.all(
      workers.map((worker) => worker.command({ type: "write" })),
    );
    const verification = await Promise.all(
      workers.map((worker) => worker.command({ type: "verify" })),
    );
    const verifiedWrites = verification.reduce(
      (total, response) => total + (response.count ?? 0),
      0,
    );
    if (verifiedWrites !== 6) {
      throw new Error(
        "Railway cross-process isolation did not verify all six sandbox writes.",
      );
    }
    if (verifiedWrites !== ids.length) {
      throw new Error("Railway cross-process isolation write count changed.");
    }
  } catch (error) {
    operationFailure = error;
  } finally {
    const cleanup = await Promise.allSettled(
      workers.map((worker) => worker.command({ type: "cleanup" })),
    );
    if (cleanup.some((result) => result.status === "rejected")) {
      cleanupFailure = new Error(
        "Railway cross-process isolation exact-id cleanup failed.",
      );
    }
    await Promise.allSettled(workers.map((worker) => worker.close()));
  }

  if (operationFailure !== undefined || cleanupFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, cleanupFailure].filter(
        (error): error is unknown => error !== undefined,
      ),
      "Railway cross-process isolation harness failed.",
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      cleanup: "exact-ids-destroyed",
      createdIdentityCount: 6,
      isolatedWriteCount: 6,
      status: "passed",
    })}\n`,
  );
}

async function runWorker(): Promise<void> {
  const configuration = readConfiguration();
  const workerName = process.argv.at(-1);
  if (workerName !== "process-a" && workerName !== "process-b") {
    throw new Error("Railway isolation worker requires a known worker name.");
  }
  const gateway = new RailwaySdkSandboxGateway({
    environmentId: configuration.environmentId,
    projectToken: configuration.projectToken,
    railwayAgentSession: `railway-cross-process-isolation-${workerName}`,
    railwayCaller: "makeademo:railway-cross-process-isolation",
  });
  const sandboxes: RailwaySandboxGatewaySandbox[] = [];
  const markers = new Map<string, string>();
  const input = createInterface({ input: process.stdin });
  sendWorkerResponse({ ok: true, type: "ready" });

  for await (const line of input) {
    let command: WorkerCommand;
    try {
      command = JSON.parse(line) as WorkerCommand;
      if (command.type === "create-security") {
        const sandbox = await createOne(gateway);
        sandboxes.push(sandbox);
        sendWorkerResponse({ ids: [sandbox.id], ok: true, type: command.type });
      } else if (command.type === "create-preparation") {
        const settlements = await Promise.allSettled([
          createOne(gateway),
          createOne(gateway),
        ]);
        const created = settlements.flatMap((settlement) =>
          settlement.status === "fulfilled" ? [settlement.value] : [],
        );
        sandboxes.push(...created);
        if (created.length !== 2) {
          throw new Error("Preparation sandbox creation failed.");
        }
        sendWorkerResponse({
          ids: created.map((sandbox) => sandbox.id),
          ok: true,
          type: command.type,
        });
      } else if (command.type === "write") {
        await Promise.all(
          sandboxes.map(async (sandbox, index) => {
            const marker = `${workerName}:${index}`;
            markers.set(sandbox.id, marker);
            await gateway.writeFile(
              sandbox,
              markerPath,
              () => oneChunk(marker),
              { timeoutMs: operationTimeoutMs },
            );
          }),
        );
        sendWorkerResponse({
          count: sandboxes.length,
          ok: true,
          type: command.type,
        });
      } else if (command.type === "verify") {
        for (const sandbox of sandboxes) {
          const contents = await streamText(
            await gateway.readFile(sandbox, markerPath, {
              timeoutMs: operationTimeoutMs,
            }),
          );
          if (contents !== markers.get(sandbox.id)) {
            throw new Error("Sandbox marker did not remain isolated.");
          }
        }
        sendWorkerResponse({
          count: sandboxes.length,
          ok: true,
          type: command.type,
        });
      } else if (command.type === "cleanup") {
        const cleanup = await Promise.allSettled(
          sandboxes.map((sandbox) => gateway.destroySandbox(sandbox)),
        );
        await gateway.drainPendingCreations({ timeoutMs: operationTimeoutMs });
        if (cleanup.some((result) => result.status === "rejected")) {
          throw new Error("Exact-id sandbox cleanup failed.");
        }
        sendWorkerResponse({
          count: sandboxes.length,
          ok: true,
          type: command.type,
        });
        input.close();
      } else {
        throw new Error("Unknown Railway isolation worker command.");
      }
    } catch {
      sendWorkerResponse({ ok: false, type: "operation-failed" });
    }
  }
}

async function createOne(
  gateway: RailwaySdkSandboxGateway,
): Promise<RailwaySandboxGatewaySandbox> {
  return gateway.createSandbox({
    env: {},
    idleTimeoutMinutes: 15,
    networkIsolation: "ISOLATED",
    timeoutMs: operationTimeoutMs,
  });
}

class WorkerClient {
  private readonly pending: Array<{
    reject(error: unknown): void;
    resolve(response: WorkerResponse): void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly responses: WorkerResponse[] = [];
  private exited = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        this.responses.push(JSON.parse(line) as WorkerResponse);
        this.flush();
      } catch {
        this.rejectAll(
          new Error("Railway isolation worker emitted invalid output."),
        );
      }
    });
    child.once("error", () => {
      this.rejectAll(new Error("Railway isolation worker could not start."));
    });
    child.once("exit", (code) => {
      this.exited = true;
      if (code !== 0) {
        this.rejectAll(
          new Error("Railway isolation worker exited unsuccessfully."),
        );
      }
    });
  }

  static async start(
    name: "process-a" | "process-b",
    configuration: { environmentId: string; projectToken: string },
  ): Promise<WorkerClient> {
    const child = spawn(
      process.execPath,
      [import.meta.filename, "--worker", name],
      {
        env: {
          [environmentIdVariable]: configuration.environmentId,
          [liveGate]: "1",
          [projectTokenVariable]: configuration.projectToken,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const client = new WorkerClient(child);
    const ready = await client.nextResponse();
    if (!ready.ok || ready.type !== "ready") {
      throw new Error("Railway isolation worker did not become ready.");
    }
    return client;
  }

  async command(command: WorkerCommand): Promise<WorkerResponse> {
    if (this.exited) {
      throw new Error("Railway isolation worker exited before its command.");
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    const response = await this.nextResponse();
    if (!response.ok || response.type !== command.type) {
      throw new Error("Railway isolation worker operation failed.");
    }
    return response;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) =>
      this.child.once("exit", () => resolve()),
    );
  }

  private nextResponse(): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Railway isolation worker operation timed out."));
      }, operationTimeoutMs);
      timer.unref?.();
      this.pending.push({ reject, resolve, timer });
      this.flush();
    });
  }

  private flush(): void {
    while (this.pending.length > 0 && this.responses.length > 0) {
      const pending = this.pending.shift();
      const response = this.responses.shift();
      if (pending === undefined || response === undefined) return;
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function readConfiguration(): { environmentId: string; projectToken: string } {
  if (process.env[liveGate] !== "1") {
    throw new Error(`Railway cross-process isolation requires ${liveGate}=1.`);
  }
  const projectToken = process.env[projectTokenVariable]?.trim();
  const environmentId = process.env[environmentIdVariable]?.trim();
  if (!projectToken || !environmentId) {
    throw new Error(
      `Railway cross-process isolation requires ${projectTokenVariable} and ${environmentIdVariable}.`,
    );
  }
  return { environmentId, projectToken };
}

async function* oneChunk(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return text + decoder.decode();
    text += decoder.decode(next.value, { stream: true });
  }
}

function sendWorkerResponse(response: WorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
