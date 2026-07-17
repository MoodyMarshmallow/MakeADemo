import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenCodeProviderSandboxSecrets,
  ensureOpenCodeProviderDaytonaSecret,
} from "./opencode-provider-secrets";

describe("OpenCode provider Daytona secrets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps OpenAI to the Daytona sandbox secret environment variable", () => {
    expect(
      createOpenCodeProviderSandboxSecrets({
        providerID: "openai",
        providerSecretName: "makeademo-openai",
      }),
    ).toEqual({ OPENAI_API_KEY: "makeademo-openai" });
  });

  it("derives stable non-reversible secret names from each provider key", async () => {
    const firstName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient([], []),
      env: { OPENAI_API_KEY: "sk-local" },
      providerID: "openai",
    });
    const repeatedName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient([], []),
      env: { OPENAI_API_KEY: "sk-local" },
      providerID: "openai",
    });
    const rotatedName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient([], []),
      env: { OPENAI_API_KEY: "sk-other" },
      providerID: "openai",
    });

    expect(firstName).toBe("makeademo-openai-7c9f8cb332ed");
    expect(repeatedName).toBe(firstName);
    expect(rotatedName).toBe("makeademo-openai-3dcad332ca20");
    expect(rotatedName).not.toBe(firstName);
    expect(`${firstName}${rotatedName}`).not.toContain("sk-");
  });

  it("creates a Daytona secret from the local OpenAI API key", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, []),
      env: { OPENAI_API_KEY: "sk-local" },
      providerID: "openai",
    });

    expect(secretName).toBe("makeademo-openai-7c9f8cb332ed");
    expect(calls).toEqual([
      { list: true },
      {
        create: {
          description: "MakeADemo OpenCode provider credential.",
          hosts: ["api.openai.com"],
          name: "makeademo-openai-7c9f8cb332ed",
          value: "sk-local",
        },
      },
    ]);
  });

  it("retries when listing Daytona secrets hits a transient connection failure", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, [], {
        listErrors: [connectionRefusedError()],
      }),
      env: { OPENAI_API_KEY: "sk-local" },
      providerID: "openai",
    });

    expect(secretName).toBe("makeademo-openai-7c9f8cb332ed");
    expect(calls).toEqual([
      { list: true },
      { list: true },
      {
        create: {
          description: "MakeADemo OpenCode provider credential.",
          hosts: ["api.openai.com"],
          name: "makeademo-openai-7c9f8cb332ed",
          value: "sk-local",
        },
      },
    ]);
  });

  it("does not retry a non-timeout secret ensure failure", async () => {
    const calls: unknown[] = [];

    await expect(
      ensureOpenCodeProviderDaytonaSecret({
        client: {
          secret: {
            async list() {
              calls.push({ list: true });
              throw new Error("permission denied");
            },
            async create() {
              throw new Error("create should not run");
            },
            async update() {
              throw new Error("update should not run");
            },
          },
        },
        env: { OPENAI_API_KEY: "sk-local" },
        providerID: "openai",
      }),
    ).rejects.toThrow("permission denied");

    expect(calls).toEqual([{ list: true }]);
  });

  it("reuses an existing versioned secret without concurrent updates", async () => {
    const calls: unknown[] = [];
    const client = fakeSecretClient(calls, [
      { id: "secret_123", name: "makeademo-openai-f76395b4a9c4" },
    ]);

    const secretNames = await Promise.all([
      ensureOpenCodeProviderDaytonaSecret({
        client,
        env: { OPENAI_API_KEY: "sk-rotated" },
        providerID: "openai",
      }),
      ensureOpenCodeProviderDaytonaSecret({
        client,
        env: { OPENAI_API_KEY: "sk-rotated" },
        providerID: "openai",
      }),
    ]);

    expect(secretNames).toEqual([
      "makeademo-openai-f76395b4a9c4",
      "makeademo-openai-f76395b4a9c4",
    ]);
    expect(calls).toEqual([{ list: true }, { list: true }]);
  });

  it("re-lists and reuses when concurrent secret creation wins the race", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, [], {
        createError: Object.assign(new Error("Secret already exists"), {
          statusCode: 409,
        }),
        secretsAfterCreateError: [
          { id: "secret_123", name: "makeademo-openai-6c358976588e" },
        ],
      }),
      env: { OPENAI_API_KEY: "sk-raced" },
      providerID: "openai",
    });

    expect(secretName).toBe("makeademo-openai-6c358976588e");
    expect(calls).toEqual([
      { list: true },
      {
        create: {
          description: "MakeADemo OpenCode provider credential.",
          hosts: ["api.openai.com"],
          name: "makeademo-openai-6c358976588e",
          value: "sk-raced",
        },
      },
      { list: true },
    ]);
  });

  it("concurrent absent-secret ensures converge after one create conflicts", async () => {
    const calls: unknown[] = [];
    let createdSecret: { id: string; name: string } | undefined;
    const client = {
      secret: {
        async create(input: {
          description?: string;
          hosts?: string[];
          name: string;
          value: string;
        }) {
          calls.push({ create: input.name });
          if (createdSecret !== undefined) {
            throw Object.assign(new Error("Secret already exists"), {
              statusCode: 409,
            });
          }
          createdSecret = { id: "secret_123", name: input.name };
          return createdSecret;
        },
        async list() {
          calls.push({ list: true });
          const snapshot = createdSecret;
          await Promise.resolve();
          return snapshot === undefined ? [] : [snapshot];
        },
        async update() {
          throw new Error("versioned secrets must never be updated");
        },
      },
    };

    const names = await Promise.all([
      ensureOpenCodeProviderDaytonaSecret({
        client,
        env: { OPENAI_API_KEY: "sk-raced" },
        providerID: "openai",
      }),
      ensureOpenCodeProviderDaytonaSecret({
        client,
        env: { OPENAI_API_KEY: "sk-raced" },
        providerID: "openai",
      }),
    ]);

    expect(names).toEqual([
      "makeademo-openai-6c358976588e",
      "makeademo-openai-6c358976588e",
    ]);
    expect(calls.filter((call) => "create" in (call as object))).toHaveLength(
      2,
    );
    expect(calls.filter((call) => "list" in (call as object))).toHaveLength(3);
  });

  it("allows overriding the generated Daytona secret name", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, []),
      env: {
        MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME: "custom-openai",
        OPENAI_API_KEY: "sk-local",
      },
      providerID: "openai",
    });

    expect(secretName).toBe("custom-openai-7c9f8cb332ed");
    expect(calls).toEqual([
      { list: true },
      {
        create: expect.objectContaining({
          name: "custom-openai-7c9f8cb332ed",
        }),
      },
    ]);
  });

  it("logs the OpenCode provider secret ensure phase without leaking secret values", async () => {
    const logger = fakePipelineEventLogger();

    await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient([], []),
      env: { OPENAI_API_KEY: "sk-success-should-not-leak" },
      logger,
      providerID: "openai",
    });

    expect(logger.entries.map((entry) => entry.event)).toEqual([
      "opencode-provider-secret.ensure.started",
      "opencode-provider-secret.ensure.succeeded",
    ]);
    expect(logger.entries.map((entry) => entry.stage)).toEqual([
      "repo-preparation",
      "repo-preparation",
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(
      "sk-success-should-not-leak",
    );
  });

  it("requires the local OpenAI API key before provisioning Daytona secrets", async () => {
    await expect(
      ensureOpenCodeProviderDaytonaSecret({
        client: fakeSecretClient([], []),
        env: {},
        providerID: "openai",
      }),
    ).rejects.toThrow("OPENAI_API_KEY is required for OpenAI OpenCode runs.");
  });

  it("times out and logs without leaking the provider secret when listing Daytona secrets hangs", async () => {
    vi.useFakeTimers();
    const logger = fakePipelineEventLogger();
    const promise = ensureOpenCodeProviderDaytonaSecret({
      client: {
        secret: {
          async create() {
            throw new Error("create should not run");
          },
          async list() {
            return await new Promise<never>(() => undefined);
          },
          async update() {
            throw new Error("update should not run");
          },
        },
      },
      env: { OPENAI_API_KEY: "sk-should-not-leak" },
      logger,
      providerID: "openai",
      timeoutMs: 25,
    });

    await Promise.resolve();
    const rejection = expect(promise).rejects.toThrow(
      "Timed out ensuring OpenCode provider Daytona secret",
    );
    await vi.advanceTimersByTimeAsync(25 + 250 + 25);

    await rejection;
    expect(logger.entries.map((entry) => entry.event)).toEqual([
      "opencode-provider-secret.ensure.started",
      "opencode-provider-secret.ensure.retrying",
      "opencode-provider-secret.ensure.timeout",
    ]);
    expect(logger.entries.map((entry) => entry.stage)).toEqual([
      "repo-preparation",
      "repo-preparation",
      "repo-preparation",
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("sk-should-not-leak");
  });

  it("retries the whole secret ensure transaction after a timeout", async () => {
    vi.useFakeTimers();
    const calls: unknown[] = [];
    let listCount = 0;
    const promise = ensureOpenCodeProviderDaytonaSecret({
      client: {
        secret: {
          async create(input) {
            calls.push({ create: input });
            return { id: "secret_makeademo-openai", name: input.name };
          },
          async list() {
            calls.push({ list: true });
            listCount += 1;
            if (listCount === 1) {
              return await new Promise<never>(() => undefined);
            }
            return [];
          },
          async update() {
            throw new Error("update should not run");
          },
        },
      },
      env: { OPENAI_API_KEY: "sk-retry" },
      providerID: "openai",
      timeoutMs: 25,
      retryBackoffMs: 10,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25 + 10);

    await expect(promise).resolves.toBe("makeademo-openai-3602ea1e5f77");
    expect(calls).toEqual([
      { list: true },
      { list: true },
      {
        create: {
          description: "MakeADemo OpenCode provider credential.",
          hosts: ["api.openai.com"],
          name: "makeademo-openai-3602ea1e5f77",
          value: "sk-retry",
        },
      },
    ]);
  });
});

function fakeSecretClient(
  calls: unknown[],
  secrets: Array<{ id: string; name: string }>,
  options: {
    createError?: unknown;
    listErrors?: unknown[];
    secretsAfterCreateError?: Array<{ id: string; name: string }>;
    updateErrors?: unknown[];
  } = {},
) {
  let listCount = 0;
  return {
    secret: {
      async create(input: {
        description?: string;
        hosts?: string[];
        name: string;
        value: string;
      }) {
        calls.push({ create: input });
        if (options.createError !== undefined) {
          throw options.createError;
        }
        return { id: `secret_${input.name}`, name: input.name };
      },
      async list() {
        calls.push({ list: true });
        listCount += 1;
        const listError = options.listErrors?.shift();
        if (listError !== undefined) {
          throw listError;
        }
        if (listCount > 1 && options.secretsAfterCreateError !== undefined) {
          return options.secretsAfterCreateError;
        }
        return secrets;
      },
      async update(
        id: string,
        input: { description?: string; hosts?: string[]; value?: string },
      ) {
        calls.push({ update: { id, input } });
        const updateError = options.updateErrors?.shift();
        if (updateError !== undefined) {
          throw updateError;
        }
        return {
          id,
          name: secrets.find((secret) => secret.id === id)?.name ?? id,
        };
      },
    },
  };
}

function connectionRefusedError() {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
}

function fakePipelineEventLogger() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    child() {
      return this;
    },
    async debug(entry: Record<string, unknown>) {
      entries.push(entry);
    },
    async error(entry: Record<string, unknown>) {
      entries.push(entry);
    },
    async flush() {
      return undefined;
    },
    async info(entry: Record<string, unknown>) {
      entries.push(entry);
    },
    async warn(entry: Record<string, unknown>) {
      entries.push(entry);
    },
  };
}
