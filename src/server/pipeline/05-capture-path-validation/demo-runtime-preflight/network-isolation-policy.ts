export type NetworkAttempt = {
  direction: "inbound" | "outbound";
  host: string;
  phase: "install" | "runtime";
  /** Redacted attempted URL when the validator can observe more than a host. */
  url?: string;
};

/**
 * Browser/runtime egress contract selected by production composition.
 * `unrestricted-public` permits public destinations but does not change the
 * sandbox provider's private-network isolation or secret-scoping rules.
 */
export type RuntimeNetworkPolicy = "loopback-only" | "unrestricted-public";

export const defaultRuntimeNetworkPolicy: RuntimeNetworkPolicy =
  "loopback-only";

export function findRuntimeBoundaryViolations(
  attempts: readonly NetworkAttempt[],
): NetworkAttempt[] {
  return attempts
    .filter((attempt) => attempt.phase === "runtime")
    .map(sanitizeNetworkAttempt);
}

/**
 * Returns a network attempt safe for diagnostics: implementations must preserve
 * routing fields while removing credential material from any observed URL.
 */
function sanitizeNetworkAttempt(attempt: NetworkAttempt): NetworkAttempt {
  return {
    ...attempt,
    ...(attempt.url === undefined
      ? {}
      : { url: sanitizeNetworkAttemptUrl(attempt.url) }),
  };
}

/** Sanitizes every observed network attempt before it crosses logging seams. */
export function sanitizeNetworkAttempts(
  attempts: readonly NetworkAttempt[] | undefined,
): NetworkAttempt[] | undefined {
  if (attempts === undefined) {
    return undefined;
  }

  return attempts.map(sanitizeNetworkAttempt);
}

/** Redacts URL credentials, fragments, and all query parameter values. */
export function sanitizeNetworkAttemptUrl(requestedUrl: string): string {
  try {
    const url = new URL(requestedUrl);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      url.searchParams.set(key, "[redacted]");
    }

    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}
