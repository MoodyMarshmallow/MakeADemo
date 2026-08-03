/**
 * Completes asynchronous benchmark child setup before synchronously admitting
 * a spawn. A cancellation observed during setup prevents the spawn caller from
 * running at all.
 */
export async function prepareBenchmarkProcessStart<T>(input: {
  start: () => T;
  setup: () => Promise<void>;
  signal: AbortSignal;
}): Promise<T> {
  await input.setup();
  if (input.signal.aborted) {
    throw input.signal.reason ?? new Error("Benchmark process was cancelled.");
  }
  return input.start();
}
