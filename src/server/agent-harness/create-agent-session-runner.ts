import type { AgentSessionRunner } from "./agent-session-runner.interface";
import { PiAgentSession } from "./pi/pi-agent-session";
import { createAnonymousExaGlobalAgentTools } from "./tools/global-agent-tools";

export type CreateAgentSessionRunnerOptions = {
  /** Backend-only OpenAI credential; never copied into a workspace. */
  apiKey?: string;
};

/** Creates the default retained-session runner used by MakeADemo agent tasks. */
export function createAgentSessionRunner(
  options: CreateAgentSessionRunnerOptions = {},
): AgentSessionRunner {
  const exa = createAnonymousExaGlobalAgentTools();
  return new PiAgentSession({
    closeGlobalTools: exa.close,
    globalTools: exa.tools,
    ...(options.apiKey === undefined || options.apiKey.length === 0
      ? {}
      : { providerApiKeys: { openai: options.apiKey } }),
  });
}
