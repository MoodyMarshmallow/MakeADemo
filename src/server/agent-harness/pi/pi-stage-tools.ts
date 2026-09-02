import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

import type {
  AgentToolDefinition,
  AgentToolInputSchema,
  AgentToolResult,
} from "../agent-session-runner.interface";

/** Adapts a Pipeline-owned tool contract to Pi's TypeBox tool definition. */
export function createPiStageToolDefinitions(
  tools: readonly AgentToolDefinition<AgentToolResult>[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    description: tool.description,
    executionMode: "sequential",
    execute: async (_toolCallId, args) => {
      const result = await tool.execute(args as Record<string, unknown>);
      return {
        content:
          typeof result === "string"
            ? [{ text: result, type: "text" as const }]
            : [...result],
        details: undefined,
      };
    },
    label: tool.name,
    name: tool.name,
    parameters:
      tool.inputSchema === undefined
        ? Type.Object(
            Object.fromEntries(
              Object.entries(tool.args).map(([name, argument]) => [
                name,
                argument.optional === true
                  ? Type.Optional(createArgumentSchema(argument))
                  : createArgumentSchema(argument),
              ]),
            ),
          )
        : createStructuredInputSchema(tool.inputSchema),
  }));
}

function createStructuredInputSchema(schema: AgentToolInputSchema): TSchema {
  const description =
    schema.description === undefined ? {} : { description: schema.description };
  switch (schema.type) {
    case "string":
      return Type.String({
        ...description,
        ...(schema.maxLength === undefined
          ? {}
          : { maxLength: schema.maxLength }),
        ...(schema.minLength === undefined
          ? {}
          : { minLength: schema.minLength }),
      });
    case "integer":
      return Type.Integer({
        ...description,
        ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
        ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
      });
    case "literal":
      return Type.Literal(schema.const, description);
    case "enum":
      if (schema.values.length === 0) {
        throw new Error("Enum Agent Tool schemas require at least one value.");
      }
      return Type.Union(
        schema.values.map((value) => Type.Literal(value)),
        description,
      );
    case "array":
      return Type.Array(createStructuredInputSchema(schema.items), {
        ...description,
        ...(schema.maxItems === undefined ? {} : { maxItems: schema.maxItems }),
        ...(schema.minItems === undefined ? {} : { minItems: schema.minItems }),
      });
    case "object": {
      const required = new Set(schema.required);
      return Type.Object(
        Object.fromEntries(
          Object.entries(schema.properties).map(([name, property]) => [
            name,
            required.has(name)
              ? createStructuredInputSchema(property)
              : Type.Optional(createStructuredInputSchema(property)),
          ]),
        ),
        { ...description, additionalProperties: false },
      );
    }
    case "oneOf":
      if (schema.oneOf.length === 0) {
        throw new Error(
          "One-of Agent Tool schemas require at least one option.",
        );
      }
      return Type.Union(
        schema.oneOf.map(createStructuredInputSchema),
        description,
      );
  }
}

function createArgumentSchema(
  argument: AgentToolDefinition<AgentToolResult>["args"][string],
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
