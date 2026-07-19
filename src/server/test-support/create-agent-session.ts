import type { AgentSession } from "../agent-harness/agent-session";

/** Creates an opaque Agent Session identity for tests and Pipeline fakes. */
export function createAgentSession(): AgentSession {
  return Object.freeze({}) as AgentSession;
}
