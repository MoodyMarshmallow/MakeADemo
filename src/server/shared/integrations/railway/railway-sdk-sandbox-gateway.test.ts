import { SandboxNotFoundError } from "railway";
import { describe, expect, it, vi } from "vitest";

import {
  RailwaySandboxDestroySettlementError,
  type RailwaySandboxInventoryError,
  RailwaySdkSandboxGateway,
} from "./railway-sdk-sandbox-gateway";
import { railwaySpikeTemplateRecipe } from "./railway-spike-template-recipe";

describe("RailwaySdkSandboxGateway", () => {
  it("exhausts server-default pages and finds an unknown active status on page two", async () => {
    const requests: Array<{
      body: { variables: { after?: string; environmentId: string } };
      headers: Headers;
    }> = [];
    const inventoryFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          variables: { after?: string; environmentId: string };
        };
        requests.push({ body, headers: new Headers(init?.headers) });
        const firstPage = body.variables.after === undefined;
        return Response.json({
          data: {
            sandboxes: {
              edges: firstPage
                ? Array.from({ length: 100 }, (_, index) => ({
                    node: { id: `destroyed-${index}`, status: "DESTROYED" },
                  }))
                : [
                    { node: { id: "future-status-id", status: "PAUSING" } },
                    { node: { id: "failed-id", status: "FAILED" } },
                  ],
              pageInfo: {
                endCursor: firstPage ? "page-two" : null,
                hasNextPage: firstPage,
              },
            },
          },
        });
      },
    );
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      fetch: inventoryFetch as never,
      projectToken: "project-token",
      railwayAgentSession: "inventory-session",
      railwayCaller: "skill:use-railway@test",
      sandboxApi: fakeSandboxApi([]) as never,
    });

    await expect(gateway.listActiveSandboxes()).resolves.toEqual([
      { id: "future-status-id" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.body.variables)).toEqual([
      { environmentId: "env_canary" },
      { after: "page-two", environmentId: "env_canary" },
    ]);
    expect(Object.fromEntries(requests[0]?.headers ?? [])).toMatchObject({
      "content-type": "application/json",
      "project-access-token": "project-token",
      "x-railway-agent-session": "inventory-session",
      "x-railway-caller": "skill:use-railway@test",
    });
  });

  it("bounds an inventory page request with a safe diagnostic", async () => {
    vi.useFakeTimers();
    try {
      const gateway = new RailwaySdkSandboxGateway({
        environmentId: "env_canary",
        fetch: (() => new Promise(() => undefined)) as never,
        inventoryRpcTimeoutMs: 5,
        inventoryTotalTimeoutMs: 20,
        projectToken: "sensitive-project-token",
        sandboxApi: fakeSandboxApi([]) as never,
      });

      const inventory = gateway.listActiveSandboxes();
      const rejection = expect(inventory).rejects.toThrow(
        "Railway sandbox active inventory request timed out.",
      );
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      await expect(inventory).rejects.toMatchObject({
        code: "request-timeout",
        name: "RailwaySandboxInventoryError",
      } satisfies Partial<RailwaySandboxInventoryError>);
      await expect(inventory).rejects.not.toThrow("sensitive-project-token");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the total inventory deadline across fast unique-cursor pages", async () => {
    let milliseconds = 0;
    const inventoryFetch = vi.fn(async () => {
      milliseconds += 2;
      return Response.json({
        data: {
          sandboxes: {
            edges: [],
            pageInfo: {
              endCursor: `cursor-${milliseconds}`,
              hasNextPage: true,
            },
          },
        },
      });
    });
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      fetch: inventoryFetch as never,
      inventoryNow: () => milliseconds,
      inventoryRpcTimeoutMs: 100,
      inventoryTotalTimeoutMs: 5,
      projectToken: "project-token",
      sandboxApi: fakeSandboxApi([]) as never,
    });

    await expect(gateway.listActiveSandboxes()).rejects.toMatchObject({
      code: "pagination-timeout",
      message: "Railway sandbox active inventory pagination timed out.",
      name: "RailwaySandboxInventoryError",
    } satisfies Partial<RailwaySandboxInventoryError>);
    expect(inventoryFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects partial inventory data when GraphQL also returns errors", async () => {
    const projectToken = "sensitive-project-token";
    const sandboxId = "sensitive-sandbox-id";
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      fetch: (async () =>
        Response.json({
          data: {
            sandboxes: {
              edges: [{ node: { id: sandboxId, status: "RUNNING" } }],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
          errors: [
            { message: `provider exposed ${projectToken} ${sandboxId}` },
          ],
        })) as never,
      projectToken,
      sandboxApi: fakeSandboxApi([]) as never,
    });

    let failure: unknown;
    try {
      await gateway.listActiveSandboxes();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "provider-errors",
      message: "Railway sandbox active inventory query returned errors.",
      name: "RailwaySandboxInventoryError",
    });
    expect(String(failure)).not.toContain(projectToken);
    expect(String(failure)).not.toContain(sandboxId);
  });

  it("classifies the live transport failure without exposing its details", async () => {
    const projectToken = "sensitive-project-token";
    const liveTransportMessage = `Unable to connect. Is the computer able to access the url? ${projectToken}`;
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      fetch: (async () => {
        throw new Error(liveTransportMessage);
      }) as never,
      projectToken,
      sandboxApi: fakeSandboxApi([]) as never,
    });

    let failure: unknown;
    try {
      await gateway.listActiveSandboxes();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "transport-unavailable",
      message: "Railway sandbox active inventory transport is unavailable.",
      name: "RailwaySandboxInventoryError",
    });
    expect(String(failure)).not.toContain(liveTransportMessage);
    expect(String(failure)).not.toContain(projectToken);
  });

  it("returns promptly after a durable demo launch emits its acknowledgement", async () => {
    const events: string[] = [];
    let emitStdout!: (chunk: string) => void;
    let settleResult!: () => void;
    const result = new Promise<{
      exitCode: number | null;
      stderr: string;
      stdout: string;
      timedOut: boolean;
      truncated: boolean;
    }>((resolve) => {
      settleResult = () =>
        resolve({
          exitCode: null,
          stderr: "",
          stdout: "4321\n",
          timedOut: false,
          truncated: false,
        });
    });
    const template = {
      run() {
        return template;
      },
      withPackages() {
        return template;
      },
      workdir() {
        return template;
      },
    };
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: {
        template: () => template,
        async create() {
          return { id: "created-id" };
        },
        async connect() {
          return {
            async destroy() {},
            exec(_command: string, options: unknown) {
              emitStdout = (options as { onStdout(chunk: string): void })
                .onStdout;
              return {
                async detach() {
                  events.push("detach");
                  settleResult();
                  return "durable-demo-session";
                },
                async kill() {
                  events.push("kill");
                  return true;
                },
                async result() {
                  return result;
                },
                sessionName: Promise.resolve("durable-demo-session"),
              };
            },
            files: {
              read: async () => new ReadableStream(),
              write: async () => {},
            },
            id: "created-id",
            async refresh() {
              return this;
            },
            status: "RUNNING",
          };
        },
      } as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });
    const command = await gateway.execute(sandbox, "launch demo", {
      cwd: "/workspace",
      detachAfterFirstStdout: true,
      detachTimeoutMs: 50,
      env: {},
      onStdout(chunk) {
        events.push(`stdout:${chunk.trim()}`);
      },
    });

    const commandResult = command.result();
    await Promise.resolve();
    emitStdout("4321\n");

    await expect(commandResult).resolves.toMatchObject({
      exitCode: 0,
      stdout: "4321\n",
    });
    expect(events).toEqual(["stdout:4321", "detach"]);
  });

  it("fails closed when Railway cannot retain an acknowledged durable launch", async () => {
    let settleResult!: () => void;
    const result = new Promise<{
      exitCode: number | null;
      stderr: string;
      stdout: string;
      timedOut: boolean;
      truncated: boolean;
    }>((resolve) => {
      settleResult = () =>
        resolve({
          exitCode: null,
          stderr: "",
          stdout: "4321\n",
          timedOut: false,
          truncated: false,
        });
    });
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: fakeAcknowledgedExecSandboxApi({
        async detach() {
          settleResult();
          throw new Error("durable sessions unavailable");
        },
        async kill() {
          return true;
        },
        async result() {
          return result;
        },
      }) as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });
    const command = await gateway.execute(sandbox, "launch demo", {
      cwd: "/workspace",
      detachAfterFirstStdout: true,
      detachTimeoutMs: 50,
      env: {},
    });

    await expect(command.result()).rejects.toThrow(
      "could not retain its durable session",
    );
  });

  it("bounds the demo launch connection by its short lifecycle deadline", async () => {
    const api = fakeSandboxApi([]);
    api.connect = async () => new Promise(() => undefined);
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 100,
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });

    await expect(
      Promise.race([
        gateway.execute(sandbox, "launch demo", {
          cwd: "/workspace",
          detachAfterFirstStdout: true,
          detachTimeoutMs: 5,
          env: {},
        }),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error("launch connect was not bounded")),
            25,
          );
        }),
      ]),
    ).rejects.toThrow("connect timed out");
  });

  it("builds the pinned recipe and uses only its explicit project token/environment for isolated empty sandboxes", async () => {
    const calls: unknown[] = [];
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: fakeSandboxApi(calls) as never,
      terminalPollIntervalMs: 0,
    });

    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });
    await gateway.destroySandbox(sandbox);

    expect(calls).toContainEqual({ template: true });
    expect(calls).toContainEqual({
      templatePackages: [...railwaySpikeTemplateRecipe.packages.system],
    });
    expect(calls).toContainEqual({ templateWorkdir: "/workspace" });
    expect(calls).toContainEqual(
      expect.objectContaining({
        templateRun: expect.stringContaining("node --version"),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        templateRun: expect.stringContaining(
          "chmod 0555 '/usr/local/bin/makeademo-inspect-submitted-code-toolchain'",
        ),
      }),
    );
    expect(calls).toContainEqual({
      create: {
        authType: "project-token",
        endpoint: "https://backboard.railway.com/graphql/v2",
        env: {
          MAKEADEMO_RAILWAY_SANDBOX_INSTANCE_NONCE: expect.any(String),
        },
        environmentId: "env_canary",
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        tcpProxyWsEndpoint: "wss://ssh.railway.com:2226/ws/exec",
        token: "project-token",
        verbose: false,
      },
      template: "pinned-template",
    });
    expect(calls).toContainEqual({
      connect: {
        id: "created-id",
        options: {
          authType: "project-token",
          endpoint: "https://backboard.railway.com/graphql/v2",
          environmentId: "env_canary",
          tcpProxyWsEndpoint: "wss://ssh.railway.com:2226/ws/exec",
          token: "project-token",
          verbose: false,
        },
      },
    });
    expect(calls).toContainEqual({ destroy: "created-id" });
    expect(calls).toContainEqual({ refresh: "created-id" });
  });

  it("gives every create a distinct instance nonce while preserving caller variables", async () => {
    const calls: unknown[] = [];
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: fakeSandboxApi(calls) as never,
    });

    await gateway.createSandbox({
      env: { CALLER_VALUE: "preserved" },
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });
    await Promise.all([
      gateway.createSandbox({
        env: { CALLER_VALUE: "preserved" },
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      }),
      gateway.createSandbox({
        env: { CALLER_VALUE: "preserved" },
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      }),
    ]);

    const createEnvironments = calls.flatMap((call) => {
      if (typeof call !== "object" || call === null || !("create" in call)) {
        return [];
      }
      return [(call as { create: { env: Record<string, string> } }).create.env];
    });
    expect(createEnvironments).toHaveLength(3);
    expect(createEnvironments).toEqual([
      expect.objectContaining({ CALLER_VALUE: "preserved" }),
      expect.objectContaining({ CALLER_VALUE: "preserved" }),
      expect.objectContaining({ CALLER_VALUE: "preserved" }),
    ]);
    const nonces = createEnvironments.map(
      (environment) => environment.MAKEADEMO_RAILWAY_SANDBOX_INSTANCE_NONCE,
    );
    expect(
      nonces.every((nonce) => typeof nonce === "string" && nonce !== ""),
    ).toBe(true);
    expect(new Set(nonces).size).toBe(3);
  });

  it("rejects a caller-supplied instance nonce before invoking the SDK create", async () => {
    const calls: unknown[] = [];
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: fakeSandboxApi(calls) as never,
    });

    await expect(
      gateway.createSandbox({
        env: { MAKEADEMO_RAILWAY_SANDBOX_INSTANCE_NONCE: "caller-value" },
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("reserved instance nonce");
    expect(calls).not.toContainEqual(
      expect.objectContaining({ create: expect.anything() }),
    );
  });

  it("does not expose the instance nonce when the SDK create fails", async () => {
    let capturedNonce = "";
    const api = fakeSandboxApi([]);
    api.create = async (_template: unknown, options: unknown) => {
      capturedNonce =
        (options as { env: Record<string, string> }).env
          .MAKEADEMO_RAILWAY_SANDBOX_INSTANCE_NONCE ?? "";
      const reflected = new Error(`provider reflected ${capturedNonce}`);
      reflected.name = `ProviderFailure-${capturedNonce}`;
      throw reflected;
    };
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });

    const failure = await gateway
      .createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      })
      .catch((error: unknown) => error);

    expect(capturedNonce).not.toBe("");
    expect(String(failure)).toContain(
      "provider reflected [redacted-instance-nonce]",
    );
    expect(String(failure)).not.toContain(capturedNonce);
  });

  it("adds explicit agent attribution to real SDK GraphQL requests without retaining auth in diagnostics", async () => {
    const requests: Array<{
      caller: string | null;
      hasProjectAuth: boolean;
      session: string | null;
    }> = [];
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          caller: headers.get("x-railway-caller"),
          hasProjectAuth:
            headers.get("project-access-token") === "project-token",
          session: headers.get("x-railway-agent-session"),
        });
        const body = JSON.parse(String(init?.body)) as { query: string };
        return Response.json({
          data: body.query.includes("RailwaySandboxTemplateBuild")
            ? {
                sandboxTemplateBuild: {
                  environmentId: "env_canary",
                  id: "template-id",
                  status: "READY",
                },
              }
            : {
                sandboxCreate: {
                  createdAt: "2026-07-29T00:00:00.000Z",
                  environmentId: "env_canary",
                  id: "created-id",
                  idleTimeoutMinutes: 15,
                  networkIsolation: "ISOLATED",
                  region: "us-west2",
                  status: "RUNNING",
                },
              },
        });
      },
      projectToken: "project-token",
      railwayAgentSession: "railway-session",
      railwayCaller: "skill:use-railway@1.3.6",
    });

    await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 1_000,
    });

    expect(requests).toEqual([
      {
        caller: "skill:use-railway@1.3.6",
        hasProjectAuth: true,
        session: "railway-session",
      },
      {
        caller: "skill:use-railway@1.3.6",
        hasProjectAuth: true,
        session: "railway-session",
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain("project-token");
  });

  it("owns a timeout with TERM, bounded settlement, then KILL without SDK timeoutSec", async () => {
    const signals: string[] = [];
    let settle: (() => void) | undefined;
    const result = new Promise<{
      exitCode: number | null;
      stderr: string;
      stdout: string;
      timedOut: boolean;
      truncated: boolean;
    }>((resolve) => {
      settle = () =>
        resolve({
          exitCode: -1,
          stderr: "partial",
          stdout: "",
          timedOut: false,
          truncated: true,
        });
    });
    const template = {
      run() {
        return template;
      },
      withPackages() {
        return template;
      },
      workdir() {
        return template;
      },
    };
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: {
        template: () => template,
        async create() {
          return { id: "created-id" };
        },
        async connect() {
          return {
            async destroy() {},
            async refresh() {
              return this;
            },
            exec(_command: string, options: unknown) {
              expect(options).not.toHaveProperty("timeoutSec");
              return {
                async kill(signal?: "KILL" | "TERM") {
                  signals.push(signal ?? "KILL");
                  if (signal === "KILL") settle?.();
                  return true;
                },
                async result() {
                  return result;
                },
              };
            },
            files: {
              read: async () => new ReadableStream(),
              write: async () => {},
            },
            id: "created-id",
            status: "RUNNING",
          };
        },
      } as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });
    const command = await gateway.execute(sandbox, "sleep 30", {
      cwd: "/workspace",
      env: {},
      timeoutMs: 1,
    });

    await expect(command.result()).resolves.toMatchObject({
      timedOut: true,
      truncated: true,
    });
    expect(signals).toEqual(["TERM", "KILL"]);
  });

  it("never treats a template build timeout id as a created sandbox", async () => {
    const calls: unknown[] = [];
    const api = fakeSandboxApi(calls);
    api.create = async () => {
      throw Object.assign(new Error("template timed out"), {
        id: "template-build-id",
        resource: "template",
      });
    };
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });

    await expect(
      gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("template timed out");
    await expect(
      gateway.drainPendingCreations({ timeoutMs: 1_000 }),
    ).resolves.toBeUndefined();
    expect(calls.some((call) => JSON.stringify(call).includes("connect"))).toBe(
      false,
    );
  });

  it("destroys the exact sandbox id exposed by a sandbox creation timeout", async () => {
    const calls: unknown[] = [];
    const api = fakeSandboxApi(calls);
    api.create = async () => {
      throw Object.assign(new Error("sandbox timed out"), {
        id: "timed-out-sandbox",
        resource: "sandbox",
      });
    };
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
      terminalPollIntervalMs: 0,
    });

    await expect(
      gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("sandbox timed out");
    expect(calls).toContainEqual({ destroy: "timed-out-sandbox" });
  });

  it("aggregates sandbox creation and exact rollback failures", async () => {
    const api = fakeSandboxApi([]);
    api.create = async () => {
      throw Object.assign(new Error("sandbox timed out"), {
        id: "timed-out-sandbox",
        resource: "sandbox",
      });
    };
    api.connect = async () => {
      throw new Error("rollback connect failed");
    };
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 5,
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });

    const failure = await gateway
      .createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "sandbox timed out" }),
      expect.objectContaining({ message: "rollback connect failed" }),
    ]);
  });

  it("treats an exact owned sandbox not-found during destruction as already destroyed", async () => {
    const api = fakeSandboxApi([]);
    api.connect = async (id: string) => {
      throw new SandboxNotFoundError({
        environmentId: "env_canary",
        id,
      });
    };
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });

    await expect(gateway.destroySandbox(sandbox)).resolves.toBeUndefined();
  });

  it("reconciles an accepted exact destroy when refresh fails but authoritative inventory proves absence", async () => {
    const calls: unknown[] = [];
    const api = fakeSandboxApi(calls);
    api.connect = (async (id: string) => ({
      async destroy() {
        calls.push({ destroy: id });
      },
      exec() {
        throw new Error("not used");
      },
      files: {
        read: async () => new ReadableStream(),
        write: async () => {},
      },
      id,
      async refresh() {
        throw new Error("token=sensitive-project-token sandbox=owned-sandbox");
      },
      status: "RUNNING",
    })) as never;
    const inventoryFetch = vi.fn(async () =>
      Response.json({
        data: {
          sandboxes: {
            edges: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      }),
    );
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 1_000,
      environmentId: "env_canary",
      fetch: inventoryFetch as never,
      projectToken: "sensitive-project-token",
      sandboxApi: api as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });

    await expect(gateway.destroySandbox(sandbox)).resolves.toBeUndefined();
    expect(inventoryFetch).toHaveBeenCalledOnce();
    await expect(gateway.destroySandbox(sandbox)).rejects.toThrow(
      "is not owned by this run",
    );
  });

  it("fails closed with a safe settlement error when authoritative inventory still contains the exact owned sandbox", async () => {
    const api = fakeSandboxApi([]);
    api.connect = (async (id: string) => ({
      async destroy() {},
      exec() {
        throw new Error("not used");
      },
      files: {
        read: async () => new ReadableStream(),
        write: async () => {},
      },
      id,
      async refresh() {
        throw new Error("token=sensitive-project-token sandbox=owned-sandbox");
      },
      status: "RUNNING",
    })) as never;
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 1_000,
      environmentId: "env_canary",
      fetch: (async () =>
        Response.json({
          data: {
            sandboxes: {
              edges: [{ node: { id: "created-id", status: "PAUSING" } }],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        })) as never,
      projectToken: "sensitive-project-token",
      sandboxApi: api as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });

    const error = await gateway.destroySandbox(sandbox).catch((error) => error);
    expect(error).toBeInstanceOf(RailwaySandboxDestroySettlementError);
    expect(String(error)).not.toContain("sensitive-project-token");
    expect(String(error)).not.toContain("created-id");
  });

  it("bounds a never-settling exact connect during destruction", async () => {
    const api = fakeSandboxApi([]);
    api.connect = async () => new Promise(() => undefined);
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 5,
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });

    await expect(gateway.destroySandbox(sandbox)).rejects.toThrow(
      "connect timed out",
    );
  }, 1_000);

  it("clears the provider timeout timer when a command settles early", async () => {
    vi.useFakeTimers();
    try {
      const gateway = new RailwaySdkSandboxGateway({
        environmentId: "env_canary",
        projectToken: "project-token",
        sandboxApi: fakeExecSandboxApi({
          async kill() {
            return true;
          },
          async result() {
            return {
              exitCode: 0,
              stderr: "",
              stdout: "done",
              timedOut: false,
              truncated: false,
            };
          },
        }) as never,
      });
      const sandbox = await gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      });
      const command = await gateway.execute(sandbox, "true", {
        cwd: "/workspace",
        env: {},
        timeoutMs: 60_000,
      });

      await expect(command.result()).resolves.toMatchObject({ stdout: "done" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds never-settling TERM and KILL requests", async () => {
    const signals: string[] = [];
    const gateway = new RailwaySdkSandboxGateway({
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: fakeExecSandboxApi({
        async kill(signal) {
          signals.push(signal ?? "KILL");
          return new Promise(() => undefined);
        },
        async result() {
          return new Promise(() => undefined);
        },
      }) as never,
    });
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 60_000,
    });
    const command = await gateway.execute(sandbox, "sleep 30", {
      cwd: "/workspace",
      env: {},
      timeoutMs: 1,
    });

    await expect(command.result()).rejects.toThrow(
      "did not settle after provider-owned termination",
    );
    expect(signals).toEqual(["TERM", "KILL"]);
  }, 1_000);

  it.each(["destroy", "refresh"] as const)(
    "bounds a never-settling exact %s RPC",
    async (phase) => {
      const gateway = new RailwaySdkSandboxGateway({
        destroyTimeoutMs: 5,
        environmentId: "env_canary",
        projectToken: "project-token",
        sandboxApi: fakeLifecycleSandboxApi(phase) as never,
        terminalPollIntervalMs: 0,
      });
      const sandbox = await gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 60_000,
      });

      await expect(gateway.destroySandbox(sandbox)).rejects.toThrow(
        `${phase} timed out`,
      );
    },
    1_000,
  );

  it("destroys a sandbox that succeeds after the owned create timeout", async () => {
    const calls: unknown[] = [];
    const api = fakeSandboxApi(calls);
    let finishCreate: ((sandbox: { id: string }) => void) | undefined;
    api.create = async () =>
      new Promise((resolve) => {
        finishCreate = resolve;
      });
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 50,
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
      terminalPollIntervalMs: 0,
    });

    const creation = gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 5,
    });
    const deadline = await creation.catch((error: unknown) => error);
    expect(deadline).toMatchObject({
      cleanup: "reconciliation-required",
      elapsedMs: 5,
      phase: "sdk-create",
      resource: "sandbox",
      status: "deadline-exceeded",
    });
    finishCreate?.({ id: "late-sandbox" });
    await gateway.drainPendingCreations({ timeoutMs: 50 });

    expect(calls).toContainEqual({ destroy: "late-sandbox" });
  });

  it("destroys the exact sandbox id retained by a late SDK timeout rejection", async () => {
    const calls: unknown[] = [];
    const api = fakeSandboxApi(calls);
    let rejectCreate: ((error: unknown) => void) | undefined;
    api.create = async () =>
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      });
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 50,
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
      terminalPollIntervalMs: 0,
    });

    const creation = gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      timeoutMs: 5,
    });
    await expect(creation).rejects.toThrow("creation timed out");
    rejectCreate?.(
      Object.assign(new Error("SDK readiness timed out"), {
        id: "late-rejected-sandbox",
        lastStatus: "CREATING",
        resource: "sandbox",
        timeoutMs: 300_000,
      }),
    );
    await gateway.drainPendingCreations({ timeoutMs: 50 });

    expect(calls).toContainEqual({ destroy: "late-rejected-sandbox" });
  });

  it("aggregates the late SDK rejection with exact-id cleanup failure", async () => {
    const api = fakeSandboxApi([]);
    let rejectCreate: ((error: unknown) => void) | undefined;
    api.create = async () =>
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      });
    api.connect = async () => {
      throw new Error("late rejection cleanup failed");
    };
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 20,
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });

    await expect(
      gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("creation timed out");
    rejectCreate?.(
      Object.assign(new Error("SDK readiness timed out"), {
        id: "late-rejected-sandbox",
        lastStatus: "CREATING",
        resource: "sandbox",
        timeoutMs: 300_000,
      }),
    );

    const failure = await gateway
      .drainPendingCreations({ timeoutMs: 50 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(serializeError(failure)).toContain("SDK readiness timed out");
    expect(serializeError(failure)).toContain("late rejection cleanup failed");
  });

  it("bounds a never-settling create without retaining an open timer", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeSandboxApi([]);
      api.create = async () => new Promise(() => undefined);
      const gateway = new RailwaySdkSandboxGateway({
        environmentId: "env_canary",
        projectToken: "project-token",
        sandboxApi: api as never,
      });
      const creation = gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 5,
      });
      const rejection = expect(creation).rejects.toThrow("creation timed out");

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a late-success cleanup failure for bounded reconciliation", async () => {
    const api = fakeSandboxApi([]);
    let finishCreate: ((sandbox: { id: string }) => void) | undefined;
    api.create = async () =>
      new Promise((resolve) => {
        finishCreate = resolve;
      });
    api.connect = async () => {
      throw new Error("late cleanup connect failed");
    };
    const gateway = new RailwaySdkSandboxGateway({
      destroyTimeoutMs: 20,
      environmentId: "env_canary",
      projectToken: "project-token",
      sandboxApi: api as never,
    });

    await expect(
      gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("creation timed out");
    finishCreate?.({ id: "late-sandbox" });

    await expect(
      gateway.drainPendingCreations({ timeoutMs: 50 }),
    ).rejects.toThrow("pending sandbox creation cleanup failed");
  });

  it("surfaces an incomplete custom pending-creation drain without retaining timers", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeSandboxApi([]);
      api.create = async () => new Promise(() => undefined);
      const gateway = new RailwaySdkSandboxGateway({
        environmentId: "env_canary",
        projectToken: "project-token",
        sandboxApi: api as never,
      });
      const creation = gateway.createSandbox({
        env: {},
        idleTimeoutMinutes: 15,
        networkIsolation: "ISOLATED",
        timeoutMs: 1,
      });
      const createFailure =
        expect(creation).rejects.toThrow("creation timed out");
      await vi.advanceTimersByTimeAsync(1);
      await createFailure;

      const drain = gateway.drainPendingCreations({ timeoutMs: 1_000 });
      const drainFailure = expect(drain).rejects.toThrow(
        "pending sandbox creation reconciliation timed out",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await drainFailure;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeLifecycleSandboxApi(neverSettles: "destroy" | "refresh") {
  const template = {
    run() {
      return template;
    },
    withPackages() {
      return template;
    },
    workdir() {
      return template;
    },
  };
  return {
    template: () => template,
    async create() {
      return { id: "created-id" };
    },
    async connect() {
      return {
        async destroy() {
          if (neverSettles === "destroy") return new Promise(() => undefined);
        },
        exec() {
          throw new Error("not used");
        },
        files: {
          read: async () => new ReadableStream(),
          write: async () => {},
        },
        id: "created-id",
        async refresh() {
          if (neverSettles === "refresh") {
            return new Promise(() => undefined);
          }
          return { status: "DESTROYED" };
        },
        status: "RUNNING",
      };
    },
  };
}

function fakeExecSandboxApi(handle: {
  kill(signal?: "KILL" | "TERM"): Promise<boolean>;
  result(): Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut: boolean;
    truncated: boolean;
  }>;
}) {
  const template = {
    run() {
      return template;
    },
    withPackages() {
      return template;
    },
    workdir() {
      return template;
    },
  };
  return {
    template: () => template,
    async create() {
      return { id: "created-id" };
    },
    async connect() {
      return {
        async destroy() {},
        exec() {
          return handle;
        },
        files: {
          read: async () => new ReadableStream(),
          write: async () => {},
        },
        id: "created-id",
        async refresh() {
          return this;
        },
        status: "RUNNING",
      };
    },
  };
}

function fakeAcknowledgedExecSandboxApi(handle: {
  detach(): Promise<string>;
  kill(signal?: "KILL" | "TERM"): Promise<boolean>;
  result(): Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut: boolean;
    truncated: boolean;
  }>;
}) {
  const template = {
    run() {
      return template;
    },
    withPackages() {
      return template;
    },
    workdir() {
      return template;
    },
  };
  return {
    template: () => template,
    async create() {
      return { id: "created-id" };
    },
    async connect() {
      return {
        async destroy() {},
        exec(_command: string, options: unknown) {
          queueMicrotask(() =>
            (options as { onStdout(chunk: string): void }).onStdout("4321\n"),
          );
          return handle;
        },
        files: {
          read: async () => new ReadableStream(),
          write: async () => {},
        },
        id: "created-id",
        async refresh() {
          return this;
        },
        status: "RUNNING",
      };
    },
  };
}

function fakeSandboxApi(calls: unknown[]) {
  return {
    template() {
      calls.push({ template: true });
      const template = {
        run(command: string) {
          calls.push({ templateRun: command });
          return template;
        },
        withPackages(...packages: string[]) {
          calls.push({ templatePackages: packages });
          return template;
        },
        workdir(path: string) {
          calls.push({ templateWorkdir: path });
          return template;
        },
      };
      return template;
    },
    async connect(id: string, options: unknown) {
      calls.push({ connect: { id, options } });
      return {
        async destroy() {
          calls.push({ destroy: id });
        },
        async refresh() {
          calls.push({ refresh: id });
          return { status: "DESTROYED" };
        },
        exec() {
          throw new Error("not used");
        },
        files: {
          read() {
            throw new Error("not used");
          },
          write() {
            throw new Error("not used");
          },
        },
        id,
        status: "DESTROYING",
      };
    },
    async create(template: unknown, options: unknown) {
      calls.push({
        create: options,
        template: template === undefined ? undefined : "pinned-template",
      });
      return { id: "created-id" };
    },
  };
}

function serializeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(serializeError)].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
