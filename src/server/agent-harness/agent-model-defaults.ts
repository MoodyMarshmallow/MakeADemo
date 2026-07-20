/**
 * Default model settings for the primary agent sessions in a MakeADemo run.
 * Pipeline orchestration should depend on this provider-neutral harness contract.
 */
export const defaultAgentModel = {
  modelID: "gpt-5.6-terra",
  providerID: "openai",
  reasoningEffort: "high",
} as const;

/** Model settings for same-session draft-composite quality review. */
export const draftCompositeReviewAgentModel = {
  modelID: "gpt-5.6-sol",
  providerID: "openai",
  reasoningEffort: "medium",
} as const;
