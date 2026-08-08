import { createPreparationFallbackPrompt } from "./preparation-fallback-prompt";
import {
  createAuthoritativePreparationManifest,
  readPreparationManifest,
  validateNativeVisibleInterfaceProvenance,
} from "./preparation-manifest";
import type {
  RepoPreparationAgent,
  RepoPreparationInput,
  RepoPreparationResult,
} from "./repo-preparation-agent.interface";

export async function prepareRepo(
  input: RepoPreparationInput,
  dependencies: { agent: RepoPreparationAgent },
): Promise<RepoPreparationResult> {
  const result = await dependencies.agent.prepare(input);

  if (result.status === "failed") {
    return {
      fallbackPrompt: createPreparationFallbackPrompt({
        assumptions: result.assumptions,
        blockers: result.blockers,
        repoUrl: input.repoUrl,
        suggestedChanges: result.suggestedChanges,
      }),
      ...(result.failureKind === undefined
        ? {}
        : { failureKind: result.failureKind }),
      ...(result.infrastructure === undefined
        ? {}
        : { infrastructure: result.infrastructure }),
      ...(result.resourceDiagnostics === undefined
        ? {}
        : { resourceDiagnostics: result.resourceDiagnostics }),
      status: "failed",
    };
  }

  if (
    result.applicationIdentityBaseline === undefined ||
    result.preparedWorkspaceDiff === undefined ||
    result.runtimePreflight?.status !== "succeeded"
  ) {
    return {
      fallbackPrompt: createPreparationFallbackPrompt({
        assumptions: [],
        blockers: [
          "MakeADemo infrastructure contract failure: Repo Preparation agent result omitted required backend identity, diff, or successful preflight evidence.",
        ],
        repoUrl: input.repoUrl,
        suggestedChanges: [
          "Report this MakeADemo handoff failure; the preparation agent cannot repair it.",
        ],
      }),
      status: "failed",
    };
  }

  try {
    const manifest = createAuthoritativePreparationManifest(
      readPreparationManifest(result.manifest),
      result.preparedWorkspaceDiff,
    );
    validateNativeVisibleInterfaceProvenance(
      manifest,
      result.applicationIdentityBaseline,
    );
    return {
      applicationIdentityBaseline: result.applicationIdentityBaseline,
      manifest,
      preparedWorkspaceDiff: result.preparedWorkspaceDiff,
      ...(result.agentSession === undefined
        ? {}
        : { agentSession: result.agentSession }),
      status: "succeeded",
      runtimePreflight: {
        ...result.runtimePreflight,
        status: "succeeded" as const,
      },
      ...(result.workspace === undefined
        ? {}
        : { workspace: result.workspace }),
    };
  } catch (error) {
    return {
      fallbackPrompt: createPreparationFallbackPrompt({
        assumptions: [],
        blockers: [
          `Preparation Manifest was invalid: ${error instanceof Error ? error.message : String(error)}`,
        ],
        repoUrl: input.repoUrl,
        suggestedChanges: [
          "Retry repo preparation and return a complete Preparation Manifest JSON object.",
        ],
      }),
      status: "failed",
    };
  }
}
