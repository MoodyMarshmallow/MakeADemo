import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access } from "node:fs/promises";
import { finished } from "node:stream/promises";

import {
  type BenchmarkControlEvent,
  maximumControlEventLineBytes,
  parseBenchmarkControlEventLine,
} from "./benchmark-control-events.schema";

const DEFAULT_BENCHMARK_TIMEOUT_MS = 2_100_000;
// fd3 is local and each frame is bounded to 64 KiB. Allow a scheduled
// descendant to begin flushing after direct-child exit, then stop shortly
// after its last data without tying completion to descendant EOF.
const CONTROL_EXIT_INITIAL_DRAIN_GRACE_MS = 150;
const CONTROL_EXIT_ACTIVITY_DRAIN_GRACE_MS = 25;
const CONTROL_EXIT_MAX_DRAIN_GRACE_MS = 250;

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
  /** Cancels before spawn and while the child is active. */
  signal?: AbortSignal;
  /** Receives validated, benchmark-only fd3 control frames. */
  onControlEvent?: (event: BenchmarkControlEvent) => void;
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
  throwIfBenchmarkProcessAborted(input.signal);
  if (input.deadlineAt <= Date.now()) {
    throw new Error("Benchmark process deadline was reached before spawn.");
  }
  const child = spawn("bun", input.args, {
    detached: true,
    env: input.env ?? process.env,
    stdio:
      input.onControlEvent === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", "pipe"],
  });
  const stdout = createWriteStream(input.stdoutPath);
  const stderr = createWriteStream(input.stderrPath);
  if (child.stdout === null || child.stderr === null) {
    throw new Error(
      "Benchmark child did not expose its required output streams.",
    );
  }
  const onControlEvent = input.onControlEvent;
  const controlCandidate =
    onControlEvent === undefined ? undefined : child.stdio[3];
  const controlStream =
    controlCandidate !== undefined &&
    controlCandidate !== null &&
    "read" in controlCandidate
      ? controlCandidate
      : undefined;
  const pendingControlRead =
    controlStream === undefined || onControlEvent === undefined
      ? Promise.resolve()
      : readBenchmarkControlFrames(controlStream, onControlEvent);
  let resultPath: string | undefined;
  let terminationReason: BenchmarkTerminationReason | undefined;
  let killed = false;
  let settled = false;
  let markerBuffer = "";
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let controlDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let controlDrainStartedAt: number | undefined;
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
  const abort = () => void terminate("signal");
  input.signal?.addEventListener("abort", abort, { once: true });
  const unregister = input.controller?.register(terminate);
  const remaining = Math.max(0, input.deadlineAt - Date.now());
  const deadlineTimer = setTimeout(() => void terminate("deadline"), remaining);
  const stopControlRead = () => {
    if (controlDrainTimer) clearTimeout(controlDrainTimer);
    controlStream?.destroy();
  };
  const scheduleControlReadStop = (delayMs: number) => {
    if (controlStream === undefined || controlDrainStartedAt === undefined)
      return;
    if (controlDrainTimer) clearTimeout(controlDrainTimer);
    const remainingMs = Math.max(
      0,
      CONTROL_EXIT_MAX_DRAIN_GRACE_MS - (Date.now() - controlDrainStartedAt),
    );
    controlDrainTimer = setTimeout(
      () => controlStream.destroy(),
      Math.min(delayMs, remainingMs),
    );
  };
  const drainControlReadAfterExit = () => {
    if (controlStream === undefined || controlDrainStartedAt !== undefined)
      return;
    controlDrainStartedAt = Date.now();
    scheduleControlReadStop(CONTROL_EXIT_INITIAL_DRAIN_GRACE_MS);
  };
  const extendActiveControlDrain = () => {
    if (controlDrainStartedAt === undefined) return;
    scheduleControlReadStop(CONTROL_EXIT_ACTIVITY_DRAIN_GRACE_MS);
  };
  controlStream?.on("data", extendActiveControlDrain);

  return await new Promise((resolve, reject) => {
    child.once("exit", drainControlReadAfterExit);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      stopControlRead();
      stdout.end();
      stderr.end();
      unregister?.();
      input.signal?.removeEventListener("abort", abort);
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
      drainControlReadAfterExit();
      stdout.end();
      stderr.end();
      unregister?.();
      input.signal?.removeEventListener("abort", abort);
      resolveTermination?.();
      void Promise.all([
        finished(stdout),
        finished(stderr),
        pendingResultAccess,
        pendingControlRead,
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

function throwIfBenchmarkProcessAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Benchmark process was cancelled.");
  }
}

function readBenchmarkControlFrames(
  stream: NodeJS.ReadableStream,
  onControlEvent: (event: BenchmarkControlEvent) => void,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let discardingOversizedLine = false;
  stream.on("data", (chunk: Buffer | string) => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < input.length) {
      const newlineIndex = input.indexOf(0x0a, offset);
      const lineEnd = newlineIndex === -1 ? input.length : newlineIndex;
      const fragment = input.subarray(offset, lineEnd);
      offset = newlineIndex === -1 ? input.length : newlineIndex + 1;
      if (discardingOversizedLine) {
        if (newlineIndex !== -1) {
          discardingOversizedLine = false;
        }
        continue;
      }
      if (buffer.length + fragment.length > maximumControlEventLineBytes) {
        buffer = Buffer.alloc(0);
        discardingOversizedLine = newlineIndex === -1;
        continue;
      }
      buffer = Buffer.concat([buffer, fragment]);
      if (newlineIndex === -1) continue;
      const event = parseBenchmarkControlEventLine(buffer.toString("utf8"));
      buffer = Buffer.alloc(0);
      if (event === undefined) continue;
      try {
        onControlEvent(event);
      } catch {
        // Control feedback cannot fail the child reaping path.
      }
    }
  });
  return finished(stream).then(
    () => undefined,
    () => undefined,
  );
}
