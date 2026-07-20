import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

import type { AgentToolDefinition } from "../agent-session-runner.interface";

/** Adapts a Pipeline-owned tool contract to Pi's TypeBox tool definition. */
export function createPiStageToolDefinitions(
  tools: readonly AgentToolDefinition[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    description: tool.description,
    executionMode: "sequential",
    execute: async (_toolCallId, args) => ({
      content: [
        {
          text: await tool.execute(args as Record<string, unknown>),
          type: "text",
        },
      ],
      details: undefined,
    }),
    label: tool.name,
    name: tool.name,
    parameters: Type.Object(
      Object.fromEntries(
        Object.entries(tool.args).map(([name, argument]) => [
          name,
          argument.optional === true
            ? Type.Optional(createArgumentSchema(argument))
            : createArgumentSchema(argument),
        ]),
      ),
    ),
  }));
}

function createArgumentSchema(
  argument: AgentToolDefinition["args"][string],
): TSchema {
  if (argument.type === "string") {
    return Type.String({ description: argument.description });
  }
  if (argument.type === "string[]") {
    return Type.Array(Type.String(), { description: argument.description });
  }
  if (argument.values === undefined || argument.values.length === 0) {
    throw new Error("Enum Agent Tool arguments require at least one value.");
  }
  return Type.Union(
    argument.values.map((value) => Type.Literal(value)),
    { description: argument.description },
  );
}
