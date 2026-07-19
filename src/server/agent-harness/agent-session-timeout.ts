/** Provider-neutral meaningful progress observed during one agent turn. */
export type AgentMeaningfulActivity = {
  at: number;
  kind: string;
  tool?: string;
};

export type AgentSessionTimeoutInput = {
  activity: { read: () => AgentMeaningfulActivity | undefined };
  hardTimeoutMs: number;
  inactivityLabel?: string;
  inactivityTimeoutMs: number;
  label: string;
};

/** Signals that a harness-enforced agent inactivity or hard deadline elapsed. */
export class AgentSessionTimeoutError extends Error {
  readonly timeoutKind: "inactivity" | "hard-cap";
  readonly lastMeaningfulActivity: AgentMeaningfulActivity | undefined;

  constructor(
    input: AgentSessionTimeoutInput,
    timeoutKind: "inactivity" | "hard-cap",
  ) {
    super(
      timeoutKind === "hard-cap"
        ? `${input.label} exceeded its hard cap of ${input.hardTimeoutMs}ms.`
        : `${input.inactivityLabel ?? input.label} timed out after ${input.inactivityTimeoutMs}ms of inactivity.`,
    );
    this.name = "AgentSessionTimeoutError";
    this.timeoutKind = timeoutKind;
    this.lastMeaningfulActivity = input.activity.read();
  }
}
