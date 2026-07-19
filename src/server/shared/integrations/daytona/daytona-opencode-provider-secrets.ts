import { createHash } from "node:crypto";
import { Daytona, DaytonaConflictError } from "@daytona/sdk";

import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";

const defaultOpenAiDaytonaSecretName = "makeademo-openai";
const defaultEnsureOpenCodeProviderSecretTimeoutMs = 30_000;
const defaultEnsureOpenCodeProviderSecretRetryBackoffMs = 250;
const openAiSecretHosts = ["api.openai.com"];

type DaytonaSecret = {
  id: string;
  name: string;
};

type DaytonaSecretClient = {
  secret: {
    create(input: {
      description?: string;
      hosts?: string[];
      name: string;
      value: string;
    }): Promise<DaytonaSecret>;
    list(): Promise<DaytonaSecret[]>;
    update(
      id: string,
      input: { description?: string; hosts?: string[]; value?: string },
    ): Promise<DaytonaSecret>;
  };
};

/**
 * Returns the sandbox environment variable name expected by OpenCode providers.
 * The value must be supplied by Daytona sandbox secrets, not plaintext process env.
 */
function readOpenCodeProviderSecretEnvName(providerID: string): string {
  if (providerID === "openai") {
    return "OPENAI_API_KEY";
  }

  throw new Error(`Unsupported OpenCode provider: ${providerID}`);
}

export function createOpenCodeProviderSandboxSecrets(input: {
  providerID: string;
  providerSecretName: string;
}): Record<string, string> {
  return {
    [readOpenCodeProviderSecretEnvName(input.providerID)]:
      input.providerSecretName,
  };
}

/**
 * Ensures an immutable, key-versioned Daytona provider secret and returns its name.
 * Rotated keys intentionally leave stale secret versions for separate cleanup;
 * this provisioning path must never mutate or delete a version in active use.
 */
export async function ensureOpenCodeProviderDaytonaSecret(input: {
  client?: DaytonaSecretClient;
  daytonaApiKey?: string;
  env?: Record<string, string | undefined>;
  logger?: PipelineEventLogger;
  providerID: string;
  retryBackoffMs?: number;
  timeoutMs?: number;
}): Promise<string> {
  const provider = readOpenCodeProviderSecret(input.providerID, input.env);
  const secretName = readOpenCodeProviderDaytonaSecretName(
    input.providerID,
    provider.apiKey,
    input.env,
  );
  const client =
    input.client ??
    (new Daytona(
      input.daytonaApiKey === undefined
        ? undefined
        : { apiKey: input.daytonaApiKey },
    ) as DaytonaSecretClient);
  const timeoutMs =
    input.timeoutMs ?? defaultEnsureOpenCodeProviderSecretTimeoutMs;
  const retryBackoffMs =
    input.retryBackoffMs ?? defaultEnsureOpenCodeProviderSecretRetryBackoffMs;

  await input.logger?.info(
    {
      component: "opencode-provider-secrets",
      event: "opencode-provider-secret.ensure.started",
      providerID: input.providerID,
      secretName,
      stage: "repo-preparation",
      timeoutMs,
    },
    "Ensuring OpenCode provider Daytona secret.",
  );

  try {
    await ensureOpenCodeProviderDaytonaSecretValueWithRetry({
      client,
      providerApiKey: provider.apiKey,
      providerHosts: provider.hosts,
      secretName,
      timeoutMs,
      retryBackoffMs,
      onRetry: async (attempt) => {
        await input.logger?.warn(
          {
            component: "opencode-provider-secrets",
            event: "opencode-provider-secret.ensure.retrying",
            providerID: input.providerID,
            secretName,
            stage: "repo-preparation",
            attempt,
            maxAttempts: 2,
            retryBackoffMs,
            timeoutMs,
          },
          "Retrying timed out OpenCode provider Daytona secret ensure.",
        );
      },
    });
  } catch (error) {
    if (isOpenCodeProviderSecretTimeoutError(error)) {
      await input.logger?.warn(
        {
          component: "opencode-provider-secrets",
          event: "opencode-provider-secret.ensure.timeout",
          providerID: input.providerID,
          secretName,
          stage: "repo-preparation",
          timeoutMs,
        },
        "Timed out ensuring OpenCode provider Daytona secret.",
      );
    } else {
      await input.logger?.error(
        {
          component: "opencode-provider-secrets",
          event: "opencode-provider-secret.ensure.failed",
          providerID: input.providerID,
          secretName,
          stage: "repo-preparation",
        },
        "Failed to ensure OpenCode provider Daytona secret.",
      );
    }

    throw error;
  }

  await input.logger?.info(
    {
      component: "opencode-provider-secrets",
      event: "opencode-provider-secret.ensure.succeeded",
      providerID: input.providerID,
      secretName,
      stage: "repo-preparation",
    },
    "Ensured OpenCode provider Daytona secret.",
  );

  return secretName;
}

