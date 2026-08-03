import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createBenchmarkProcessController,
  parseBenchmarkTimeout,
  runBenchmarkProcess,
} from "./benchmark-process-lifecycle";

describe("benchmark process lifecycle", () => {
  it("cancels every active child exactly once and excludes completed jobs", async () => {
    const controller = createBenchmarkProcessController();
    const signals: string[] = [];
    const reasons: string[] = [];
    let releaseFirst!: () => void;
    const unregisterFirst = controller.register(
      (reason) =>
        new Promise<void>((resolve) => {
          signals.push("first");
          reasons.push(reason);
          releaseFirst = resolve;
        }),
    );
    const unregisterSecond = controller.register(async (reason) => {
      signals.push("second");
      reasons.push(reason);
    });
    unregisterSecond();

    const cancellation = controller.cancelAll("signal");
    expect(controller.cancelAll("deadline")).toBe(cancellation);
    expect(signals).toEqual(["first"]);
    expect(reasons).toEqual(["signal"]);
    releaseFirst();
    await cancellation;
    unregisterFirst();
    expect(signals).toEqual(["first"]);
  });

  it("terminates a child registered after signal cancellation with the original reason", async () => {
    const controller = createBenchmarkProcessController();
    await controller.cancelAll("signal");
    const reasons: string[] = [];

    const unregister = controller.register(async (reason) => {
      reasons.push(reason);
    });
    await controller.cancelAll("deadline");

    expect(reasons).toEqual(["signal"]);
    unregister();
  });

  it("reaps multiple detached children when the shared controller is cancelled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-liveness-"));
    const controller = createBenchmarkProcessController();
    const children = Promise.all(
      ["one", "two"].map((name) =>
        runBenchmarkProcess({
          args: ["-e", "setInterval(() => {}, 1000)"],
          stdoutPath: join(dir, `${name}.out`),
          stderrPath: join(dir, `${name}.err`),
          deadlineAt: Date.now() + 10_000,
          cleanupGraceMs: 10,
          killGraceMs: 10,
          controller,
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await controller.cancelAll();
    await expect(children).resolves.toEqual([
      { exitCode: null, killed: true, terminationReason: "signal" },
      { exitCode: null, killed: true, terminationReason: "signal" },
    ]);
  });

  it("reaps an active child when its propagated AbortSignal fires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-abort-active-"));
    const controller = new AbortController();
    const running = runBenchmarkProcess({
      args: ["-e", "setInterval(() => {}, 1000)"],
      cleanupGraceMs: 10,
      deadlineAt: Date.now() + 10_000,
      signal: controller.signal,
      stderrPath: join(dir, "err"),
      stdoutPath: join(dir, "out"),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("benchmark interrupted"));

    await expect(running).resolves.toMatchObject({
      killed: true,
      terminationReason: "signal",
    });
  });

  it("reaps a result-producing hung child after grace and preserves the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-liveness-"));
    const result = join(dir, "result.json");
    await writeFile(result, JSON.stringify({ status: "succeeded" }));
    const outcome = await runBenchmarkProcess({
      args: [
        "-e",
        `console.log("Result JSON: ${result}"); setInterval(() => {}, 1000)`,
      ],
      stdoutPath: join(dir, "stdout.log"),
      stderrPath: join(dir, "stderr.log"),
      deadlineAt: Date.now() + 2_000,
      resultGraceMs: 10,
      killGraceMs: 10,
    });
    expect(outcome.killed).toBe(true);
    expect(outcome.terminationReason).toBe("result-grace");
    expect(outcome.resultPath).toBe(result);
    expect(await readFile(join(dir, "stdout.log"), "utf8")).toContain(
      "Result JSON:",
    );
  });

  it("does not signal a naturally exiting child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-liveness-"));
    const outcome = await runBenchmarkProcess({
      args: ["-e", "console.log('ok')"],
      stdoutPath: join(dir, "out"),
      stderrPath: join(dir, "err"),
      deadlineAt: Date.now() + 1000,
    });
    expect(outcome).toMatchObject({ exitCode: 0, killed: false });
    expect(outcome).not.toHaveProperty("terminationReason");
  });

  it("admits a result when a detached descendant keeps inherited fd3 open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-inherited-fd3-"));
    const result = join(dir, "result.json");
    const events: unknown[] = [];
    const controlEvent = {
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-08-03T00:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
      type: "agent-task.provider-retry",
      v: 1,
    };
    const running = runBenchmarkProcess({
      args: [
        "-e",
        `import { spawn } from "node:child_process"; import { writeFileSync, writeSync } from "node:fs"; const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 750)"], { detached: true, stdio: ["ignore", "ignore", "ignore", 3] }); descendant.unref(); writeSync(3, ${JSON.stringify(`${JSON.stringify(controlEvent)}\n`)}); writeFileSync(${JSON.stringify(result)}, JSON.stringify({ status: "succeeded" })); console.log(${JSON.stringify(`Result JSON: ${result}`)});`,
      ],
      deadlineAt: Date.now() + 2_000,
      onControlEvent: (event) => events.push(event),
      stderrPath: join(dir, "stderr.log"),
      stdoutPath: join(dir, "stdout.log"),
    });

    await waitForAccessiblePath(result);
    const promptOutcome = await Promise.race([
      running,
      new Promise<"still-waiting-for-fd3">((resolve) =>
        setTimeout(() => resolve("still-waiting-for-fd3"), 200),
      ),
    ]);
    await running;

    expect(promptOutcome).toMatchObject({
      exitCode: 0,
      killed: false,
      resultPath: result,
    });
    expect(events).toEqual([controlEvent]);
  });

  it("drains a final complete control frame queued behind fd3 backpressure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-fd3-drain-"));
    const result = join(dir, "result.json");
    const events: unknown[] = [];
    const finalControlEvent = {
      occurredAt: "2026-08-03T00:00:00.000Z",
      type: "benchmark.daytona-provisioning-succeeded",
      v: 1,
    };
    const running = runBenchmarkProcess({
      args: [
        "-e",
        `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const descendantScript = ${JSON.stringify(`const { writeSync } = require("node:fs"); process.once("message", () => { writeSync(3, '{"ignored":true}\\n'.repeat(4_096)); writeSync(3, ${JSON.stringify(`${JSON.stringify(finalControlEvent)}\n`)}); setTimeout(() => {}, 750); });`)}; const descendant = spawn(process.execPath, ["-e", descendantScript], { detached: true, stdio: ["ignore", "ignore", "ignore", 3, "ipc"] }); descendant.once("spawn", () => { descendant.send("flush", () => { descendant.disconnect(); descendant.unref(); writeFileSync(${JSON.stringify(result)}, JSON.stringify({ status: "succeeded" })); console.log(${JSON.stringify(`Result JSON: ${result}`)}); }); });`,
      ],
      deadlineAt: Date.now() + 3_000,
      onControlEvent: (event) => events.push(event),
      stderrPath: join(dir, "stderr.log"),
      stdoutPath: join(dir, "stdout.log"),
    });

    await waitForAccessiblePath(result);
    const promptOutcome = await Promise.race([
      running,
      new Promise<"still-waiting-for-fd3">((resolve) =>
        setTimeout(() => resolve("still-waiting-for-fd3"), 300),
      ),
    ]);
    await running;

    expect(promptOutcome).toMatchObject({
      exitCode: 0,
      resultPath: result,
    });
    expect(events).toEqual([finalControlEvent]);
  });

  it("does not spawn a child when cancellation is observed before process setup completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-abort-before-spawn-"));
    const marker = join(dir, "spawned");
    const controller = new AbortController();
    controller.abort(new Error("benchmark interrupted"));

    await expect(
      runBenchmarkProcess({
        args: [
          "-e",
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned")`,
        ],
        deadlineAt: Date.now() + 1_000,
        signal: controller.signal,
        stderrPath: join(dir, "err"),
        stdoutPath: join(dir, "out"),
      }),
    ).rejects.toThrow("benchmark interrupted");
    await expect(access(marker)).rejects.toThrow();
  });

  it("does not spawn a child when its deadline has already elapsed", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "benchmark-deadline-before-spawn-"),
    );
    const marker = join(dir, "spawned");

    await expect(
      runBenchmarkProcess({
        args: [
          "-e",
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned")`,
        ],
        deadlineAt: Date.now(),
        stderrPath: join(dir, "err"),
        stdoutPath: join(dir, "out"),
      }),
    ).rejects.toThrow("Benchmark process deadline was reached before spawn.");
    await expect(access(marker)).rejects.toThrow();
  });

  it("reads only validated provider retry control frames from fd3", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-control-"));
    const events: unknown[] = [];
    await runBenchmarkProcess({
      args: [
        "-e",
        `import { writeSync } from "node:fs"; writeSync(3, ${JSON.stringify(
          `${JSON.stringify({
            attempt: 1,
            maxAttempts: 5,
            occurredAt: "2026-07-31T00:00:00.000Z",
            reason: "rate-limit",
            requestedDelayMs: 2000,
            type: "agent-task.provider-retry",
            v: 1,
          })}\n${JSON.stringify({ message: "raw provider error" })}\n`,
        )});`,
      ],
      deadlineAt: Date.now() + 1_000,
      onControlEvent: (event) => events.push(event),
      stderrPath: join(dir, "err"),
      stdoutPath: join(dir, "out"),
    });

    expect(events).toEqual([
      {
        attempt: 1,
        maxAttempts: 5,
        occurredAt: "2026-07-31T00:00:00.000Z",
        reason: "rate-limit",
        requestedDelayMs: 2_000,
        type: "agent-task.provider-retry",
        v: 1,
      },
    ]);
  });

  it("keeps fragmented framing bounded and recovers after malformed or oversized fd3 frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-control-framing-"));
    const events: unknown[] = [];
    const valid = JSON.stringify({
      attempt: 1,
      maxAttempts: 5,
      occurredAt: "2026-07-31T00:00:00.000Z",
      reason: "rate-limit",
      requestedDelayMs: 2_000,
      type: "agent-task.provider-retry",
      v: 1,
    });
    await runBenchmarkProcess({
      args: [
        "-e",
        `import { writeSync } from "node:fs"; const chunks = ${JSON.stringify([
          valid.slice(0, 15),
          `${valid.slice(15)}\n{bad json}\n`,
          `${"x".repeat(64 * 1024 + 1)}\n`,
          `${valid}\n`,
          valid,
        ])}; for (const chunk of chunks) writeSync(3, chunk);`,
      ],
      deadlineAt: Date.now() + 1_000,
      onControlEvent: (event) => events.push(event),
      stderrPath: join(dir, "err"),
      stdoutPath: join(dir, "out"),
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "agent-task.provider-retry" }),
      expect.objectContaining({ type: "agent-task.provider-retry" }),
    ]);
  });

  it("receives a real fd3 frame from the full-pipeline control writer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-control-writer-"));
    const events: unknown[] = [];
    const writerPath = join(
      process.cwd(),
      "src/server/composition/benchmark-control-output.ts",
    );
    await runBenchmarkProcess({
      args: [
        "-e",
        `import { createBenchmarkControlOutput } from ${JSON.stringify(writerPath)}; createBenchmarkControlOutput({ fd: 3, now: () => "2026-07-31T00:00:00.000Z" }).onAgentEvent({ event: "agent-task.provider-retry", kind: "audit", metadata: { attempt: 1, maxAttempts: 5, reason: "rate-limit", requestedDelayMs: 2000 } });`,
      ],
      deadlineAt: Date.now() + 1_000,
      onControlEvent: (event) => events.push(event),
      stderrPath: join(dir, "err"),
      stdoutPath: join(dir, "out"),
    });

    expect(events).toEqual([
      expect.objectContaining({
        reason: "rate-limit",
        requestedDelayMs: 2_000,
        type: "agent-task.provider-retry",
      }),
    ]);
  });

  it("carries strict Repo Security provisioning success through the real fd3 lifecycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchmark-daytona-control-"));
    const events: unknown[] = [];
    const writerPath = join(
      process.cwd(),
      "src/server/composition/benchmark-control-output.ts",
    );
    await runBenchmarkProcess({
      args: [
        "-e",
        `import { createBenchmarkControlOutput } from ${JSON.stringify(writerPath)}; const output = createBenchmarkControlOutput({ fd: 3, now: () => "2026-08-01T00:00:00.000Z" }); output.onPipelineProgress({ stage: "repo-security-screen", status: "succeeded" }); output.onPipelineProgress({ stage: "repo-security-screen", status: "succeeded" });`,
      ],
      deadlineAt: Date.now() + 1_000,
      onControlEvent: (event) => events.push(event),
      stderrPath: join(dir, "err"),
      stdoutPath: join(dir, "out"),
    });

    expect(events).toEqual([
      {
        occurredAt: "2026-08-01T00:00:00.000Z",
        type: "benchmark.daytona-provisioning-succeeded",
        v: 1,
      },
    ]);
  });

  it("parses only positive safe integer timeout values", () => {
    expect(parseBenchmarkTimeout(undefined)).toBe(2_100_000);
    expect(parseBenchmarkTimeout("12")).toBe(12);
    expect(() => parseBenchmarkTimeout("0")).toThrow();
    expect(() => parseBenchmarkTimeout("1.5")).toThrow();
    expect(() => parseBenchmarkTimeout("9007199254740992")).toThrow();
  });
});

async function waitForAccessiblePath(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}
