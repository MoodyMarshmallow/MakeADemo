import type { PreparationWorkspace } from "./preparation-workspace.interface";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

export type PreparationWorkspaceHandle = {
  /**
   * Releases a usable Repo Preparation workspace exactly once. Implementations
   * own provider-specific cleanup and should make this operation idempotent;
   * callers must not depend on a particular stop, archive, or delete policy.
   */
  release(): Promise<void>;
  id: string;
  /** Backend-owned catalog selection attached once after trusted inspection. */
  toolchainPlan?: SubmittedCodeToolchainPlan;
  workspace: PreparationWorkspace;
};

/**
 * Cooperative budget for provisioning a Repo Preparation workspace.
 * Providers must stop provisioning when `signal` aborts and must not start or
 * wait beyond `deadlineAt`; callers retain responsibility for releasing a
 * successfully returned handle.
 */
type PreparationWorkspaceCreateOptions = {
  deadlineAt?: number;
  signal?: AbortSignal;
};

/**
 * Provisions isolated workspaces for Repo Preparation.
 * Implementations should hide provider-specific lifecycle, execution, logging,
 * and teardown details behind this product-level seam.
 */
export interface PreparationWorkspaceProvider {
  create(
    options?: PreparationWorkspaceCreateOptions,
  ): Promise<PreparationWorkspaceHandle>;
}

export type PreparationWorkspaceRunResult<T> =
  | { status: "succeeded"; value: T }
  | { reason: string; status: "failed" | "timed-out" };

export async function runInPreparationWorkspace<T>(input: {
  provider: PreparationWorkspaceProvider;
  run: (handle: PreparationWorkspaceHandle) => Promise<T>;
  timeoutMs: number;
}): Promise<PreparationWorkspaceRunResult<T>> {
  const handle = await input.provider.create();

  try {
    const result = await raceWithTimeout(input.run(handle), input.timeoutMs);
    if (result.status === "timed-out") {
      return result;
    }

    return result;
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
  } finally {
    await handle.release();
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<PreparationWorkspaceRunResult<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve({
        reason: `Repo Preparation agent timed out after ${timeoutMs}ms.`,
        status: "timed-out",
      });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ status: "succeeded", value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
