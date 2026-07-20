import { readPreparationManifest } from "../preparation-manifest";
import type { PreparationWorkspace } from "../preparation-workspace.interface";

/** Agent-authored state lives in the prepared repo, never a control directory. */
export const preparationManifestDirectory = "/workspace/.makeademo";
export const preparationManifestPath = `${preparationManifestDirectory}/preparation-manifest.json`;

export type DependencyInstallRequest = { command: string };
export type ValidationRequest = { manifestPath: string };

/**
 * Reads the only Repo Preparation handoff the agent is allowed to author.
 * Dependency requests, validation results, and submission decisions are held
 * by backend control state and intentionally have no workspace file paths.
 */
export async function readPreparationManifestFile(
  workspace: PreparationWorkspace,
  manifestPath: string,
): Promise<ReturnType<typeof readPreparationManifest>> {
  if (manifestPath !== preparationManifestPath) {
    throw new Error(
      `Validation manifest path must be ${preparationManifestPath}.`,
    );
  }
  const result = await workspace.execute(
    readFileCommand(preparationManifestPath),
  );
  if (result.exitCode !== 0)
    throw new Error("Preparation manifest file is missing.");
  const payload = tryParseJson(result.stdout);
  if (payload === undefined)
    throw new Error("Preparation manifest file contains invalid JSON.");
  return readPreparationManifest(payload);
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readFileCommand(path: string): string {
  return `if test -f ${shellQuote(path)}; then cat ${shellQuote(path)}; else exit 1; fi`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `"'"'`)}'`;
}