async function ensureOpenCodeProviderDaytonaSecretValue(input: {
  client: DaytonaSecretClient;
  providerApiKey: string;
  providerHosts: string[];
  secretName: string;
  timeoutMs: number;
}): Promise<void> {
  const existingSecret = (
    await withDaytonaSecretConnectionRetry(
      () => input.client.secret.list(),
      input.timeoutMs,
    )
  ).find((secret) => secret.name === input.secretName);
  const secretInput = {
    description: "MakeADemo OpenCode provider credential.",
    hosts: input.providerHosts,
    value: input.providerApiKey,
  };

  if (existingSecret === undefined) {
    try {
      await withDaytonaSecretConnectionRetry(
        () =>
          input.client.secret.create({
            ...secretInput,
            name: input.secretName,
          }),
        input.timeoutMs,
      );
    } catch (error) {
      if (!isDaytonaSecretConflictError(error)) {
        throw error;
      }

      const racedSecret = (
        await withDaytonaSecretConnectionRetry(
          () => input.client.secret.list(),
          input.timeoutMs,
        )
      ).find((secret) => secret.name === input.secretName);
      if (racedSecret === undefined) {
        throw error;
      }
    }
    return;
  }
}

async function ensureOpenCodeProviderDaytonaSecretValueWithRetry(input: {
  client: DaytonaSecretClient;
  providerApiKey: string;
  providerHosts: string[];
  secretName: string;
  timeoutMs: number;
  retryBackoffMs: number;
  onRetry: (attempt: number) => Promise<void>;
}): Promise<void> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ensureOpenCodeProviderDaytonaSecretValue(input);
      return;
    } catch (error) {
      if (
        !isOpenCodeProviderSecretTimeoutError(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      await input.onRetry(attempt + 1);
      await wait(input.retryBackoffMs);
    }
  }
}

async function withDaytonaSecretConnectionRetry<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTimeout(operation(), timeoutMs);
    } catch (error) {
      lastError = error;
      if (
        attempt === maxAttempts ||
        !isTransientDaytonaConnectionError(error)
      ) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  // The underlying request cannot be cancelled by the Daytona client. Attach a
  // rejection handler so a late failure after the local timeout is consumed.
  void promise.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new OpenCodeProviderSecretTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

class OpenCodeProviderSecretTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Timed out ensuring OpenCode provider Daytona secret after ${timeoutMs}ms.`,
    );
    this.name = "OpenCodeProviderSecretTimeoutError";
  }
}

function isOpenCodeProviderSecretTimeoutError(
  error: unknown,
): error is OpenCodeProviderSecretTimeoutError {
  return error instanceof OpenCodeProviderSecretTimeoutError;
}

function isTransientDaytonaConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("code" in error && error.code === "ECONNREFUSED") {
    return true;
  }

  if ("name" in error && error.name === "DaytonaConnectionError") {
    return true;
  }

  if (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("ECONNREFUSED")
  ) {
    return true;
  }

  if ("cause" in error) {
    return isTransientDaytonaConnectionError(error.cause);
  }

  return false;
}

function isDaytonaSecretConflictError(error: unknown): boolean {
  if (error instanceof DaytonaConflictError) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 409
  );
}

function readOpenCodeProviderSecret(
  providerID: string,
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; hosts: string[] } {
  if (providerID === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error("OPENAI_API_KEY is required for OpenAI OpenCode runs.");
    }

    return { apiKey, hosts: openAiSecretHosts };
  }

  throw new Error(`Unsupported OpenCode provider: ${providerID}`);
}

function readOpenCodeProviderDaytonaSecretName(
  providerID: string,
  providerApiKey: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (providerID === "openai") {
    const baseName =
      env.MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME?.trim() ||
      defaultOpenAiDaytonaSecretName;
    const fingerprint = createHash("sha256")
      .update(providerApiKey)
      .digest("hex")
      .slice(0, 12);
    return `${baseName}-${fingerprint}`;
  }

  throw new Error(`Unsupported OpenCode provider: ${providerID}`);
}
