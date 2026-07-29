import { Sandbox, SandboxNotFoundError } from "railway";

import type {
  RailwaySandboxGateway,
  RailwaySandboxGatewayCommand,
  RailwaySandboxGatewayCommandOptions,
  RailwaySandboxGatewayCommandResult,
  RailwaySandboxGatewaySandbox,
} from "./railway-sandbox-gateway.interface";
import { railwaySpikeTemplateRecipe } from "./railway-spike-template-recipe";

type RailwaySdkExecHandle = {
  detach(): Promise<string>;
  kill(signal?: "KILL" | "TERM"): Promise<boolean>;
  result(): Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut: boolean;
    truncated: boolean;
  }>;
};

type RailwaySdkSandbox = {
  destroy(): Promise<void>;
  exec(command: string, options: unknown): RailwaySdkExecHandle;
  files: {
    read(
      path: string,
      options: { format: "stream" },
    ): Promise<ReadableStream<Uint8Array>>;
    write(
      path: string,
      content: () => AsyncIterable<Uint8Array>,
    ): Promise<void>;
  };
  id: string;
  refresh(): Promise<RailwaySdkSandbox>;
  status: string;
};

type RailwaySdkSandboxTemplate = {
  run(command: string): RailwaySdkSandboxTemplate;
  withPackages(...packages: string[]): RailwaySdkSandboxTemplate;
  workdir(path: string): RailwaySdkSandboxTemplate;
};

type RailwaySdkSandboxApi = {
  connect(id: string, options: unknown): Promise<RailwaySdkSandbox>;
  create(
    template: RailwaySdkSandboxTemplate,
    options: unknown,
  ): Promise<RailwaySdkSandbox>;
  template(): RailwaySdkSandboxTemplate;
};

