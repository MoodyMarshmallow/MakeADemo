import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access } from "node:fs/promises";
import { finished } from "node:stream/promises";

const DEFAULT_BENCHMARK_TIMEOUT_MS = 2_100_000;

export function parseBenchmarkTimeout(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_BENCHMARK_TIMEOUT_MS;
  if (!/^\d+$/.test(value))
    throw new Error(
      "MAKEADEMO_BENCHMARK_TIMEOUT_MS must be a positive safe integer.",
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(
      "MAKEADEMO_BENCHMARK_TIMEOUT_MS must be a positive safe integer.",
    );
  return parsed;
}

export type BenchmarkProcessLifecycleOptions = {
  args: string[];
  stdoutPath: string;
  stderrPath: string;
  deadlineAt: number;
  /** Grace for a cooperative CLI cancellation to write its terminal result. */
  cleanupGraceMs?: number;
  resultGraceMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  controller?: BenchmarkProcessController;
};

export type BenchmarkProcessLifecycleResult = {
  exitCode: number | null;
  killed: boolean;
  resultPath?: string;
  terminationReason?: BenchmarkTerminationReason;
};

type BenchmarkTerminationReason = "deadline" | "result-grace" | "signal";

export type BenchmarkProcessController = {
  register(
    terminate: (reason: BenchmarkTerminationReason) => Promise<void>,
  ): () => void;
  cancelAll(reason?: BenchmarkTerminationReason): Promise<void>;
};

export function createBenchmarkProcessController(): BenchmarkProcessController {
  const active = new Set<
    (reason: BenchmarkTerminationReason) => Promise<void>
  >();
  let cancellation: Promise<void> | undefined;
  let cancellationReason: BenchmarkTerminationReason | undefined;
  return {
    register(terminate) {
      if (cancellationReason !== undefined) {
        void terminate(cancellationReason);
        return () => undefined;
      }
      active.add(terminate);
      return () => active.delete(terminate);
    },
    cancelAll(reason = "signal") {
      if (cancellation !== undefined) return cancellation;
      cancellationReason = reason;
      cancellation = Promise.all(
        [...active].map((terminate) => terminate(reason)),
      ).then(() => undefined);
      return cancellation;
    },
  };
}

export async function runBenchmarkProcess(
  input: BenchmarkProcessLifecycleOptions,
): Promise<BenchmarkProcessLifecycleResult> {
  const child = spawn("bun", input.args, {
    detached: true,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createWriteStream(input.stdoutPath);
  const stderr = createWriteStream(input.stderrPath);
  let resultPath: string | undefined;
  let terminationReason: BenchmarkTerminationReason | undefined;
  let killed = false;
  let settled = false;
  let markerBuffer = "";
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingResultAccess: Promise<void> = Promise.resolve();
  let terminationPromise: Promise<void> | undefined;
  let resolveTermination: (() => void) | undefined;
  const resultGraceMs = input.resultGraceMs ?? 5_000;
  const killGraceMs = input.killGraceMs ?? 2_000;
  const cleanupGraceMs = input.cleanupGraceMs ?? 60_000;

  const inspect = (chunk: Buffer, stream: NodeJS.WritableStream) => {
    stream.write(chunk);
    markerBuffer = (markerBuffer + chunk.toString("utf8")).slice(-4096);
    const match = markerBuffer.match(/Result JSON:\s*(\S+)/);
    if (match?.[1] !== undefined && resultPath === undefined) {
      pendingResultAccess = access(match[1])
        .then(() => {
          resultPath = match[1];
          if (!settled) {
            graceTimer = setTimeout(
              () => void terminate("result-grace"),
              resultGraceMs,
            );
          }
        })
        .catch(() => undefined);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => inspect(chunk, stdout));
  child.stderr.on("data", (chunk: Buffer) => inspect(chunk, stderr));

  const terminate = (reason: BenchmarkTerminationReason): Promise<void> => {
    if (terminationPromise !== undefined) return terminationPromise;
    terminationPromise = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    if (settled) {
      resolveTermination?.();
      return terminationPromise;
    }
    terminationReason = reason;
    killed = true;
    const pid = child.pid;
    try {
      if (pid === undefined) throw new Error("missing pid");
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    killTimer = setTimeout(
      () => {
        if (settled) return;
        try {
          if (pid === undefined) throw new Error("missing pid");
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      },
      reason === "deadline" || reason === "signal"
        ? cleanupGraceMs
        : killGraceMs,
    );
    return terminationPromise;
  };
  const unregister = input.controller?.register(terminate);
  const remaining = Math.max(0, input.deadlineAt - Date.now());
  const deadlineTimer = setTimeout(() => void terminate("deadline"), remaining);

  return await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      stdout.end();
      stderr.end();
      unregister?.();
      resolveTermination?.();
      void Promise.all([finished(stdout), finished(stderr)]).then(
        () => reject(error),
        () => reject(error),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      stdout.end();
      stderr.end();
      unregister?.();
      resolveTermination?.();
      void Promise.all([
        finished(stdout),
        finished(stderr),
        pendingResultAccess,
      ]).then(
        () =>
          resolve({
            exitCode: code,
            killed,
            ...(resultPath === undefined ? {} : { resultPath }),
            ...(terminationReason === undefined ? {} : { terminationReason }),
          }),
        reject,
      );
    });
  });
}
