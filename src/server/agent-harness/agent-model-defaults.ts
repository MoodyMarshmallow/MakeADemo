import {
  defaultOpenCodeModel,
  draftCompositeReviewOpenCodeModel,
} from "./opencode/opencode-model-defaults";

/**
 * Default model settings for the primary agent sessions in a MakeADemo run.
 * Pipeline orchestration should depend on this provider-neutral harness contract.
 */
export const defaultAgentModel = defaultOpenCodeModel;

/** Model settings for same-session draft-composite quality review. */
export const draftCompositeReviewAgentModel = draftCompositeReviewOpenCodeModel;
