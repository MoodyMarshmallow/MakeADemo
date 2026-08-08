import {
  defaultAgentModel,
  draftCompositeReviewAgentModel,
} from "../agent-harness/agent-model-defaults";
import type { AgentSessionProfile } from "../agent-harness/agent-session-runner.interface";

export type ProductionAgentProfiles = {
  capturePathRepair: AgentSessionProfile;
  draftCompositeReview: AgentSessionProfile;
  preparedApplicationIdentityReview: AgentSessionProfile;
  repoPreparation: AgentSessionProfile;
  repoSecurityReview: AgentSessionProfile;
  scriptGeneration: AgentSessionProfile;
};

/**
 * Creates the fixed production model and activity profiles for each agentic
 * Pipeline Stage. Only Script Generation counts completed inspection tools.
 */
export function createProductionAgentProfiles(input: {
  modelID: string;
  providerID: string;
}): ProductionAgentProfiles {
  return {
    capturePathRepair: {
      label: "Capture Path repair agent",
      modelID: input.modelID,
      providerID: input.providerID,
      thinkingLevel: defaultAgentModel.reasoningEffort,
    },
    draftCompositeReview: {
      label: "Draft Composite review agent",
      modelID: draftCompositeReviewAgentModel.modelID,
      providerID: draftCompositeReviewAgentModel.providerID,
      thinkingLevel: draftCompositeReviewAgentModel.reasoningEffort,
    },
    preparedApplicationIdentityReview: {
      label: "Prepared Application Identity review agent",
      modelID: input.modelID,
      providerID: input.providerID,
      thinkingLevel: defaultAgentModel.reasoningEffort,
    },
    repoPreparation: {
      label: "Repo Preparation",
      modelID: input.modelID,
      providerID: input.providerID,
      thinkingLevel: defaultAgentModel.reasoningEffort,
    },
    repoSecurityReview: {
      label: "Repo Security review agent",
      modelID: input.modelID,
      providerID: input.providerID,
      thinkingLevel: defaultAgentModel.reasoningEffort,
    },
    scriptGeneration: {
      countCompletedInspectionTools: true,
      label: "Script Generation agent",
      modelID: input.modelID,
      providerID: input.providerID,
      thinkingLevel: defaultAgentModel.reasoningEffort,
    },
  };
}
