import type { AgentSession } from "../agent-session";
import type {
  AgentSessionRunInput,
  AgentSessionRunResult,
  AgentSessionRunner,
  AgentToolCall,
} from "../agent-session-runner.interface";
import { writeOpenCodeActivityLog } from "./opencode-activity-log";
import {
  createMeaningfulActivityTracker,
  runWithMeaningfulActivityTimeout,
} from "./opencode-meaningful-activity-timeout";
import {
  createOpenCodeProtocolTracker,
  parseOpenCodeJsonPayload,
} from "./opencode-protocol";
import {
  createOpenCodeRunCommand,
  createOpenCodeRunEnv,
} from "./opencode-run-command";

export type OpenCodeAgentSessionOptions = {
  configDirectoriesByToolScope?: Readonly<Record<string, string>>;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
};

/** Executes provider-neutral turns through OpenCode while retaining opaque sessions. */
export class OpenCodeAgentSession implements AgentSessionRunner {
  private readonly options: OpenCodeAgentSessionOptions;
  private readonly sessions = new WeakMap<AgentSession, string>();

  constructor(options: OpenCodeAgentSessionOptions = {}) {
    this.options = options;
  }

  async run<T = never>(
    input: AgentSessionRunInput<T>,
  ): Promise<AgentSessionRunResult<T>> {
    const providerSessionID =
      input.session === undefined
        ? undefined
        : this.readSessionID(input.session);
    const protocol = createOpenCodeProtocolTracker({
      trackedToolNames: input.toolProtocol?.trackedNames ?? [],
    });
    const activity = createMeaningfulActivityTracker({
      ...(input.profile.countCompletedInspectionTools === undefined
        ? {}
        : {
            countCompletedInspectionTools:
              input.profile.countCompletedInspectionTools,
          }),
      ...(input.toolProtocol === undefined
        ? {}
        : { completedStageToolNames: input.toolProtocol.trackedNames }),
    });
    let handoff: T | undefined;
    let handoffError: string | undefined;
    let interrupted = false;
    const processToolCall = (call: AgentToolCall | undefined) => {
      if (call === undefined || input.toolProtocol === undefined) return;
      const decoded = input.toolProtocol.decode(call);
      if (decoded.status === "invalid") {
        handoffError = decoded.reason;
        return;
      }
      if (decoded.status !== "accepted") return;
      handoff = decoded.handoff;
      handoffError = undefined;
      if (
        call.status === "completed" &&
        input.toolProtocol.interruptOnCompletedHandoff === true &&
        !interrupted
      ) {
        interrupted = true;
        this.interrupt(input, call.name);
      }
    };
    const onChunk = (channel: "stdout" | "stderr", chunk: string) => {
      activity.write(channel, chunk);
      protocol.write(chunk);
      processToolCall(protocol.readToolCall());
      if (channel === "stdout") {
        this.options.onStdout?.(chunk);
        input.onStdout?.(chunk);
      } else {
        this.options.onStderr?.(chunk);
        input.onStderr?.(chunk);
      }
      void writeOpenCodeActivityLog(input.workspace, {
        attempt: input.attempt,
        channel,
        raw: chunk,
        stage: input.stage,
      });
    };

    const result = await runWithMeaningfulActivityTimeout(
      () =>
        input.workspace.execute(
          createOpenCodeRunCommand({
            ...(input.dangerouslySkipPermissions === undefined
              ? {}
              : {
                  dangerouslySkipPermissions: input.dangerouslySkipPermissions,
                }),
            model: `${input.profile.providerID}/${input.profile.modelID}`,
            ...(providerSessionID === undefined
              ? {}
              : { sessionID: providerSessionID }),
            taskPrompt: input.taskPrompt,
          }),
          removeUndefinedOptions({
            env: createOpenCodeRunEnv(this.configDirectory(input.toolScope)),
            onStderr: (chunk) => onChunk("stderr", chunk),
            onStdout: (chunk) => onChunk("stdout", chunk),
            timeoutMs: Math.max(
              1,
              input.hardDeadlineAt - Date.now() + openCodeHardCapGraceMs,
            ),
          }),
        ),
      {
        activity,
        hardDeadlineAt: input.hardDeadlineAt,
        hardTimeoutMs: input.hardTimeoutMs,
        ...(input.inactivityLabel === undefined
          ? {}
          : { inactivityLabel: input.inactivityLabel }),
        inactivityTimeoutMs: input.inactivityTimeoutMs,
        label: input.profile.label,
        onTimeout: () => input.workspace.cancelActiveCommands?.(),
      },
    );
    if (!protocol.readHasProtocolData()) {
      protocol.write(`\n${result.stdout}\n${result.stderr}\n`);
    }
    processToolCall(protocol.readToolCall());
    const latestCall = protocol.readToolCall();
    const sessionID = protocol.readSessionID();
    const protocolError = protocol.readError();
    const parsedOutput = parseOpenCodeJsonPayload(result.stdout);
    const providerError = protocol.readProviderError();
    const latestToolName = latestCall?.name ?? protocol.readToolName();
    const lastMeaningfulActivity = activity.read();
    if (sessionID !== undefined && input.session !== undefined) {
      this.sessions.set(input.session, sessionID);
    }
    const session =
      sessionID === undefined
        ? input.session
        : (input.session ?? this.createSession(sessionID));
    const finalHandoff = protocolError === undefined ? handoff : undefined;
    const finalHandoffError = protocolError ?? handoffError;
    return {
      ...result,
      ...(finalHandoff === undefined ? {} : { handoff: finalHandoff }),
      ...(finalHandoffError === undefined
        ? {}
        : { handoffError: finalHandoffError }),
      ...(providerError === undefined ? {} : { providerError }),
      ...(latestToolName === undefined ? {} : { latestToolName }),
      ...(lastMeaningfulActivity === undefined
        ? {}
        : { lastMeaningfulActivity }),
      ...(session === undefined ? {} : { session }),
      ...(parsedOutput === undefined ? {} : { structuredOutput: parsedOutput }),
    };
  }

