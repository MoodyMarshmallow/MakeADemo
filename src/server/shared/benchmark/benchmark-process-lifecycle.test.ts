import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const unregisterFirst = controller.register(
      () =>
        new Promise<void>((resolve) => {
          signals.push("first");
          releaseFirst = resolve;
        }),
    );
    const unregisterSecond = controller.register(async () => {
      signals.push("second");
    });
    unregisterSecond();

    const cancellation = controller.cancelAll();
    expect(controller.cancelAll()).toBe(cancellation);
    expect(signals).toEqual(["first"]);
    releaseFirst();
    await cancellation;
    unregisterFirst();
    expect(signals).toEqual(["first"]);
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
          killGraceMs: 10,
          controller,
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await controller.cancelAll();
    await expect(children).resolves.toEqual([
      { exitCode: null, killed: true },
      { exitCode: null, killed: true },
    ]);
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
  });

  it("parses only positive safe integer timeout values", () => {
    expect(parseBenchmarkTimeout(undefined)).toBe(2_100_000);
    expect(parseBenchmarkTimeout("12")).toBe(12);
    expect(() => parseBenchmarkTimeout("0")).toThrow();
    expect(() => parseBenchmarkTimeout("1.5")).toThrow();
    expect(() => parseBenchmarkTimeout("9007199254740992")).toThrow();
  });
});
