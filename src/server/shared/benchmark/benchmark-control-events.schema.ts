const maximumControlEventLineBytes = 64 * 1024;

const providerRetryReasons = [
  "rate-limit",
  "transient-provider-failure",
] as const;

type BenchmarkProviderRetryReason = (typeof providerRetryReasons)[number];

/** A versioned, sanitized control envelope emitted only for benchmark runs. */
export type BenchmarkProviderRetryControlEvent = {
  attempt: number;
  maxAttempts: number;
  occurredAt: string;
  reason: BenchmarkProviderRetryReason;
  requestedDelayMs: number;
  type: "agent-task.provider-retry";
  v: 1;
};

/** A strict, path-free acknowledgement that Daytona provisioning completed. */
export type BenchmarkDaytonaProvisioningSucceededControlEvent = {
  occurredAt: string;
  type: "benchmark.daytona-provisioning-succeeded";
  v: 1;
};

export type BenchmarkControlEvent =
  | BenchmarkDaytonaProvisioningSucceededControlEvent
  | BenchmarkProviderRetryControlEvent;

export function serializeBenchmarkProviderRetryControlEvent(
  input: Omit<BenchmarkProviderRetryControlEvent, "type" | "v">,
): string {
  return JSON.stringify({ ...input, type: "agent-task.provider-retry", v: 1 });
}

export function serializeBenchmarkDaytonaProvisioningSucceededControlEvent(
  input: Omit<BenchmarkDaytonaProvisioningSucceededControlEvent, "type" | "v">,
): string {
  return JSON.stringify({
    ...input,
    type: "benchmark.daytona-provisioning-succeeded",
    v: 1,
  });
}

/**
 * Validates one bounded fd3 JSONL frame. Invalid control input is ignored so
 * benchmark feedback can never fail a Pipeline Job.
 */
export function parseBenchmarkControlEventLine(
  line: string,
): BenchmarkControlEvent | undefined {
  if (Buffer.byteLength(line, "utf8") > maximumControlEventLineBytes) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (
    keys.length === 3 &&
    keys[0] === "occurredAt" &&
    keys[1] === "type" &&
    keys[2] === "v" &&
    value.v === 1 &&
    value.type === "benchmark.daytona-provisioning-succeeded" &&
    typeof value.occurredAt === "string" &&
    Number.isFinite(Date.parse(value.occurredAt))
  ) {
    return value as BenchmarkDaytonaProvisioningSucceededControlEvent;
  }
  const expectedKeys = [
    "attempt",
    "maxAttempts",
    "occurredAt",
    "reason",
    "requestedDelayMs",
    "type",
    "v",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return undefined;
  }
  if (
    value.v !== 1 ||
    value.type !== "agent-task.provider-retry" ||
    !isPositiveSafeInteger(value.attempt) ||
    !isPositiveSafeInteger(value.maxAttempts) ||
    !isNonNegativeSafeInteger(value.requestedDelayMs) ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    !providerRetryReasons.includes(value.reason as BenchmarkProviderRetryReason)
  ) {
    return undefined;
  }
  return value as BenchmarkProviderRetryControlEvent;
}

export function readBenchmarkProviderRetryControlEvent(input: {
  event: string;
  metadata: Readonly<Record<string, boolean | number | string>> | undefined;
  occurredAt: string;
}): BenchmarkProviderRetryControlEvent | undefined {
  if (input.event !== "agent-task.provider-retry") return undefined;
  const metadata = input.metadata;
  if (
    metadata === undefined ||
    !isPositiveSafeInteger(metadata.attempt) ||
    !isPositiveSafeInteger(metadata.maxAttempts) ||
    !isNonNegativeSafeInteger(metadata.requestedDelayMs) ||
    !providerRetryReasons.includes(
      metadata.reason as BenchmarkProviderRetryReason,
    )
  ) {
    return undefined;
  }
  return {
    attempt: metadata.attempt,
    maxAttempts: metadata.maxAttempts,
    occurredAt: input.occurredAt,
    reason: metadata.reason as BenchmarkProviderRetryReason,
    requestedDelayMs: metadata.requestedDelayMs,
    type: "agent-task.provider-retry",
    v: 1,
  };
}

export { maximumControlEventLineBytes };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
