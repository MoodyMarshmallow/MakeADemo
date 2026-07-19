import type { AgentProviderFailureCategory } from "../../agent-harness/bind-agent-task-runner";

/** Classifies Daytona/OpenCode provider failures at the provider boundary. */
export function classifyOpenCodeProviderFailure(
  message: string,
): AgentProviderFailureCategory {
  if (/dtn_secr[A-Za-z0-9_*.-]*/.test(message)) {
    return "provider-auth-secret-reference";
  }
  if (
    /invalid[_ ]api[_ ]key|incorrect api key|status\s*code\s*[:=]?\s*401|\b401\b/i.test(
      message,
    )
  ) {
    return "provider-auth-invalid";
  }
  return "provider";
}
