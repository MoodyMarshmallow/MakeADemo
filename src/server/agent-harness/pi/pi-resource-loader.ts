import {
  DefaultResourceLoader,
  type ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { universalAgentSystemPrompt } from "../prompts/universal-agent-system-prompt";
import { resolveContext7ExtensionPath } from "../tools/context7-extension";

/**
 * Creates a Pi resource loader that cannot discover repository-controlled
 * extensions, skills, prompts, themes, context files, or AGENTS.md files.
 * MakeADemo policy is supplied explicitly by the harness instead.
 */
export async function createPiResourceLoader(input: {
  agentDir: string;
  cwd: string;
  settingsManager?: SettingsManager;
  systemPrompt?: string;
}): Promise<ResourceLoader> {
  if ((process.env.CONTEXT7_API_KEY ?? "").trim().length > 0) {
    throw new Error(
      "CONTEXT7_API_KEY must be unset; MakeADemo uses anonymous Context7 access.",
    );
  }
  const loader = new DefaultResourceLoader({
    agentDir: input.agentDir,
    additionalExtensionPaths: [resolveContext7ExtensionPath()],
    cwd: input.cwd,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: input.settingsManager ?? SettingsManager.inMemory(),
    systemPrompt: input.systemPrompt ?? universalAgentSystemPrompt,
  });
  await loader.reload();
  return loader;
}
