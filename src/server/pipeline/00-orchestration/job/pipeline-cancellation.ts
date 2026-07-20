export type PipelineCancellationReason = "deadline-exceeded" | "signal";

/** A cooperative Pipeline Job stop requested by its CLI deadline or process signal. */
export class PipelineCancellationError extends Error {
  readonly reason: PipelineCancellationReason;

  constructor(reason: PipelineCancellationReason) {
    super(
      reason === "deadline-exceeded"
        ? "Pipeline deadline exceeded."
        : "Pipeline cancelled by process signal.",
    );
    this.name = "PipelineCancellationError";
    this.reason = reason;
  }
}

export function pipelineCancellationFromSignal(
  signal: AbortSignal | undefined,
): PipelineCancellationError | undefined {
  if (signal?.aborted !== true) return undefined;
  return signal.reason instanceof PipelineCancellationError
    ? signal.reason
    : new PipelineCancellationError("signal");
}

export function throwIfPipelineCancelled(
  signal: AbortSignal | undefined,
): void {
  const cancellation = pipelineCancellationFromSignal(signal);
  if (cancellation !== undefined) throw cancellation;
}

export function throwIfPipelineDeadlineReached(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): void {
  throwIfPipelineCancelled(signal);
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new PipelineCancellationError("deadline-exceeded");
  }
}

export function isPipelineCancellationError(
  error: unknown,
): error is PipelineCancellationError {
  return error instanceof PipelineCancellationError;
}

/** Cancels an external operation, then waits for it to settle before rejecting. */
export function runSettledPipelineOperation<T>(input: {
  deadlineAt: number | undefined;
  onCancel: () => Promise<void>;
  operation: Promise<T>;
  signal: AbortSignal | undefined;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    let cancellationStarted = false;
    let operationSettled = false;
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveOperationSettlement: (() => void) | undefined;
    const operationSettlement = new Promise<void>((resolve) => {
      resolveOperationSettlement = resolve;
    });
    const removeCancellationHooks = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      input.signal?.removeEventListener("abort", abort);
    };
    const cancel = (error: PipelineCancellationError) => {
      if (cancellationStarted || settled) return;
      cancellationStarted = true;
      removeCancellationHooks();
      void (async () => {
        while (!operationSettled) {
          await input.onCancel().catch(() => undefined);
          if (operationSettled) break;
          await Promise.race([
            operationSettlement,
            waitForCancellationCadence(),
          ]);
        }
        await input.operation.catch(() => undefined);
        settled = true;
        reject(error);
      })();
    };
    const abort = () =>
      cancel(
        pipelineCancellationFromSignal(input.signal) ??
          new PipelineCancellationError("signal"),
      );

    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.deadlineAt !== undefined) {
      deadlineTimer = setTimeout(
        () => cancel(new PipelineCancellationError("deadline-exceeded")),
        Math.max(0, input.deadlineAt - Date.now()),
      );
    }
    if (input.signal?.aborted === true) abort();

    input.operation.then(
      (value) => {
        operationSettled = true;
        resolveOperationSettlement?.();
        if (cancellationStarted || settled) return;
        settled = true;
        removeCancellationHooks();
        resolve(value);
      },
      (error: unknown) => {
        operationSettled = true;
        resolveOperationSettlement?.();
        if (cancellationStarted || settled) return;
        settled = true;
        removeCancellationHooks();
        reject(error);
      },
    );
  });
}

function waitForCancellationCadence(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
