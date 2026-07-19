import { universalAgentSystemPrompt } from "./prompts/universal-agent-system-prompt";

/** Combines universal harness policy with a single Pipeline stage task. */
export function createAgentTaskPrompt(taskPrompt: string): string {
  return [
    "# MakeADemo Universal Agent Policy",
    universalAgentSystemPrompt,
    "",
    "# Pipeline Task",
    taskPrompt,
  ].join("\n");
}
