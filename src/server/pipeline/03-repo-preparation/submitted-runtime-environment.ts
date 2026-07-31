/**
 * Exact environment keys intentionally supplied by MakeADemo Pipeline callers
 * to submitted install, runtime, or capture commands. Provider-owned runtime
 * bindings such as PATH, HOME, browser stores, and credential variables are
 * deliberately absent and must remain non-overridable at provider seams.
 */
const makeADemoSubmittedRuntimeEnvironmentKeys = [
  "CHILD_CONCURRENCY",
  "CI",
  "CMAKE_BUILD_PARALLEL_LEVEL",
  "HUSKY",
  "MAKEFLAGS",
  "NODE_ENV",
  "NO_UPDATE_NOTIFIER",
  "PLAYWRIGHT_CLI_SESSION",
  "PLAYWRIGHT_MCP_ALLOWED_ORIGINS",
  "PLAYWRIGHT_MCP_OUTPUT_DIR",
  "TURBO_CONCURRENCY",
  "YARN_NETWORK_CONCURRENCY",
  "YARN_TASK_POOL_CONCURRENCY",
] as const;

/** A MakeADemo-owned or explicitly public submitted runtime environment key. */
export type MakeADemoSubmittedRuntimeEnvironmentKey =
  | (typeof makeADemoSubmittedRuntimeEnvironmentKeys)[number]
  | `PUBLIC_${string}`
  | `VITE_${string}`
  | `NEXT_PUBLIC_${string}`;

const makeADemoSubmittedRuntimeEnvironmentKeySet = new Set<string>(
  makeADemoSubmittedRuntimeEnvironmentKeys,
);
const submittedPublicEnvironmentKeyPattern =
  /^(?:PUBLIC_|VITE_|NEXT_PUBLIC_)[A-Z0-9_]+$/;

/**
 * Returns whether a caller key belongs to the provider-neutral submitted
 * runtime contract. Public build variables remain supported without allowing
 * arbitrary inherited process state to cross the sandbox boundary.
 */
export function isApprovedSubmittedRuntimeEnvironmentKey(
  key: string,
): key is MakeADemoSubmittedRuntimeEnvironmentKey {
  return (
    makeADemoSubmittedRuntimeEnvironmentKeySet.has(key) ||
    submittedPublicEnvironmentKeyPattern.test(key)
  );
}
