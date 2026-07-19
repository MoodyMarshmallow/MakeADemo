import { createRepoPreparationToolRuntimeSource } from "../../pipeline/03-repo-preparation/agent-task/tools/repo-preparation-tool-plugin-source";

export type RepoPreparationOpenCodeToolFile = {
  content: string;
  path: string;
};

/** Adapts Pipeline-owned plain tool definitions to OpenCode's tool API. */
export function createRepoPreparationOpenCodeToolFiles(): RepoPreparationOpenCodeToolFile[] {
  return [
    {
      content: createRepoPreparationToolRuntimeSource(),
      path: "repo-preparation-tools-runtime.ts",
    },
    {
      content: createOpenCodeAdapterSource(),
      path: "plugins/makeademo-repo-preparation-tools.ts",
    },
  ];
}

function createOpenCodeAdapterSource(): string {
  return [
    'import { type Plugin, tool } from "@opencode-ai/plugin"',
    'import { repoPreparationToolDefinitions } from "../repo-preparation-tools-runtime"',
    "",
    "function schemaFor(spec) {",
    '  if (spec.type === "enum") return tool.schema.enum(spec.values)',
    '  if (spec.type === "string[]") return tool.schema.array(tool.schema.string()).optional().describe(spec.description)',
    "  return tool.schema.string().describe(spec.description)",
    "}",
    "",
    "export const MakeADemoRepoPreparationToolsPlugin: Plugin = async () => ({",
    "  tool: Object.fromEntries(repoPreparationToolDefinitions.map((definition) => [",
    "    definition.name,",
    "    tool({",
    "      description: definition.description,",
    "      args: Object.fromEntries(Object.entries(definition.args).map(([name, spec]) => [name, schemaFor(spec)])),",
    "      async execute(args) {",
    "        return definition.execute({ args })",
    "      },",
    "    }),",
    "  ])),",
    "})",
    "",
  ].join("\n");
}