type RailwayGraphqlFetch = ((
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>) & {
  preconnect?: typeof fetch.preconnect;
};

export type RailwaySdkSandboxGatewayOptions = {
  destroyTimeoutMs?: number;
  environmentId: string;
  fetch?: RailwayGraphqlFetch;
  inventoryNow?: () => number;
  inventoryRpcTimeoutMs?: number;
  inventoryTotalTimeoutMs?: number;
  projectToken: string;
  railwayAgentSession?: string;
  railwayCaller?: string;
  sandboxApi?: RailwaySdkSandboxApi;
  terminalPollIntervalMs?: number;
};

const defaultDestroyTimeoutMs = 30_000;
const defaultInventoryRpcTimeoutMs = 10_000;
const defaultInventoryTotalTimeoutMs = 30_000;
const defaultTerminalPollIntervalMs = 250;
const officialRailwayGraphqlEndpoint =
  "https://backboard.railway.com/graphql/v2";
const officialRailwayExecEndpoint = "wss://ssh.railway.com:2226/ws/exec";
const activeInventoryQuery = `
  query RailwaySandboxes($environmentId: String!, $after: String) {
    sandboxes(environmentId: $environmentId, after: $after) {
      edges { node { id status } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Safe, provider-owned inventory failure without token or sandbox-id data. */
export class RailwaySandboxInventoryError extends Error {
  override readonly name = "RailwaySandboxInventoryError";

  constructor(
    readonly code:
      | "invalid-cursor"
      | "malformed-response"
      | "pagination-timeout"
      | "provider-errors"
      | "request-failed"
      | "request-timeout"
      | "transport-unavailable",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

/**
 * Railway SDK adapter. This is the only non-POC module that imports the
 * Railway SDK; callers see only provider-neutral sandbox and stream types.
 */
export class RailwaySdkSandboxGateway implements RailwaySandboxGateway {
  private readonly destroyTimeoutMs: number;
  private readonly inventoryRpcTimeoutMs: number;
  private readonly inventoryTotalTimeoutMs: number;
  private readonly inventoryNow: () => number;
  private readonly sandboxApi: RailwaySdkSandboxApi;
  private readonly terminalPollIntervalMs: number;
  private readonly ownedSandboxIds = new Set<string>();
  private readonly pendingCreationDiagnostics: unknown[] = [];
  private readonly pendingCreations = new Set<Promise<void>>();
  private template: RailwaySdkSandboxTemplate | undefined;

  constructor(private readonly options: RailwaySdkSandboxGatewayOptions) {
    if (
      options.projectToken.trim() === "" ||
      options.environmentId.trim() === ""
    ) {
      throw new Error(
        "Railway sandbox gateway requires an explicit project token and environment id.",
      );
    }
    this.destroyTimeoutMs = options.destroyTimeoutMs ?? defaultDestroyTimeoutMs;
    this.inventoryRpcTimeoutMs =
      options.inventoryRpcTimeoutMs ?? defaultInventoryRpcTimeoutMs;
    this.inventoryTotalTimeoutMs =
      options.inventoryTotalTimeoutMs ?? defaultInventoryTotalTimeoutMs;
    this.inventoryNow = options.inventoryNow ?? Date.now;
    this.terminalPollIntervalMs =
      options.terminalPollIntervalMs ?? defaultTerminalPollIntervalMs;
    this.sandboxApi =
      options.sandboxApi ?? (Sandbox as unknown as RailwaySdkSandboxApi);
  }

  async createSandbox(
    options: Parameters<RailwaySandboxGateway["createSandbox"]>[0],
  ): Promise<RailwaySandboxGatewaySandbox> {
    let abandoned = false;
    const sdkCreation = this.sandboxApi.create(this.getTemplate(), {
      ...this.sdkOptions(),
      env: options.env,
      idleTimeoutMinutes: options.idleTimeoutMinutes,
      networkIsolation: options.networkIsolation,
    });
    const reconciliation = sdkCreation.then(
      async (sandbox) => {
        if (!abandoned) return;
        this.ownedSandboxIds.add(sandbox.id);
        try {
          await this.destroySandbox({ id: sandbox.id });
        } catch (error) {
          this.pendingCreationDiagnostics.push(error);
        }
      },
      async (error: unknown) => {
        if (!abandoned) return;
        const id = knownCreatedSandboxId(error);
        if (id === undefined) return;
        this.ownedSandboxIds.add(id);
        try {
          await this.destroySandbox({ id });
        } catch (cleanupError) {
          this.pendingCreationDiagnostics.push(
            new AggregateError(
              [error, cleanupError],
              `Railway late sandbox ${id} rejection cleanup failed.`,
            ),
          );
        }
      },
    );
    this.pendingCreations.add(reconciliation);
    void reconciliation.finally(() =>
      this.pendingCreations.delete(reconciliation),
    );
    try {
      const sandbox = await withAbortableDeadline(
        sdkCreation,
        options.timeoutMs,
        options.signal,
        "Railway sandbox creation timed out.",
      );
      this.ownedSandboxIds.add(sandbox.id);
      return { id: sandbox.id };
    } catch (error) {
      abandoned = true;
      const id = knownCreatedSandboxId(error);
      if (id !== undefined) {
        this.ownedSandboxIds.add(id);
        try {
          await this.destroySandbox({ id });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Railway sandbox ${id} creation and rollback failed.`,
          );
        }
      }
      throw error;
    }
  }

  async listActiveSandboxes(
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<readonly RailwaySandboxGatewaySandbox[]> {
    const fetchImplementation = this.attributedFetch() ?? globalThis.fetch;
    if (fetchImplementation === undefined) {
      throw new Error(
        "Railway sandbox active inventory requires a fetch implementation.",
      );
    }
    const deadline =
      this.inventoryNow() +
      Math.min(
        this.inventoryTotalTimeoutMs,
        options.timeoutMs ?? this.inventoryTotalTimeoutMs,
      );
    const active: RailwaySandboxGatewaySandbox[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const remaining = deadline - this.inventoryNow();
      if (remaining <= 0) {
        throw new RailwaySandboxInventoryError(
          "pagination-timeout",
          "Railway sandbox active inventory pagination timed out.",
        );
      }
      const page = await fetchInventoryPage({
        after,
        environmentId: this.options.environmentId,
        fetchImplementation,
        projectToken: this.options.projectToken,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: Math.min(this.inventoryRpcTimeoutMs, remaining),
      });
      for (const sandbox of page.sandboxes) {
        if (isInventoryActiveStatus(sandbox.status)) {
          active.push({ id: sandbox.id });
        }
      }
      if (!page.hasNextPage) return active;
      if (
        page.endCursor === null ||
        page.endCursor === "" ||
        seenCursors.has(page.endCursor)
      ) {
        throw new RailwaySandboxInventoryError(
          "invalid-cursor",
          "Railway sandbox active inventory pagination returned an invalid cursor.",
        );
      }
      seenCursors.add(page.endCursor);
      after = page.endCursor;
    }
  }

  async drainPendingCreations(options: { timeoutMs: number }): Promise<void> {
    const pending = [...this.pendingCreations];
    if (pending.length > 0) {
      const settled = await settleWithin(
        Promise.all(pending),
        options.timeoutMs,
      );
      if (settled === undefined) {
        throw new Error(
          "Railway pending sandbox creation reconciliation timed out.",
        );
      }
    }
    if (this.pendingCreationDiagnostics.length > 0) {
      throw new AggregateError(
        [...this.pendingCreationDiagnostics],
        "Railway pending sandbox creation cleanup failed.",
      );
    }
  }

  async destroySandbox(sandbox: RailwaySandboxGatewaySandbox): Promise<void> {
    if (!this.ownedSandboxIds.has(sandbox.id)) {
      throw new Error(
        `Railway sandbox ${sandbox.id} is not owned by this run.`,
      );
    }
    const deadline = Date.now() + this.destroyTimeoutMs;
    try {
      const connected = await this.connect(
        sandbox,
        remainingMilliseconds(deadline),
      );
      await withDeadline(
        connected.destroy(),
        remainingMilliseconds(deadline),
        `Railway sandbox ${sandbox.id} destroy timed out.`,
      );
      for (;;) {
        const current = await withDeadline(
          connected.refresh(),
          remainingMilliseconds(deadline),
          `Railway sandbox ${sandbox.id} refresh timed out.`,
        );
        if (!isLiveStatus(current.status)) {
          this.ownedSandboxIds.delete(sandbox.id);
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Railway sandbox ${sandbox.id} remained ${current.status} after destroy.`,
          );
        }
        await delay(
          Math.min(
            this.terminalPollIntervalMs,
            remainingMilliseconds(deadline),
          ),
        );
      }
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        this.ownedSandboxIds.delete(sandbox.id);
        return;
      }
      throw error;
    }
  }

  async execute(
    sandbox: RailwaySandboxGatewaySandbox,
    command: string,
    options: RailwaySandboxGatewayCommandOptions,
  ): Promise<RailwaySandboxGatewayCommand> {
    const connected = await this.connect(
      sandbox,
      options.detachAfterFirstStdout
        ? (options.detachTimeoutMs ?? 5_000)
        : this.destroyTimeoutMs,
    );
    let acknowledgeStdout!: () => void;
    const stdoutAcknowledged = new Promise<void>((resolve) => {
      acknowledgeStdout = resolve;
    });
    const handle = connected.exec(command, {
      cwd: options.cwd,
      env: options.env,
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(!options.detachAfterFirstStdout && options.onStdout === undefined
        ? {}
        : {
            onStdout(chunk: string) {
              options.onStdout?.(chunk);
              if (chunk.trim().length > 0) acknowledgeStdout();
            },
          }),
    });
    const result = options.detachAfterFirstStdout
      ? settleProviderOwnedDetachedCommand(
          handle,
          stdoutAcknowledged,
          options.detachTimeoutMs ?? 5_000,
        )
      : settleProviderOwnedCommand(handle, options.timeoutMs);
    const killTimeoutMs = Math.min(options.timeoutMs ?? 5_000, 5_000);
    return {
      async kill(signal = "KILL") {
        await withDeadline(
          handle.kill(signal),
          killTimeoutMs,
          `Railway command ${signal} request timed out.`,
        );
      },
      async result(): Promise<RailwaySandboxGatewayCommandResult> {
        return result;
      },
    };
  }

  async readFile(
    sandbox: RailwaySandboxGatewaySandbox,
    path: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const deadline = Date.now() + (options.timeoutMs ?? this.destroyTimeoutMs);
    const connected = await this.connect(
      sandbox,
      remainingMilliseconds(deadline),
    );
    return withDeadline(
      connected.files.read(path, { format: "stream" }),
      remainingMilliseconds(deadline),
      `Railway sandbox ${sandbox.id} file read timed out.`,
    );
  }

  async writeFile(
    sandbox: RailwaySandboxGatewaySandbox,
    path: string,
    content: () => AsyncIterable<Uint8Array>,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? this.destroyTimeoutMs);
    const connected = await this.connect(
      sandbox,
      remainingMilliseconds(deadline),
    );
    await withDeadline(
      connected.files.write(path, content),
      remainingMilliseconds(deadline),
      `Railway sandbox ${sandbox.id} file write timed out.`,
    );
  }

  private async connect(
    sandbox: RailwaySandboxGatewaySandbox,
    timeoutMs = this.destroyTimeoutMs,
  ): Promise<RailwaySdkSandbox> {
    return withDeadline(
      this.sandboxApi.connect(sandbox.id, this.sdkOptions()),
      timeoutMs,
      `Railway sandbox ${sandbox.id} connect timed out.`,
    );
  }

  private getTemplate(): RailwaySdkSandboxTemplate {
    this.template ??= [
      ...railwaySpikeTemplateRecipe.trustedFiles.map(renderTrustedFile),
      ...railwaySpikeTemplateRecipe.commands,
    ].reduce(
      (template, command) => template.run(command),
      this.sandboxApi
        .template()
        .withPackages(...railwaySpikeTemplateRecipe.packages.system)
        .workdir(railwaySpikeTemplateRecipe.user.workspace),
    );
    return this.template;
  }

  private sdkOptions(): {
    authType: "project-token";
    endpoint: string;
    environmentId: string;
    fetch?: typeof fetch;
    tcpProxyWsEndpoint: string;
    token: string;
    verbose: false;
  } {
    const attributedFetch = this.attributedFetch();
    return {
      authType: "project-token",
      endpoint: officialRailwayGraphqlEndpoint,
      environmentId: this.options.environmentId,
      ...(attributedFetch === undefined ? {} : { fetch: attributedFetch }),
      tcpProxyWsEndpoint: officialRailwayExecEndpoint,
      token: this.options.projectToken,
      verbose: false,
    };
  }

  private attributedFetch(): typeof fetch | undefined {
    const caller = nonEmpty(this.options.railwayCaller);
    const session = nonEmpty(this.options.railwayAgentSession);
    if (
      this.options.fetch === undefined &&
      caller === undefined &&
      session === undefined
    ) {
      return undefined;
    }
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    if (fetchImplementation === undefined) {
      throw new Error(
        "Railway sandbox gateway requires a fetch implementation.",
      );
    }
    return Object.assign(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const headers = new Headers(init?.headers);
        if (caller !== undefined) headers.set("x-railway-caller", caller);
        if (session !== undefined) {
          headers.set("x-railway-agent-session", session);
        }
        return fetchImplementation(input, { ...init, headers });
      },
      {
        preconnect(...args: Parameters<typeof fetch.preconnect>): void {
          fetchImplementation.preconnect?.(...args);
        },
      },
    );
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

type RailwaySandboxInventoryPage = Readonly<{
  endCursor: string | null;
  hasNextPage: boolean;
  sandboxes: readonly Readonly<{ id: string; status: string }>[];
}>;

async function fetchInventoryPage(input: {
  after: string | undefined;
  environmentId: string;
  fetchImplementation: typeof fetch;
  projectToken: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<RailwaySandboxInventoryPage> {
  return withInventoryRequestDeadline(
    async (signal) => {
      let response: Response;
      try {
        response = await input.fetchImplementation(
          officialRailwayGraphqlEndpoint,
          {
            body: JSON.stringify({
              query: activeInventoryQuery,
              variables: {
                ...(input.after === undefined ? {} : { after: input.after }),
                environmentId: input.environmentId,
              },
            }),
            headers: {
              "content-type": "application/json",
              "project-access-token": input.projectToken,
            },
            method: "POST",
            signal,
          },
        );
      } catch {
        if (signal.aborted) {
          throw inventoryAbortReason(signal);
        }
        throw new RailwaySandboxInventoryError(
          "transport-unavailable",
          "Railway sandbox active inventory transport is unavailable.",
        );
      }
      if (!response.ok) {
        throw new RailwaySandboxInventoryError(
          "request-failed",
          `Railway sandbox active inventory request failed with HTTP ${response.status}.`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new RailwaySandboxInventoryError(
          "malformed-response",
          "Railway sandbox active inventory returned malformed JSON.",
          { cause: error },
        );
      }
      return parseInventoryPage(payload);
    },
    input.timeoutMs,
    input.signal,
  );
}

function parseInventoryPage(payload: unknown): RailwaySandboxInventoryPage {
  const envelope = readRecord(payload);
  if (
    envelope.errors !== undefined &&
    (!Array.isArray(envelope.errors) || envelope.errors.length > 0)
  ) {
    throw new RailwaySandboxInventoryError(
      "provider-errors",
      "Railway sandbox active inventory query returned errors.",
    );
  }
  const data = readRecord(envelope.data);
  const connection = readRecord(data.sandboxes);
  const edges = connection.edges;
  const pageInfo = readRecord(connection.pageInfo);
  if (
    !Array.isArray(edges) ||
    typeof pageInfo.hasNextPage !== "boolean" ||
    (pageInfo.endCursor !== null &&
      typeof pageInfo.endCursor !== "string" &&
      pageInfo.endCursor !== undefined)
  ) {
    throw new RailwaySandboxInventoryError(
      "malformed-response",
      "Railway sandbox active inventory returned a malformed page.",
    );
  }
  const sandboxes = edges.map((edge) => {
    const node = readRecord(readRecord(edge).node);
    if (typeof node.id !== "string" || typeof node.status !== "string") {
      throw new RailwaySandboxInventoryError(
        "malformed-response",
        "Railway sandbox active inventory returned a malformed sandbox.",
      );
    }
    return { id: node.id, status: node.status };
  });
  return {
    endCursor:
      typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
    hasNextPage: pageInfo.hasNextPage,
    sandboxes,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RailwaySandboxInventoryError(
      "malformed-response",
      "Railway sandbox active inventory returned a malformed response.",
    );
  }
  return value as Record<string, unknown>;
}

function isInventoryActiveStatus(status: string): boolean {
  return status !== "DESTROYED" && status !== "FAILED";
}

function withInventoryRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const signal =
    callerSignal === undefined
      ? controller.signal
      : AbortSignal.any([callerSignal, controller.signal]);
  const timeoutError = new RailwaySandboxInventoryError(
    "request-timeout",
    "Railway sandbox active inventory request timed out.",
  );
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(inventoryAbortReason(signal));
      return;
    }
    let settled = false;
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      result();
    };
    const onAbort = () => settle(() => reject(inventoryAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      Math.max(1, timeoutMs),
    );
    timeout.unref?.();
    operation(signal).then(
      (value) => {
        settle(() => resolve(value));
      },
      (error: unknown) => {
        settle(() => reject(error));
      },
    );
  });
}

function inventoryAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new RailwaySandboxInventoryError(
        "request-timeout",
        "Railway sandbox active inventory request timed out.",
      );
}

function renderTrustedFile(
  file: (typeof railwaySpikeTemplateRecipe.trustedFiles)[number],
): string {
  const contents = Buffer.from(file.contents, "utf8").toString("base64");
  const parent = file.path.slice(0, file.path.lastIndexOf("/"));
  return `install -d -o root -g root -m 0755 ${shellQuote(parent)} && printf %s ${shellQuote(contents)} | base64 --decode > ${shellQuote(file.path)} && chown root:root ${shellQuote(file.path)} && chmod 0555 ${shellQuote(file.path)}`;
}

function knownCreatedSandboxId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    sandboxId?: unknown;
    id?: unknown;
    resource?: unknown;
  };
  if (candidate.resource !== "sandbox") return undefined;
  const id = candidate.sandboxId ?? candidate.id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)
    ? id
    : undefined;
}

async function settleProviderOwnedCommand(
  handle: RailwaySdkExecHandle,
  timeoutMs: number | undefined,
): Promise<RailwaySandboxGatewayCommandResult> {
  const result = handle.result();
  if (timeoutMs === undefined) return result;
  const terminationTimeoutMs = Math.min(timeoutMs, 5_000);
  const terminationErrors: unknown[] = [];
  const completed = await settleWithin(result, timeoutMs);
  if (completed !== undefined) return completed;
  try {
    await withDeadline(
      handle.kill("TERM"),
      terminationTimeoutMs,
      "Railway command TERM request timed out.",
    );
  } catch (error) {
    terminationErrors.push(error);
  }
  const afterTerm = await settleWithin(result, terminationTimeoutMs);
  if (afterTerm !== undefined) return { ...afterTerm, timedOut: true };
  try {
    await withDeadline(
      handle.kill("KILL"),
      terminationTimeoutMs,
      "Railway command KILL request timed out.",
    );
  } catch (error) {
    terminationErrors.push(error);
  }
  const afterKill = await settleWithin(result, terminationTimeoutMs);
  if (afterKill !== undefined) return { ...afterKill, timedOut: true };
  throw new AggregateError(
    terminationErrors,
    "Railway command did not settle after provider-owned termination.",
  );
}

async function settleProviderOwnedDetachedCommand(
  handle: RailwaySdkExecHandle,
  stdoutAcknowledged: Promise<void>,
  timeoutMs: number,
): Promise<RailwaySandboxGatewayCommandResult> {
  const result = handle.result();
  const first = await waitForResultOrAcknowledgement(
    result,
    stdoutAcknowledged,
    timeoutMs,
  );
  if (first.kind === "result") {
    if (first.value.stdout.trim().length === 0) {
      throw new Error(
        "Railway demo launch ended before emitting its acknowledgement.",
      );
    }
    return first.value;
  }
  if (first.kind === "acknowledgement-timeout") {
    const terminated = await settleProviderOwnedCommand(handle, 1);
    return { ...terminated, timedOut: true };
  }
  const closedDescriptorResult = await settleWithin(
    result,
    Math.min(timeoutMs, 25),
  );
  if (
    closedDescriptorResult !== undefined &&
    closedDescriptorResult.exitCode === 0
  ) {
    return closedDescriptorResult;
  }
  try {
    await withDeadline(
      handle.detach(),
      timeoutMs,
      "Railway durable demo launch detach timed out.",
    );
  } catch (detachError) {
    const terminationErrors: unknown[] = [];
    try {
      await settleProviderOwnedCommand(handle, 1);
    } catch (terminationError) {
      terminationErrors.push(terminationError);
    }
    throw new AggregateError(
      [detachError, ...terminationErrors],
      "Railway durable demo launch could not retain its durable session.",
    );
  }
  const detachedResult = await withDeadline(
    result,
    timeoutMs,
    "Railway detached demo launch acknowledgement did not settle.",
  );
  return {
    ...detachedResult,
    // A durable detach has no process exit status. The acknowledged launch
    // itself succeeded; later readiness and process-state checks own the app.
    exitCode: detachedResult.exitCode ?? 0,
  };
}

function waitForResultOrAcknowledgement(
  result: Promise<RailwaySandboxGatewayCommandResult>,
  stdoutAcknowledged: Promise<void>,
  timeoutMs: number,
): Promise<
  | { kind: "acknowledged" }
  | { kind: "acknowledgement-timeout" }
  | { kind: "result"; value: RailwaySandboxGatewayCommandResult }
> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (
      outcome: () =>
        | { kind: "acknowledged" }
        | { kind: "acknowledgement-timeout" }
        | { kind: "result"; value: RailwaySandboxGatewayCommandResult },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome());
    };
    const timer = setTimeout(
      () => settle(() => ({ kind: "acknowledgement-timeout" })),
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    result.then(
      (value) => settle(() => ({ kind: "result", value })),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
    stdoutAcknowledged.then(
      () => settle(() => ({ kind: "acknowledged" })),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function settleWithin<T>(
  result: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs));
    timer.unref?.();
    result.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isLiveStatus(status: string): boolean {
  return (
    status === "CREATING" || status === "RUNNING" || status === "DESTROYING"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(message)),
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function withAbortableDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new DOMException("Railway sandbox creation was aborted.", "AbortError"),
      );
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(
        new DOMException("Railway sandbox creation was aborted.", "AbortError"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => {
        cleanup();
        reject(
          Object.assign(new Error(timeoutMessage), {
            cleanup: "reconciliation-required" as const,
            elapsedMs: timeoutMs,
            phase: "sdk-create" as const,
            resource: "sandbox" as const,
            status: "deadline-exceeded" as const,
          }),
        );
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
