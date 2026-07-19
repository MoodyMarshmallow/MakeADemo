import type {
  AgentSessionProfile,
  AgentSessionRunner,
  AgentSessionWorkspace,
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

export type AgentProviderFailureCategory =
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
    dangerouslySkipPermissions: boolean;
    prepareWorkspace?: (input: {
      hardDeadlineAt: number;
      inactivityTimeoutMs: number;
      timeoutMs: number;
      toolScope: string;
      workspace: AgentSessionWorkspace;
    }) => Promise<void>;
    onOutput?: (event: AgentTaskOutputSinkEvent) => void;
    profile: AgentSessionProfile;
  },
): AgentTaskRunner {
  const preparedWorkspaces = new WeakSet<object>();
  return {
    async run<T>(input: AgentTaskRunInput<T>): Promise<AgentTaskRunResult<T>> {
      const events: AgentTaskEvent[] = [
        {
          event: "agent-task.started",
          kind: "audit",
          metadata: { attempt: input.attempt, stage: input.stage },
        },
      ];
      if (
        input.toolScope !== undefined &&
        options.prepareWorkspace !== undefined &&
        !preparedWorkspaces.has(input.workspace)
      ) {
        try {
          const remainingHardMs = input.hardDeadlineAt - Date.now();
          if (remainingHardMs <= 0) {
            throw new WorkspacePreparationTimeoutError("hard-cap", input);
          }
          await runWorkspacePreparationWithTimeout(
            () =>
              options.prepareWorkspace?.({
                hardDeadlineAt: input.hardDeadlineAt,
                inactivityTimeoutMs: input.inactivityTimeoutMs,
                timeoutMs: Math.max(
                  1,
                  Math.min(remainingHardMs, input.inactivityTimeoutMs),
                ),
                toolScope: input.toolScope as string,
                workspace: input.workspace,
              }),
            input,
          );
        } catch (error) {
          if (!(error instanceof WorkspacePreparationTimeoutError)) throw error;
          events.push({
            event: "agent-task.timeout",
            kind: "audit",
            metadata: { timeoutKind: error.timeoutKind },
          });
          return {
            exitCode: -1,
            events,
            failure: { category: "timeout", message: error.message },
          };
        }
        preparedWorkspaces.add(input.workspace);
      }
      const emitOutput = (
        channel: AgentTaskOutputSinkEvent["channel"],
        chunk: string,
      ) => {
        events.push({ kind: "output", channel, length: chunk.length });
        options.onOutput?.({ channel, message: chunk });
      };
      try {
        const result = await runner.run({
          ...input,
          dangerouslySkipPermissions: options.dangerouslySkipPermissions,
          onStderr: (chunk) => emitOutput("diagnostic", chunk),
          onStdout: (chunk) => emitOutput("standard", chunk),
          profile: options.profile,
        });
        if (result.lastMeaningfulActivity !== undefined) {
          events.push({
            activity: result.lastMeaningfulActivity,
            kind: "activity",
          });
        }
        events.push({
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
        events.push({
          event: "agent-task.timeout",
          kind: "audit",
          metadata: { timeoutKind: error.timeoutKind },
        });
        if (error.lastMeaningfulActivity !== undefined) {
          events.push({
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

class WorkspacePreparationTimeoutError extends Error {
  readonly timeoutKind: "hard-cap" | "inactivity";

  constructor(
    timeoutKind: "hard-cap" | "inactivity",
    input: WorkspacePreparationInput,
  ) {
    super(
      timeoutKind === "hard-cap"
        ? `Agent workspace preparation exceeded its hard cap of ${input.hardTimeoutMs}ms.`
        : `Agent workspace preparation timed out after ${input.inactivityTimeoutMs}ms of inactivity.`,
    );
    this.name = "WorkspacePreparationTimeoutError";
    this.timeoutKind = timeoutKind;
  }
}

async function runWorkspacePreparationWithTimeout(
  prepare: () => Promise<void> | undefined,
  input: WorkspacePreparationInput,
): Promise<void> {
  const remainingHardMs = input.hardDeadlineAt - Date.now();
  const timeoutMs = Math.max(
    1,
    Math.min(remainingHardMs, input.inactivityTimeoutMs),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(prepare),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutKind =
            remainingHardMs <= input.inactivityTimeoutMs
              ? "hard-cap"
              : "inactivity";
          try {
            const cancellation = input.workspace.cancelActiveCommands?.();
            void Promise.resolve(cancellation).catch(() => undefined);
          } catch {
            // Cancellation is best-effort; preserve the normalized timeout.
          }
          reject(new WorkspacePreparationTimeoutError(timeoutKind, input));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type WorkspacePreparationInput = Pick<
  AgentTaskRunInput<unknown>,
  "hardDeadlineAt" | "hardTimeoutMs" | "inactivityTimeoutMs" | "workspace"
>;

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
