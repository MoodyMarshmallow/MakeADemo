import type { AgentSession } from "./agent-session";
import type { AgentMeaningfulActivity } from "./agent-session-timeout";

/** Provider-neutral command execution available to an agent turn. */
export interface AgentSessionWorkspace {
  cancelActiveCommands?: (() => Promise<void> | void) | undefined;
  execute(
    command: string,
    options: {
      env: Record<string, string>;
      onStderr?: (chunk: string) => void;
      onStdout?: (chunk: string) => void;
      timeoutMs: number;
    },
  ): Promise<{ exitCode: number; stderr: string; stdout: string }>;
  writeSandboxLog?:
    | ((entry: Record<string, unknown>) => Promise<void> | void)
    | undefined;
}

export type AgentSessionProfile = {
  countCompletedInspectionTools?: boolean;
  label: string;
  modelID: string;
  providerID: string;
  thinkingLevel: "high" | "low" | "medium" | "minimal" | "off" | "xhigh";
};

export type AgentToolCall = {
  input: unknown;
  name: string;
  status?: string;
};

/** Provider-emitted tool lifecycle data retained for development diagnostics. */
export type AgentToolExecution = {
  args: unknown;
  isError: boolean;
  name: string;
  result?: unknown;
  status: "completed" | "started";
};

/** Provider-neutral schema and execution contract for a Pipeline Stage tool. */
export type AgentToolDefinition = {
  args: Readonly<
    Record<
      string,
      {
        description: string;
        optional?: boolean;
        type: "enum" | "string" | "string[]";
        values?: readonly string[];
      }
    >
  >;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
  name: string;
};

/**
 * Provider-neutral hard-timeout extension applied during a retry backoff.
 * Consumers must apply `hardDeadlineAt` synchronously, monotonically, and
 * never beyond their immutable Pipeline deadline ceiling.
 */
export type AgentHardDeadlineExtension = {
  appliedExtensionMs: number;
  hardDeadlineAt: number;
};

type AgentToolDecodeResult<T> =
  | { status: "ignored" }
  | { reason: string; status: "invalid" }
  | { handoff: T; status: "accepted" };

/** Stage-owned meaning and validation for provider-neutral agent tool calls. */
export type AgentToolProtocol<T> = {
  decode: (call: AgentToolCall) => AgentToolDecodeResult<T>;
  interruptOnCompletedHandoff?: boolean;
  trackedNames: readonly string[];
};

export type AgentSessionRunInput<T = never> = {
  attempt: number;
  /** Immutable Pipeline deadline; retry extensions must never pass it. */
  deadlineCeilingAt?: number;
  /**
   * Harness execution policy. Transient modes never retain or return a
   * session and dispose provider state after the turn. `tool-free-transient`
   * exposes no tools; `stage-tools-transient` exposes only this turn's Stage
   * Agent Tools.
   */
  executionMode?: "default" | "stage-tools-transient" | "tool-free-transient";
  hardDeadlineAt: number;
  hardTimeoutMs: number;
  inactivityLabel?: string;
  inactivityTimeoutMs: number;
  profile: AgentSessionProfile;
  /** Cancels this task while preserving the caller's cancellation reason. */
  signal?: AbortSignal;
  taskPrompt: string;
  /** Stage-owned tools for this turn; never inferred from provider configuration. */
  tools?: readonly AgentToolDefinition[];
  /** Receives reasoning text or summaries explicitly exposed by the provider. */
  onReasoning?: (content: string) => void;
  /**
   * Receives each applied provider retry extension synchronously while the
   * runner is still in the retry turn; consumers must clamp and apply it
   * monotonically before returning control to the Pipeline Stage.
   */
  onHardDeadlineExtended?: (extension: AgentHardDeadlineExtension) => void;
  /**
   * Receives bounded, provider-neutral audit metadata for a harness lifecycle
   * event. Implementations must never include provider error text or secrets.
   */
  onAudit?: (
    event: string,
    metadata: Readonly<Record<string, boolean | number | string>>,
  ) => void;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /** Receives complete provider-emitted tool lifecycle data. */
  onToolExecution?: (event: AgentToolExecution) => void;
  session?: AgentSession;
  stage: string;
  toolProtocol?: AgentToolProtocol<T>;
  workspace: AgentSessionWorkspace;
};

/** Provider-neutral input supplied by a Pipeline Stage to a bound task runner. */
export type AgentTaskRunInput<T = never> = Omit<
  AgentSessionRunInput<T>,
  | "onAudit"
  | "onReasoning"
  | "onStderr"
  | "onStdout"
  | "onToolExecution"
  | "profile"
>;

export type AgentSessionRunResult<T = never> = {
  exitCode: number;
  handoff?: T;
  handoffError?: string;
  latestToolName?: string;
  lastMeaningfulActivity?: AgentMeaningfulActivity;
  providerError?: string;
  session?: AgentSession;
  stderr: string;
  stdout: string;
  structuredOutput?: unknown;
};

type AgentTaskFailureCategory =
  | "execution"
  | "protocol"
  | "provider"
  | "provider-auth-invalid"
  | "provider-auth-secret-reference"
  | "timeout";

/** A bounded, provider-neutral event summary returned to Pipeline stages. */
export type AgentTaskEvent =
  | {
      kind: "activity";
      activity: AgentMeaningfulActivity;
    }
  | {
      kind: "audit";
      event: string;
      metadata?: Readonly<Record<string, boolean | number | string>>;
    }
  | {
      kind: "output";
      channel: "diagnostic" | "standard";
      content: string;
      length: number;
      outputType: "assistant" | "diagnostic" | "reasoning" | "tool";
    };

export type AgentTaskRunResult<T = never> = {
  exitCode: number;
  events?: readonly AgentTaskEvent[];
  failure?: {
    category: AgentTaskFailureCategory;
    message: string;
  };
  handoff?: T;
  handoffError?: string;
  latestToolName?: string;
  lastMeaningfulActivity?: AgentMeaningfulActivity;
  session?: AgentSession;
  structuredOutput?: unknown;
};

/** Runs one provider-neutral agent turn against an opaque retained session. */
export interface AgentSessionRunner {
  /** Releases retained provider sessions and harness-owned transports. */
  dispose?(session?: AgentSession): Promise<void> | void;
  run<T = never>(
    input: AgentSessionRunInput<T>,
  ): Promise<AgentSessionRunResult<T>>;
}

/** Runs a Pipeline Stage task without exposing provider or model settings. */
export interface AgentTaskRunner {
  run<T = never>(input: AgentTaskRunInput<T>): Promise<AgentTaskRunResult<T>>;
}
