import {
  type AgentMeaningfulActivity,
  AgentSessionTimeoutError,
} from "../agent-session-timeout";

export type PiActivityTracker = {
  observe: (kind: string, tool?: string) => void;
  read: () => AgentMeaningfulActivity | undefined;
};

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
  hardDeadlineAt: number;
  hardTimeoutMs: number;
  inactivityLabel?: string;
  inactivityTimeoutMs: number;
  label: string;
  onTimeout: () => void | Promise<void>;
  run: () => Promise<T>;
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
          hardTimeoutMs: input.hardTimeoutMs,
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
    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      callback();
    };
    const scheduleInactivity = () => {
      if (settled) return;
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
    const hardDelay = Math.max(1, input.hardDeadlineAt - Date.now());
    hardTimer = setTimeout(() => {
      void rejectTimeout("hard-cap", (reason) => {
        clearTimers();
        reject(reason);
      });
    }, hardDelay);
    scheduleInactivity();
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
      setTimeout(
        poll,
        Math.min(250, Math.max(10, input.inactivityTimeoutMs / 4)),
      );
    };
    setTimeout(
      poll,
      Math.min(250, Math.max(10, input.inactivityTimeoutMs / 4)),
    );
  });
}
