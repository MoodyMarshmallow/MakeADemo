export const submittedRuntimeIdentityMarker =
  "__MAKEADEMO_SUBMITTED_RUNTIME_IDENTITY__";

/**
 * Identifies the exact provider-launched session leader that owns a submitted
 * runtime. Callers must revalidate every field against `/proc` before signaling.
 */
export type SubmittedRuntimeLaunchIdentity = {
  processGroupId: number;
  processStartTimeTicks: number;
  processId: number;
  sessionId: number;
};

export function parseSubmittedRuntimeLaunchIdentity(
  output: string,
  expectedToken: string,
): SubmittedRuntimeLaunchIdentity | undefined {
  const expression = new RegExp(
    `^${submittedRuntimeIdentityMarker}:${escapeRegExp(expectedToken)}:(\\d+):(\\d+):(\\d+):(\\d+)$`,
    "m",
  );
  const match = expression.exec(output);
  if (match === null) return undefined;
  const processId = Number(match[1]);
  const processGroupId = Number(match[2]);
  const sessionId = Number(match[3]);
  const processStartTimeTicks = Number(match[4]);
  if (
    ![processId, processGroupId, sessionId, processStartTimeTicks].every(
      Number.isSafeInteger,
    ) ||
    processId <= 0 ||
    processId !== processGroupId ||
    processId !== sessionId ||
    processStartTimeTicks <= 0
  ) {
    return undefined;
  }
  return {
    processGroupId,
    processId,
    processStartTimeTicks,
    sessionId,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
