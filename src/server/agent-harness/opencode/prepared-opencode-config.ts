import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  defaultOpenCodeModel,
  draftCompositeReviewOpenCodeModel,
} from "./opencode-model-defaults";

export type PreparedOpenCodeFile = {
  content: string;
  path: string;
};

export function createMakeADemoOpenCodeConfigFiles(): PreparedOpenCodeFile[] {
  return [
    {
      content: JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: `${defaultOpenCodeModel.providerID}/${defaultOpenCodeModel.modelID}`,
          permission: {
            "*": "allow",
            bash: "deny",
          },
          provider: {
            [defaultOpenCodeModel.providerID]: {
              models: {
                [defaultOpenCodeModel.modelID]: {
                  options: {
                    reasoningEffort: defaultOpenCodeModel.reasoningEffort,
                  },
                },
                [draftCompositeReviewOpenCodeModel.modelID]: {
                  options: {
                    reasoningEffort:
                      draftCompositeReviewOpenCodeModel.reasoningEffort,
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      path: "opencode.json",
    },
    findDocsSkillFile("skills/find-docs/SKILL.md"),
  ];
}

export function createPreparedOpenCodeFiles(): PreparedOpenCodeFile[] {
  return [findDocsSkillFile(".config/opencode/skills/find-docs/SKILL.md")];
}

export async function writePreparedOpenCodeFiles(
  homeDirectory: string,
): Promise<void> {
  for (const file of createPreparedOpenCodeFiles()) {
    const filePath = join(homeDirectory, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
  }
}

function findDocsSkillFile(path: string): PreparedOpenCodeFile {
  return {
    content: [
      "---",
      "name: find-docs",
      "description: Use Context7 docs via the ctx7 CLI when current library, framework, API, SDK, or CLI documentation is needed.",
      "---",
      "",
      "# Find Docs",
      "",
      "Use Context7 for authoritative technical documentation.",
      "First resolve the library with `ctx7 library <name> <specific query>`.",
      "Then fetch focused documentation with `ctx7 docs <libraryId> <specific query>`.",
      "Do not include secrets, credentials, private repo content, or personal data in Context7 queries.",
      "",
    ].join("\n"),
    path,
  };
}
