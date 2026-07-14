import { defaultOpenCodeModel } from "../../shared/integrations/agents/opencode-model-defaults";

export type PreCaptureCliOptions = {
  commitSha?: string;
  docs: string[];
  features: string[];
  modelID: string;
  providerID: string;
  repoUrl: string;
  workspaceId: string;
};

export function parsePreCaptureCliArgs(args: string[]): PreCaptureCliOptions {
  const docs: string[] = [];
  const features: string[] = [];
  let commitSha: string | undefined;
  let modelID: string = defaultOpenCodeModel.modelID;
  let providerID: string = defaultOpenCodeModel.providerID;
  let repoUrl: string | undefined;
  let workspaceId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--commit":
        commitSha = readCommitSha(readValue(args, index, arg));
        index += 1;
        break;
      case "--doc":
        docs.push(readValue(args, index, arg));
        index += 1;
        break;
      case "--feature":
        features.push(readValue(args, index, arg));
        index += 1;
        break;
      case "--model":
        modelID = readValue(args, index, arg);
        index += 1;
        break;
      case "--provider":
        providerID = readValue(args, index, arg);
        index += 1;
        break;
      case "--repo":
        repoUrl = readValue(args, index, arg);
        index += 1;
        break;
      case "--workspace-id":
        workspaceId = readValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (repoUrl === undefined) {
    throw new Error("--repo is required");
  }

  if (features.length === 0) {
    throw new Error("at least one --feature is required");
  }

  return {
    ...(commitSha === undefined ? {} : { commitSha }),
    docs,
    features,
    modelID,
    providerID,
    repoUrl,
    workspaceId: workspaceId ?? createWorkspaceId(repoUrl),
  };
}

function readCommitSha(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error("--commit must be a full 40-character Git SHA");
  }

  return value.toLowerCase();
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} must be followed by a value`);
  }

  return value;
}

function createWorkspaceId(repoUrl: string): string {
  const slug = repoUrl
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return `workspace-${slug}-${Date.now()}`;
}
