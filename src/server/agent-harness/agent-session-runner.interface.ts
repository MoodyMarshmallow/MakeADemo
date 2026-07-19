import type { AgentSession } from "./agent-session";
import type { AgentMeaningfulActivity } from "./agent-session-timeout";

/** Provider-neutral command execution available to an agent turn. */
export interface AgentSessionWorkspace {
  cancelActiveCommands?: () => Promise<void> | void;
  execute(
    command: string,
    options: {
      env: Record<string, string>;
      onStderr?: (chunk: string) => void;
      onStdout?: (chunk: string) => void;
      timeoutMs: number;
    },
  ): Promise<{ exitCode: number; stderr: string; stdout: string }>;
  writeSandboxLog?: (entry: Record<string, unknown>) => Promise<void> | void;
}

export type AgentSessionProfile = {
  countCompletedInspectionTools?: boolean;
  label: string;
  modelID: string;
  providerID: string;
};

export type AgentToolCall = {
  input: unknown;
  name: string;
  status?: string;
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
  dangerouslySkipPermissions?: boolean;
  hardDeadlineAt: number;
  hardTimeoutMs: number;
  inactivityLabel?: string;
  inactivityTimeoutMs: number;
  profile: AgentSessionProfile;
  taskPrompt: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  session?: AgentSession;
  stage: string;
  toolProtocol?: AgentToolProtocol<T>;
  toolScope?: string;
  workspace: AgentSessionWorkspace;
};

/** Provider-neutral input supplied by a Pipeline Stage to a bound task runner. */
export type AgentTaskRunInput<T = never> = Omit<
  AgentSessionRunInput<T>,
  "dangerouslySkipPermissions" | "onStderr" | "onStdout" | "profile"
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
      length: number;
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
  run<T = never>(
    input: AgentSessionRunInput<T>,
  ): Promise<AgentSessionRunResult<T>>;
}

/** Runs a Pipeline Stage task without exposing provider or model settings. */
export interface AgentTaskRunner {
  run<T = never>(input: AgentTaskRunInput<T>): Promise<AgentTaskRunResult<T>>;
}
