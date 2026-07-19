import type { AgentSessionRunner } from "./agent-session-runner.interface";
import {
  OpenCodeAgentSession,
  type OpenCodeAgentSessionOptions,
} from "./opencode/opencode-agent-session";

/** Creates the default retained-session runner used by MakeADemo agent tasks. */
export function createAgentSessionRunner(
  options: OpenCodeAgentSessionOptions,
): AgentSessionRunner {
  return new OpenCodeAgentSession(options);
}