  private createSession(providerSessionID: string): AgentSession {
    const session = Object.freeze({}) as AgentSession;
    this.sessions.set(session, providerSessionID);
    return session;
  }

  private readSessionID(session: AgentSession): string {
    const providerSessionID = this.sessions.get(session);
    if (providerSessionID === undefined) {
      throw new Error(
        "AgentSession is not backed by an OpenCode provider session ID.",
      );
    }
    return providerSessionID;
  }

  private configDirectory(toolScope: string | undefined): string {
    return (
      (toolScope === undefined
        ? undefined
        : this.options.configDirectoriesByToolScope?.[toolScope]) ??
      makeADemoOpenCodeConfigDirectory
    );
  }

  private interrupt<T>(input: AgentSessionRunInput<T>, toolName: string): void {
    const writeInterruptionLog = (event: string, error?: unknown) => {
      try {
        void Promise.resolve(
          input.workspace.writeSandboxLog?.({
            attempt: input.attempt,
            event,
            ...(error === undefined ? {} : { error: readErrorMessage(error) }),
            stage: input.stage,
            toolName,
          }),
        ).catch(() => undefined);
      } catch {
        // Interruption audit logging is best effort.
      }
    };
    void writeInterruptionLog("opencode-interruption.started");
    let cancellation: Promise<void>;
    try {
      cancellation = Promise.resolve(
        input.workspace.cancelActiveCommands?.(),
      ).then(() => undefined);
    } catch (error) {
      cancellation = Promise.reject(error);
    }
    void cancellation
      .then(() => writeInterruptionLog("opencode-interruption.succeeded"))
      .catch((error: unknown) =>
        writeInterruptionLog("opencode-interruption.failed", error),
      );
    void writeOpenCodeActivityLog(input.workspace, {
      attempt: input.attempt,
      channel: "stdout",
      raw: `completed tool handoff: ${toolName}`,
      stage: input.stage,
    });
  }
}

const openCodeHardCapGraceMs = 30_000;
const makeADemoOpenCodeConfigDirectory = "/tmp/makeademo/opencode";

function removeUndefinedOptions(input: {
  env: Record<string, string>;
  onStderr: ((chunk: string) => void) | undefined;
  onStdout: ((chunk: string) => void) | undefined;
  timeoutMs: number;
}) {
  return {
    env: input.env,
    timeoutMs: input.timeoutMs,
    ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
    ...(input.onStdout === undefined ? {} : { onStdout: input.onStdout }),
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
