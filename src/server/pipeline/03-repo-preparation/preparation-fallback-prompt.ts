export type PreparationFallbackPromptInput = {
  assumptions: string[];
  blockers: string[];
  repoUrl: string;
  suggestedChanges: string[];
};

export function createPreparationFallbackPrompt(
  input: PreparationFallbackPromptInput,
): string {
  return [
    `Prepare ${input.repoUrl} for MakeADemo.`,
    "Make the repo expose a deterministic browser-accessible demo that runs without secrets, hosted services, OAuth, or external APIs after setup.",
    section("Blockers", input.blockers),
    section("Assumptions", input.assumptions),
    section("Suggested changes", input.suggestedChanges),
  ].join("\n\n");
}

function section(title: string, values: string[]) {
  if (values.length === 0) {
    return `${title}: none`;
  }

  return `${title}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}
