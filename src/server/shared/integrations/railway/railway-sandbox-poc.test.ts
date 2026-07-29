import { createHash } from "node:crypto";
import { type ExecResult, Sandbox, type SandboxStatus } from "railway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readRailwayPocConfiguration } from "./railway-sandbox-poc-safety";

const railwayPocConfiguration = readRailwayPocConfiguration();
const projectToken = railwayPocConfiguration?.projectToken;
const environmentId = railwayPocConfiguration?.environmentId;
const enabled = railwayPocConfiguration !== undefined;
const describeRailway = describe.skipIf(!enabled);

function getSdkOptions(): {
  authType: "project-token";
  environmentId: string;
  token: string;
} {
  if (!projectToken || !environmentId) {
    throw new Error(
      "Railway POC requires MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN and MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID.",
    );
  }
  return { authType: "project-token", environmentId, token: projectToken };
}

const trackedSandboxes = new Set<Sandbox>();
const destroyRequestedSandboxIds = new Set<string>();
let baselineSandboxIds = new Set<string>();
let baselineCaptured = false;

async function createSandbox(
  options: { networkIsolation?: "ISOLATED" | "PRIVATE" } = {},
): Promise<Sandbox> {
  const sandbox = await Sandbox.create({ ...getSdkOptions(), ...options });
  trackedSandboxes.add(sandbox);
  return sandbox;
}

async function destroySandbox(
  sandbox: Sandbox,
  options: { forceDestroy?: boolean; waitOnly?: boolean } = {},
): Promise<void> {
  if (
    !options.waitOnly &&
    !destroyRequestedSandboxIds.has(sandbox.id) &&
    (options.forceDestroy ||
      (isLiveSandboxStatus(sandbox.status) && sandbox.status !== "DESTROYING"))
  ) {
    await sandbox.destroy();
    destroyRequestedSandboxIds.add(sandbox.id);
  }
  await waitForSandboxNonLive(sandbox.id);
  trackedSandboxes.delete(sandbox);
}

