import type { AgentProviderFailureClassifier } from "./bind-agent-task-runner";

/**
 * Classifies provider errors using bounded, provider-neutral credential signals.
 * Deliberately leaves rate limits, outages, and other provider failures generic.
 */
export const classifyProviderFailure: AgentProviderFailureClassifier = (
  message,
) => {
  const normalized = message.toLowerCase();
  const credentialRejection =
    /\b401\b|\bunauthorized\b|invalid[_ -]?api[_ -]?key|(?:api[_ -]?key|credential|token)[^\n.]{0,80}\b(?:invalid|incorrect|rejected)\b|\b(?:invalid|incorrect|rejected)[^\n.]{0,80}\b(?:api[_ -]?key|credential|token)\b|\bauthentication[^\n.]{0,80}\b(?:failed|invalid|rejected)\b/;
  return credentialRejection.test(normalized)
    ? "provider-auth-invalid"
    : "provider";
};
