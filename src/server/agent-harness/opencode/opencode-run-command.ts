import { createAgentTaskPrompt } from "../agent-task-prompt";

/** Creates the sole production OpenCode invocation with universal harness policy. */
export function createOpenCodeRunCommand(input: {
  dangerouslySkipPermissions?: boolean;
  model: string;
  sessionID?: string;
  taskPrompt: string;
}): string {
  return [
    "opencode run",
    ...(input.dangerouslySkipPermissions === true
      ? ["--dangerously-skip-permissions"]
      : []),
    "--format json",
    "--dir /workspace",
    ...(input.sessionID === undefined
      ? []
      : [`--session ${shellQuote(input.sessionID)}`]),
    `--model ${shellQuote(input.model)}`,
    shellQuote(createAgentTaskPrompt(input.taskPrompt)),
  ].join(" ");
}

/** Provides OpenCode's task-scoped configuration directory and runtime defaults. */
export function createOpenCodeRunEnv(
  configDirectory: string,
): Record<string, string> {
  return {
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_ENABLE_EXA: "1",
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
