/** An opaque Railway sandbox identity kept independent of the Railway SDK. */
export type RailwaySandboxGatewaySandbox = {
  id: string;
};

type RailwaySandboxGatewayCreateOptions = {
  env: Record<string, string>;
  idleTimeoutMinutes: number;
  networkIsolation: "ISOLATED";
  signal?: AbortSignal;
  timeoutMs: number;
};

export type RailwaySandboxGatewayCommandOptions = {
  cwd: string;
  /** Detach a durable exec only after its first non-empty stdout acknowledgement. */
  detachAfterFirstStdout?: boolean;
  /** Short provider deadline for launch acknowledgement and durable detach. */
  detachTimeoutMs?: number;
  env: Record<string, string>;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  timeoutMs?: number;
};

export type RailwaySandboxGatewayCommandResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
};

/** A running command that can be cancelled without exposing SDK handles. */
export interface RailwaySandboxGatewayCommand {
  kill(signal?: "KILL" | "TERM"): Promise<void>;
  result(): Promise<RailwaySandboxGatewayCommandResult>;
}

/**
 * Product-owned Railway Sandbox boundary. Implementations must use the
 * configured project token and environment only, create isolated sandboxes
 * with no inherited environment, and destroy the exact supplied sandbox id.
 */
export interface RailwaySandboxGateway {
  createSandbox(
    options: RailwaySandboxGatewayCreateOptions,
  ): Promise<RailwaySandboxGatewaySandbox>;
  drainPendingCreations?(options: { timeoutMs: number }): Promise<void>;
  destroySandbox(sandbox: RailwaySandboxGatewaySandbox): Promise<void>;
  execute(
    sandbox: RailwaySandboxGatewaySandbox,
    command: string,
    options: RailwaySandboxGatewayCommandOptions,
  ): Promise<RailwaySandboxGatewayCommand>;
  /**
   * Lists live sandbox ids in this gateway's exact environment scope. The
   * implementation must observe the supplied total deadline and cancellation.
   */
  listActiveSandboxes?(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<readonly RailwaySandboxGatewaySandbox[]>;
  readFile(
    sandbox: RailwaySandboxGatewaySandbox,
    path: string,
    options?: { timeoutMs?: number },
  ): Promise<ReadableStream<Uint8Array>>;
  writeFile(
    sandbox: RailwaySandboxGatewaySandbox,
    path: string,
    content: () => AsyncIterable<Uint8Array>,
    options?: { timeoutMs?: number },
  ): Promise<void>;
}
