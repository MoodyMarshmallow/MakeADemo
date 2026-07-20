import type {
  AgentToolCall,
  AgentToolProtocol,
} from "../../../../agent-harness/agent-session-runner.interface";
import { repoPreparationToolNames } from "./repo-preparation-tool-definitions";

export { repoPreparationToolNames } from "./repo-preparation-tool-definitions";

type RepoPreparationToolName = (typeof repoPreparationToolNames)[number];

/** Opaque configuration key selected by composition, not by a provider adapter. */
export type RepoPreparationToolHandoff =
  | {
      input: { command: string };
      toolName:
        | "makeademo_dependency_request_install"
        | "makeademo_install_dependencies";
    }
  | {
      input: { manifestPath: string };
      toolName: "makeademo_validate_preparation";
    };

/** Decodes a generic tracked agent call into the Repo Preparation handoff schema. */
export function decodeRepoPreparationToolCall(
  call: AgentToolCall | undefined,
): { error?: string; handoff?: RepoPreparationToolHandoff } {
  if (call === undefined || !isRepoPreparationToolName(call.name)) return {};
  if (call.name === "makeademo_validate_preparation") {
    const manifestPath = readStringField(call.input, "manifestPath");
    return manifestPath === undefined
      ? {
          error: `${call.name} payload is missing required field input.manifestPath`,
        }
      : { handoff: { input: { manifestPath }, toolName: call.name } };
  }
  const command = readStringField(call.input, "command");
  return command === undefined
    ? { error: `${call.name} payload is missing required field input.command` }
    : { handoff: { input: { command }, toolName: call.name } };
}

export const repoPreparationToolProtocol: AgentToolProtocol<RepoPreparationToolHandoff> =
  {
    decode(call) {
      const decoded = decodeRepoPreparationToolCall(call);
      if (decoded.handoff !== undefined)
        return { handoff: decoded.handoff, status: "accepted" };
      if (decoded.error !== undefined)
        return { reason: decoded.error, status: "invalid" };
      return { status: "ignored" };
    },
    interruptOnCompletedHandoff: true,
    trackedNames: repoPreparationToolNames,
  };

function isRepoPreparationToolName(
  name: string,
): name is RepoPreparationToolName {
  return (repoPreparationToolNames as readonly string[]).includes(name);
}

function readStringField(value: unknown, field: string): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[field] === "string"
    ? ((value as Record<string, unknown>)[field] as string)
    : undefined;
}
