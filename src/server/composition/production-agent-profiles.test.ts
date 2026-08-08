import { describe, expect, it } from "vitest";

import { createProductionAgentProfiles } from "./production-agent-profiles";

describe("createProductionAgentProfiles", () => {
  it("maps each Pipeline agent task to its production model profile", () => {
    expect(
      createProductionAgentProfiles({
        modelID: "gpt-5.6-terra",
        providerID: "openai",
      }),
    ).toEqual({
      capturePathRepair: {
        label: "Capture Path repair agent",
        modelID: "gpt-5.6-terra",
        providerID: "openai",
        thinkingLevel: "high",
      },
      draftCompositeReview: {
        label: "Draft Composite review agent",
        modelID: "gpt-5.6-sol",
        providerID: "openai",
        thinkingLevel: "medium",
      },
      preparedApplicationIdentityReview: {
        label: "Prepared Application Identity review agent",
        modelID: "gpt-5.6-terra",
        providerID: "openai",
        thinkingLevel: "high",
      },
      repoPreparation: {
        label: "Repo Preparation",
        modelID: "gpt-5.6-terra",
        providerID: "openai",
        thinkingLevel: "high",
      },
      repoSecurityReview: {
        label: "Repo Security review agent",
        modelID: "gpt-5.6-terra",
        providerID: "openai",
        thinkingLevel: "high",
      },
      scriptGeneration: {
        countCompletedInspectionTools: true,
        label: "Script Generation agent",
        modelID: "gpt-5.6-terra",
        providerID: "openai",
        thinkingLevel: "high",
      },
    });
  });
});