async function waitForSandboxNonLive(id: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const listed = (await listSandboxes()).find((entry) => entry.id === id);
    if (!listed || !isLiveSandboxStatus(listed.status)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Sandbox ${id} remained ${listed.status} after destroy.`);
    }
    await delay(500);
  }
}

function isLiveSandboxStatus(status: SandboxStatus): boolean {
  return (
    status === "CREATING" || status === "RUNNING" || status === "DESTROYING"
  );
}

function listSandboxes() {
  return Sandbox.list({ ...getSdkOptions(), first: 100 });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hashStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ byteLength: number; sha256: string }> {
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let byteLength = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    hash.update(next.value);
    byteLength += next.value.byteLength;
  }

  return { byteLength, sha256: hash.digest("hex") };
}

function deterministicChunk(offset: number, byteLength: number): Uint8Array {
  const chunk = new Uint8Array(byteLength);
  for (let index = 0; index < chunk.length; index += 1) {
    chunk[index] = (offset + index) % 251;
  }
  return chunk;
}

function hashDeterministicBytes(byteLength: number): string {
  const hash = createHash("sha256");
  for (let offset = 0; offset < byteLength; offset += 8192) {
    hash.update(
      deterministicChunk(offset, Math.min(8192, byteLength - offset)),
    );
  }
  return hash.digest("hex");
}

describeRailway("Railway Sandbox TypeScript SDK proof of concept", () => {
  beforeAll(async () => {
    baselineSandboxIds = new Set(
      (await listSandboxes()).map((sandbox) => sandbox.id),
    );
    baselineCaptured = true;
  });

  afterAll(async () => {
    if (!baselineCaptured) return;

    const cleanupErrors: unknown[] = [];
    const trackedById = new Map<string, Sandbox>(
      [...trackedSandboxes].map((sandbox) => [sandbox.id, sandbox]),
    );
    const trackedIds = new Set(trackedById.keys());
    const candidates = new Map<string, Sandbox>();
    const forceDestroyIds = new Set<string>();
    const waitOnlyIds = new Set<string>();

    for (const sandbox of trackedById.values()) {
      if (
        !baselineSandboxIds.has(sandbox.id) &&
        isLiveSandboxStatus(sandbox.status)
      ) {
        candidates.set(sandbox.id, sandbox);
      }
    }

    try {
      const listed = await listSandboxes();
      for (const entry of listed) {
        if (
          baselineSandboxIds.has(entry.id) ||
          !isLiveSandboxStatus(entry.status)
        ) {
          continue;
        }
        const tracked = trackedById.get(entry.id);
        if (!tracked) {
          continue;
        }
        if (entry.status === "DESTROYING") {
          waitOnlyIds.add(entry.id);
        } else {
          forceDestroyIds.add(entry.id);
        }
        candidates.set(entry.id, tracked);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    const cleanupResults = await Promise.allSettled(
      [...candidates.values()].map((sandbox) =>
        destroySandbox(sandbox, {
          forceDestroy: forceDestroyIds.has(sandbox.id),
          waitOnly: waitOnlyIds.has(sandbox.id),
        }),
      ),
    );
    for (const result of cleanupResults) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }

    try {
      const remaining = (await listSandboxes()).filter(
        (sandbox) =>
          trackedIds.has(sandbox.id) &&
          !baselineSandboxIds.has(sandbox.id) &&
          isLiveSandboxStatus(sandbox.status),
      );
      if (remaining.length > 0) {
        cleanupErrors.push(
          new Error(
            `Railway POC cleanup left new sandboxes: ${remaining
              .map((sandbox) => sandbox.id)
              .join(", ")}`,
          ),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Railway POC cleanup failed.");
    }
  }, 180_000);

  it("creates two isolated sandboxes simultaneously, reconnects/lists them, and destroys them", async () => {
    const sandboxes = await Promise.all([createSandbox(), createSandbox()]);
    try {
      expect(sandboxes.map((sandbox) => sandbox.networkIsolation)).toEqual([
        "ISOLATED",
        "ISOLATED",
      ]);
      expect(sandboxes.map((sandbox) => sandbox.environmentId)).toEqual([
        environmentId,
        environmentId,
      ]);
      expect(sandboxes[0]?.id).not.toBe(sandboxes[1]?.id);

      for (const sandbox of sandboxes) {
        const reconnected = await Sandbox.connect(sandbox.id, getSdkOptions());
        expect(reconnected.id).toBe(sandbox.id);
      }
      const listed = await listSandboxes();
      for (const sandbox of sandboxes) {
        expect(listed.some((entry) => entry.id === sandbox.id)).toBe(true);
      }
    } finally {
      await Promise.all(sandboxes.map((sandbox) => destroySandbox(sandbox)));
    }
  }, 180_000);

  it("streams stdout and stderr from an exec", async () => {
    const sandbox = await createSandbox();
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await sandbox.exec(
        "printf 'stdout\\n'; printf 'stderr\\n' >&2",
        {
          onStdout: (chunk) => stdout.push(chunk),
          onStderr: (chunk) => stderr.push(chunk),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(stdout.join("")).toContain("stdout");
      expect(stderr.join("")).toContain("stderr");
      expect(result.timedOut).toBe(false);
    } finally {
      await destroySandbox(sandbox);
    }
  }, 180_000);

  it("reattaches a detached durable exec by session name", async () => {
    const sandbox = await createSandbox();
    try {
      const handle = sandbox.exec("sleep 1; printf 'detached\\n'");
      const sessionName = await handle.sessionName;
      await handle.detach();

      const reconnected = await Sandbox.connect(sandbox.id, getSdkOptions());
      const output: string[] = [];
      const result = await reconnected.exec(
        { sessionName },
        { onStdout: (chunk) => output.push(chunk), resumeFromLastRead: true },
      );

      expect(result.exitCode).toBe(0);
      expect(output.join("")).toContain("detached");
    } finally {
      await destroySandbox(sandbox);
    }
  }, 180_000);

  it("kills a running process group and waits for settlement", async () => {
    const sandbox = await createSandbox();
    try {
      const pidPath = "/tmp/makeademo-railway-kill-pids";
      const handle = sandbox.exec(
        `sh -c 'sleep 60 & child=$!; printf "%s %s\\n" "$$" "$child" > ${pidPath}; wait "$child"'`,
      );
      const pidText = await waitForFile(sandbox, pidPath);
      const pids = pidText
        .trim()
        .split(/\s+/)
        .map((pid) => Number(pid));
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);

      const [parentPid, childPid] = pids;
      if (!parentPid || !childPid) {
        throw new Error("Kill check requires parent and child PIDs.");
      }
      const [parentStat, childStat] = await Promise.all([
        readProcessStat(sandbox, parentPid),
        readProcessStat(sandbox, childPid),
      ]);
      if (!parentStat || !childStat) {
        throw new Error("Parent or child exited before the kill check began.");
      }
      expect(childStat.processGroupId).toBe(parentStat.processGroupId);
      expect(childStat.sessionId).toBe(parentStat.sessionId);
      expect(parentStat.processGroupId).toBe(parentPid);
      expect(parentStat.sessionId).toBe(parentPid);

      const startedAt = Date.now();
      await expect(handle.kill("TERM")).resolves.toBe(true);
      const result = await handle;
      await Promise.all([
        waitForOriginalProcessNonLive(
          sandbox,
          parentPid,
          parentStat.startTimeTicks,
        ),
        waitForOriginalProcessNonLive(
          sandbox,
          childPid,
          childStat.startTimeTicks,
        ),
      ]);

      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(result.exitCode).toBe(-1);
      expect(result.timedOut).toBe(false);
    } finally {
      await destroySandbox(sandbox);
    }
  }, 180_000);

  it("round-trips text, binary, and streaming files", async () => {
    const sandbox = await createSandbox();
    try {
      await sandbox.files.write("/tmp/makeademo-poc.txt", "hello railway");
      await expect(sandbox.files.read("/tmp/makeademo-poc.txt")).resolves.toBe(
        "hello railway",
      );

      const binary = Uint8Array.from([0, 1, 2, 127, 128, 255]);
      await sandbox.files.write("/tmp/makeademo-poc.bin", binary);
      await expect(
        sandbox.files.read("/tmp/makeademo-poc.bin", { format: "bytes" }),
      ).resolves.toEqual(binary);

      const streamBytes = Number(
        process.env.RAILWAY_POC_STREAM_BYTES ?? 67_108_864,
      );
      expect(Number.isSafeInteger(streamBytes) && streamBytes > 0).toBe(true);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (let offset = 0; offset < streamBytes; offset += 8192) {
          yield deterministicChunk(
            offset,
            Math.min(8192, streamBytes - offset),
          );
        }
      }
      await sandbox.files.write("/tmp/makeademo-poc-large.bin", () => chunks());
      const actual = await hashStream(
        await sandbox.files.read("/tmp/makeademo-poc-large.bin", {
          format: "stream",
        }),
      );
      expect(actual.byteLength).toBe(streamBytes);
      expect(actual.sha256).toBe(hashDeterministicBytes(streamBytes));
    } finally {
      await destroySandbox(sandbox);
    }
  }, 180_000);

  it("destroys a sandbox in an injected provisioning failure", async () => {
    const sandbox = await createSandbox();
    try {
      throw new Error("injected provisioning failure");
    } catch (error) {
      expect(error).toEqual(new Error("injected provisioning failure"));
    } finally {
      await destroySandbox(sandbox);
    }
  }, 180_000);

  it("allows configured public HTTPS egress", async () => {
    const sandbox = await createSandbox();
    try {
      const urls = (
        process.env.RAILWAY_POC_PUBLIC_URLS ??
        "https://registry.npmjs.org/ https://registry.yarnpkg.com/ https://nodejs.org/ https://binaries.prisma.sh/ https://playwright.azureedge.net/ https://fonts.googleapis.com/"
      )
        .split(/[,\s]+/)
        .filter(Boolean);
      for (const url of urls) {
        const result = await sandbox.exec(
          `curl -sSL --max-time 20 -o /dev/null -w '%{http_code}' ${quote(url)}`,
        );
        expect(
          result.exitCode,
          `public egress failed for ${url}: ${result.stderr}`,
        ).toBe(0);
        expect(result.stdout, `no HTTP response from ${url}`).toMatch(
          /^[1-5]\d{2}$/,
        );
      }
    } finally {
      await destroySandbox(sandbox);
    }
  }, 180_000);

  it("allows PRIVATE networking while denying the same private target to ISOLATED sandboxes", async ({
    skip,
  }) => {
    const privateHost = process.env.RAILWAY_POC_PRIVATE_HOST;
    if (!privateHost) {
      skip(
        "Set RAILWAY_POC_PRIVATE_HOST to a Railway private DNS host to verify isolation.",
      );
      return;
    }
    const [privateSandbox, isolatedSandboxA, isolatedSandboxB] =
      await Promise.all([
        createSandbox({ networkIsolation: "PRIVATE" }),
        createSandbox({ networkIsolation: "ISOLATED" }),
        createSandbox({ networkIsolation: "ISOLATED" }),
      ]);
    try {
      expect(privateSandbox.networkIsolation).toBe("PRIVATE");
      expect(isolatedSandboxA.networkIsolation).toBe("ISOLATED");
      expect(isolatedSandboxB.networkIsolation).toBe("ISOLATED");

      const privateResult = await privateSandbox.exec(
        `curl -fsSL --connect-timeout 5 --max-time 10 -o /dev/null ${quote(privateHost)}`,
      );
      expect(privateResult.exitCode, privateResult.stderr).toBe(0);

      for (const sandbox of [isolatedSandboxA, isolatedSandboxB]) {
        const result = await sandbox.exec(
          `curl -fsSL --connect-timeout 5 --max-time 10 -o /dev/null ${quote(privateHost)}`,
        );
        expect(result.exitCode).not.toBe(0);
      }
    } finally {
      await Promise.all(
        [privateSandbox, isolatedSandboxA, isolatedSandboxB].map((sandbox) =>
          destroySandbox(sandbox),
        ),
      );
    }
  }, 180_000);

  it("can download a localhost screenshot when screenshot tooling is supplied", async ({
    skip,
  }) => {
    const screenshotCommand = process.env.RAILWAY_POC_SCREENSHOT_COMMAND;
    if (!screenshotCommand) {
      skip(
        "Set RAILWAY_POC_SCREENSHOT_COMMAND to enable the optional Playwright screenshot check.",
      );
      return;
    }

    const sandbox = await createSandbox();
    const screenshotPath =
      process.env.RAILWAY_POC_SCREENSHOT_PATH ??
      "/tmp/makeademo-railway-poc.png";
    let server: ReturnType<Sandbox["exec"]> | undefined;
    try {
      await sandbox.files.write(
        "/tmp/makeademo-railway-poc.html",
        "<!doctype html><title>MakeADemo Railway POC</title><h1>Railway localhost</h1>",
      );
      server = sandbox.exec(
        'node -e \'const fs=require("fs"),http=require("http");http.createServer((_,res)=>res.end(fs.readFileSync("/tmp/makeademo-railway-poc.html"))).listen(4173,"127.0.0.1")\'',
      );
      const ready = await waitForExecSuccess(
        sandbox,
        "curl -fsS --max-time 2 http://127.0.0.1:4173/",
      );
      expect(ready.exitCode).toBe(0);

      const screenshot = await sandbox.exec(screenshotCommand);
      expect(screenshot.exitCode, screenshot.stderr).toBe(0);
      const png = await sandbox.files.read(screenshotPath, { format: "bytes" });
      expect(Array.from(png.slice(0, 8))).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
    } finally {
      if (server) {
        await server.kill("TERM");
        await server;
      }
      await destroySandbox(sandbox);
    }
  }, 180_000);
});

async function waitForFile(sandbox: Sandbox, path: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await sandbox.files.read(path);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

type ProcessStat = {
  processGroupId: number;
  sessionId: number;
  startTimeTicks: string;
  state: string;
};

async function readProcessStat(
  sandbox: Sandbox,
  pid: number,
): Promise<ProcessStat | null> {
  const result = await sandbox.exec(
    `if [ -r /proc/${pid}/stat ]; then awk '{ print $3, $5, $6, $22 }' /proc/${pid}/stat 2>/dev/null || true; fi`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect process ${pid}: ${result.stderr}`);
  }
  const output = result.stdout.trim();
  if (!output) return null;
  const [state, processGroupIdText, sessionIdText, startTimeTicks] =
    output.split(/\s+/);
  const processGroupId = Number(processGroupIdText);
  const sessionId = Number(sessionIdText);
  if (
    !state ||
    !startTimeTicks ||
    !Number.isInteger(processGroupId) ||
    !Number.isInteger(sessionId)
  ) {
    throw new Error(`Malformed /proc/${pid}/stat: ${output}`);
  }
  return { processGroupId, sessionId, startTimeTicks, state };
}

async function waitForOriginalProcessNonLive(
  sandbox: Sandbox,
  pid: number,
  startTimeTicks: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const stat = await readProcessStat(sandbox, pid);
    if (!stat || stat.startTimeTicks !== startTimeTicks || stat.state === "Z") {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Process ${pid}:${startTimeTicks} remained live in state ${stat.state}.`,
      );
    }
    await delay(100);
  }
}

async function waitForExecSuccess(
  sandbox: Sandbox,
  command: string,
): Promise<ExecResult> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await sandbox.exec(command);
    if (result.exitCode === 0) return result;
    if (Date.now() >= deadline) {
      throw new Error(
        `Command did not become ready: ${command}\n${result.stderr}`,
      );
    }
    await delay(250);
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
