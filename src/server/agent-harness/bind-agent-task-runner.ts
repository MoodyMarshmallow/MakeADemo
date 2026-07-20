import type {
  AgentSessionProfile,
  AgentSessionRunner,
  AgentTaskEvent,
  AgentTaskRunInput,
  AgentTaskRunResult,
  AgentTaskRunner,
} from "./agent-session-runner.interface";
import { AgentSessionTimeoutError } from "./agent-session-timeout";

export type AgentTaskOutputSinkEvent = {
  channel: "diagnostic" | "standard";
  message: string;
};

type AgentProviderFailureCategory =
  | "provider"
  | "provider-auth-invalid"
  | "provider-auth-secret-reference";

export type AgentProviderFailureClassifier = (
  message: string,
) => AgentProviderFailureCategory;

/**
 * Binds provider policy to a shared session runner while exposing only the
 * provider-neutral task contract to Pipeline Stages.
 */
export function bindAgentTaskRunner(
  runner: AgentSessionRunner,
  options: {
    classifyProviderFailure?: AgentProviderFailureClassifier;
    onEvent?: (event: AgentTaskEvent) => void;
    onOutput?: (event: AgentTaskOutputSinkEvent) => void;
    profile: AgentSessionProfile;
  },
): AgentTaskRunner {
  return {
    async run<T>(input: AgentTaskRunInput<T>): Promise<AgentTaskRunResult<T>> {
      const events: AgentTaskEvent[] = [];
      const recordEvent = (event: AgentTaskEvent) => {
        events.push(event);
        options.onEvent?.(event);
      };
      recordEvent({
        event: "agent-task.started",
        kind: "audit",
        metadata: {
          attempt: input.attempt,
          modelID: options.profile.modelID,
          providerID: options.profile.providerID,
          stage: input.stage,
        },
      });
      const emitOutput = (
        channel: AgentTaskOutputSinkEvent["channel"],
        chunk: string,
      ) => {
        recordEvent({ kind: "output", channel, length: chunk.length });
        options.onOutput?.({ channel, message: chunk });
      };
      try {
        const result = await runner.run({
          ...input,
          onStderr: (chunk) => emitOutput("diagnostic", chunk),
          onStdout: (chunk) => emitOutput("standard", chunk),
          profile: options.profile,
        });
        if (result.lastMeaningfulActivity !== undefined) {
          recordEvent({
            activity: result.lastMeaningfulActivity,
            kind: "activity",
          });
        }
        if (result.latestToolName !== undefined) {
          recordEvent({
            event: "agent-task.tool-used",
            kind: "audit",
            metadata: { tool: result.latestToolName },
          });
        }
        recordEvent({
          event: "agent-task.finished",
          kind: "audit",
          metadata: { exitCode: result.exitCode },
        });
        const failure = readFailure(result, options.classifyProviderFailure);
        return {
          exitCode: result.exitCode,
          ...(events.length === 0 ? {} : { events }),
          ...(failure === undefined ? {} : { failure }),
          ...(result.handoff === undefined ? {} : { handoff: result.handoff }),
          ...(result.handoffError === undefined
            ? {}
            : { handoffError: result.handoffError }),
          ...(result.latestToolName === undefined
            ? {}
            : { latestToolName: result.latestToolName }),
          ...(result.lastMeaningfulActivity === undefined
            ? {}
            : { lastMeaningfulActivity: result.lastMeaningfulActivity }),
          ...(result.session === undefined ? {} : { session: result.session }),
          ...(result.structuredOutput === undefined
            ? {}
            : { structuredOutput: result.structuredOutput }),
        };
      } catch (error) {
        if (!(error instanceof AgentSessionTimeoutError)) throw error;
        recordEvent({
          event: "agent-task.timeout",
          kind: "audit",
          metadata: { timeoutKind: error.timeoutKind },
        });
        if (error.lastMeaningfulActivity !== undefined) {
          recordEvent({
            activity: error.lastMeaningfulActivity,
            kind: "activity",
          });
        }
        return {
          exitCode: -1,
          events,
          failure: { category: "timeout", message: error.message },
          ...(error.lastMeaningfulActivity === undefined
            ? {}
            : { lastMeaningfulActivity: error.lastMeaningfulActivity }),
        };
      }
    },
  };
}

function readFailure(
  result: {
    exitCode: number;
    handoffError?: string;
    providerError?: string;
  },
  classifyProviderFailure?: AgentProviderFailureClassifier,
) {
  if (result.providerError !== undefined) {
    const category =
      classifyProviderFailure?.(result.providerError) ?? "provider";
    return {
      category,
      message: result.providerError,
    };
  }
  if (result.exitCode !== 0) {
    return {
      category: "execution" as const,
      message: `Agent task exited with ${result.exitCode}.`,
    };
  }
  if (result.handoffError !== undefined) {
    return { category: "protocol" as const, message: result.handoffError };
  }
  return undefined;
}
