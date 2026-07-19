import { parsePreCaptureCliArgs } from "../pipeline/00-orchestration/pre-capture-cli-options";
import {
  type ProductionAgentModelConfig,
  resolveProductionAgentModelConfig,
} from "./production-agent-model-config";

type ProductionPipelineCliOptions = {
  commitSha?: string;
  docs: string[];
  features: string[];
  repoUrl: string;
  workspaceId: string;
};

export type ProductionAgentCliOptions = {
  agentModel: ProductionAgentModelConfig;
  pipeline: ProductionPipelineCliOptions;
};

/** Parses the full CLI, keeping provider/model flags at the composition boundary. */
export function parseProductionAgentCliArgs(
  args: string[],
): ProductionAgentCliOptions {
  const pipelineArgs: string[] = [];
  let modelID: string | undefined;
  let providerID: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) break;
    switch (arg) {
      case "--model":
        modelID = readValue(args, index, arg);
        index += 1;
        break;
      case "--provider":
        providerID = readValue(args, index, arg);
        index += 1;
        break;
      default:
        pipelineArgs.push(arg);
        if (
          arg === "--commit" ||
          arg === "--doc" ||
          arg === "--feature" ||
          arg === "--repo" ||
          arg === "--workspace-id"
        ) {
          const value = args[index + 1];
          if (value === undefined)
            throw new Error(`${arg} must be followed by a value`);
          pipelineArgs.push(value);
          index += 1;
        }
    }
  }

  return {
    agentModel: resolveProductionAgentModelConfig({
      ...(modelID === undefined ? {} : { modelID }),
      ...(providerID === undefined ? {} : { providerID }),
    }),
    pipeline: parsePreCaptureCliArgs(pipelineArgs),
  };
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${flag} must be followed by a value`);
  return value;
}
