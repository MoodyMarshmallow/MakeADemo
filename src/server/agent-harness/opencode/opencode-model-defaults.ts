/** Default OpenCode model settings used by every MakeADemo Pipeline entrypoint. */
export const defaultOpenCodeModel = {
  modelID: "gpt-5.6-terra",
  providerID: "openai",
  reasoningEffort: "high",
} as const;

/** Model settings reserved for same-session Draft Composite quality review. */
export const draftCompositeReviewOpenCodeModel = {
  modelID: "gpt-5.6-sol",
  providerID: "openai",
  reasoningEffort: "medium",
} as const;
