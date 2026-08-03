import {
  type ReadOnlyCommandExecuteOptions,
  type ReadOnlyCommandRequest,
  type ReadOnlyCommandResult,
  canonicalizeReadOnlyCommand,
} from "../../../shared/repository-inspection-command";
import type { AgentToolDefinition } from "../../agent-session-runner.interface";

/**
 * Runs one backend-validated inspection command in a fixed repository root.
 * Implementations must revalidate argv, preserve argument boundaries, use
 * trusted absolute binaries, and expose neither a shell nor caller-supplied
 * cwd, environment, or stdin.
 */
export type ReadOnlyCommandExecutor = {
  execute(
    request: ReadOnlyCommandRequest,
    options: ReadOnlyCommandExecuteOptions,
  ): Promise<ReadOnlyCommandResult>;
};

const maxStdoutBytes = 128 * 1_024;
const maxStderrBytes = 16 * 1_024;
const maxStdoutLines = 2_000;
const maxReviewCalls = 32;
const maxReviewOutputBytes = 2 * 1_024 * 1_024;
const maxReviewExecutionMs = 120_000;

/** Creates the single structured, read-only shell replacement exposed to agents. */
export function createReadOnlyExecCommandTool(
  executor: ReadOnlyCommandExecutor,
): AgentToolDefinition {
  let callCount = 0;
  let executionMs = 0;
  let outputBytes = 0;
  return {
    args: {
      argv: {
        description:
          "Command arguments. The first item must be an allowed read-only utility; shell syntax is never interpreted.",
        type: "string[]",
      },
    },
    description:
      "Inspect the repository with structured argv only. Use rg [safe flags] PATTERN [PATH...], rg --files [safe flags] [PATH...], sed -n START[,END]p -- FILE, or read-only git rev-parse/status/ls-files/show/log/diff queries. There is no shell, cwd, environment, stdin, piping, redirection, or background execution.",
    async execute(args) {
      if (callCount >= maxReviewCalls) {
        throw new Error("exec_command exhausted its 32-call review budget.");
      }
      if (executionMs >= maxReviewExecutionMs) {
        throw new Error("exec_command exhausted its 120-second review budget.");
      }
      if (outputBytes >= maxReviewOutputBytes) {
        throw new Error(
          "exec_command exhausted its 2 MiB review output budget.",
        );
      }
      callCount += 1;
      const argv = readArgv(args.argv);
      canonicalizeReadOnlyCommand({ argv });
      const startedAt = Date.now();
      let result: ReadOnlyCommandResult;
      try {
        result = await executor.execute(
          { argv },
          {
            timeoutMs: Math.min(15_000, maxReviewExecutionMs - executionMs),
          },
        );
      } finally {
        executionMs += Date.now() - startedAt;
      }
      const remainingOutputBytes = maxReviewOutputBytes - outputBytes;
      const stdout = truncateText(result.stdout, {
        maxBytes: Math.min(maxStdoutBytes, remainingOutputBytes),
        maxLines: maxStdoutLines,
      });
      const stdoutBytes = Buffer.byteLength(stdout.value, "utf8");
      const stderr = truncateText(result.stderr, { maxBytes: maxStderrBytes });
      const aggregateStderr = truncateText(stderr.value, {
        maxBytes: Math.max(0, remainingOutputBytes - stdoutBytes),
      });
      outputBytes +=
        stdoutBytes + Buffer.byteLength(aggregateStderr.value, "utf8");
      return JSON.stringify({
        exitCode: result.exitCode,
        stderr: aggregateStderr.value,
        stdout: stdout.value,
        truncated:
          stdout.truncated || stderr.truncated || aggregateStderr.truncated,
      });
    },
    name: "exec_command",
  };
}

function readArgv(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 4_096 &&
        !item.includes("\0"),
    )
  ) {
    throw new Error(
      "exec_command argv must contain between 1 and 64 non-empty strings.",
    );
  }
  return value;
}

function truncateText(
  value: string,
  limits: { maxBytes: number; maxLines?: number },
): { truncated: boolean; value: string } {
  let bounded = value;
  let truncated = false;
  if (limits.maxLines !== undefined) {
    let newlineCount = 0;
    for (let index = 0; index < bounded.length; index += 1) {
      if (bounded[index] !== "\n") continue;
      newlineCount += 1;
      if (newlineCount === limits.maxLines) {
        if (index + 1 < bounded.length) {
          bounded = bounded.slice(0, index + 1);
          truncated = true;
        }
        break;
      }
    }
  }
  const bytes = Buffer.from(bounded, "utf8");
  if (bytes.length > limits.maxBytes) {
    bounded = bytes.subarray(0, limits.maxBytes).toString("utf8");
    while (Buffer.byteLength(bounded, "utf8") > limits.maxBytes) {
      bounded = bounded.slice(0, -1);
    }
    truncated = true;
  }
  return { truncated, value: bounded };
}
