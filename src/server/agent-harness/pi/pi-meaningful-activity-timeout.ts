import {
  type AgentMeaningfulActivity,
  AgentSessionTimeoutError,
} from "../agent-session-timeout";

export type PiActivityTracker = {
  observe: (kind: string, tool?: string) => void;
  read: () => AgentMeaningfulActivity | undefined;
};

/**
 * Tracks provider-owned retry sleeps so the harness does not mistake a known
 * backoff for agent inactivity while extending the harness-owned hard timer.
 * External cancellation remains the authoritative pipeline deadline.
 */
export type PiRetryBackoff = {
  clear: () => void;
  cumulativeDelayMs: () => number;
  hardDeadlineAt: () => number;
  isActive: () => boolean;
  setOnChange: (listener: () => void) => void;
  start: (input: { hardExtensionMs: number; sleepDelayMs: number }) => void;
};

export function createPiRetryBackoff(
  activity: PiActivityTracker,
  baselineHardDeadlineAt: number,
  deadlineCeilingAt = Number.POSITIVE_INFINITY,
): PiRetryBackoff {
  let active = false;
  let cumulativeDelayMs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onChange: (() => void) | undefined;
  return {
    clear() {
      const changed = active || timer !== undefined;
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (changed) onChange?.();
    },
    cumulativeDelayMs: () => cumulativeDelayMs,
    hardDeadlineAt: () =>
      Math.min(baselineHardDeadlineAt + cumulativeDelayMs, deadlineCeilingAt),
    isActive: () => active,
    setOnChange(listener) {
      onChange = listener;
    },
    start({ hardExtensionMs, sleepDelayMs }) {
      active = true;
      cumulativeDelayMs += Math.max(0, hardExtensionMs);
      if (timer !== undefined) clearTimeout(timer);
      onChange?.();
      timer = setTimeout(
        () => {
          active = false;
          timer = undefined;
          // A completed provider-owned sleep starts a fresh inactivity budget.
          activity.observe("provider-retry-ended");
          onChange?.();
        },
        Math.max(0, sleepDelayMs),
      );
    },
  };
}

export function createPiActivityTracker(): PiActivityTracker {
  let latest: AgentMeaningfulActivity | undefined;
  return {
    observe(kind, tool) {
      latest = {
        at: Date.now(),
        kind,
        ...(tool === undefined ? {} : { tool }),
      };
    },
    read: () => latest,
  };
}

export async function runWithPiActivityTimeout<T>(input: {
  activity: PiActivityTracker;
  backoff?: PiRetryBackoff;
  hardDeadlineAt: number;
  hardTimeoutMs: number;
  inactivityLabel?: string;
  inactivityTimeoutMs: number;
  label: string;
  onTimeout: () => void | Promise<void>;
  run: () => Promise<T>;
  signal?: AbortSignal;
}): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const rejectTimeout = (
    kind: "hard-cap" | "inactivity",
    reject: (reason: unknown) => void,
  ) => {
    if (settled) return;
    settled = true;
    try {
      void Promise.resolve(input.onTimeout()).catch(() => undefined);
    } catch {
      // Cancellation is best effort; preserve the timeout as the cause.
    }
    reject(
      new AgentSessionTimeoutError(
        {
          activity: input.activity,
          hardTimeoutMs:
            input.hardTimeoutMs + (input.backoff?.cumulativeDelayMs() ?? 0),
          ...(input.inactivityLabel === undefined
            ? {}
            : { inactivityLabel: input.inactivityLabel }),
          inactivityTimeoutMs: input.inactivityTimeoutMs,
          label: input.label,
        },
        kind,
      ),
    );
  };

  return new Promise<T>((resolve, reject) => {
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(() => reject(input.signal?.reason));
    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      input.backoff?.clear();
      input.signal?.removeEventListener("abort", abort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      callback();
    };
    const scheduleInactivity = () => {
      if (settled) return;
      if (input.backoff?.isActive() === true) return;
      const activityAt = input.activity.read()?.at ?? startedAt;
      const elapsed = Date.now() - activityAt;
      const delay = Math.max(1, input.inactivityTimeoutMs - elapsed);
      timer = setTimeout(() => {
        void rejectTimeout("inactivity", (reason) => {
          clearTimers();
          reject(reason);
        });
      }, delay);
    };
    const scheduleHardTimeout = () => {
      const hardDeadlineAt =
        input.backoff?.hardDeadlineAt() ?? input.hardDeadlineAt;
      const hardDelay = Math.max(1, hardDeadlineAt - Date.now());
      hardTimer = setTimeout(() => {
        void rejectTimeout("hard-cap", (reason) => {
          clearTimers();
          reject(reason);
        });
      }, hardDelay);
    };
    input.backoff?.setOnChange(() => {
      if (settled) return;
      if (timer !== undefined) clearTimeout(timer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      timer = undefined;
      hardTimer = undefined;
      scheduleHardTimeout();
      if (!input.backoff?.isActive()) scheduleInactivity();
    });
    scheduleHardTimeout();
    scheduleInactivity();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) abort();
    if (settled) return;
    void input.run().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );

    // Activity is updated synchronously by Pi's event subscriber. Polling keeps
    // this generic timeout independent of provider event implementation details.
    const poll = () => {
      if (settled) return;
      if (timer !== undefined) clearTimeout(timer);
      scheduleInactivity();
      pollTimer = setTimeout(
        poll,
        Math.min(250, Math.max(10, input.inactivityTimeoutMs / 4)),
      );
    };
    pollTimer = setTimeout(
      poll,
      Math.min(250, Math.max(10, input.inactivityTimeoutMs / 4)),
    );
  });
}
