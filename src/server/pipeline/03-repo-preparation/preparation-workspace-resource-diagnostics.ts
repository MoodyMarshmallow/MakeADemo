/**
 * Safe, provider-neutral resource evidence observed around a bounded command.
 * Producers must expose only aggregate cgroup/provider state and deltas.
 */
export type PreparationWorkspaceResourceDiagnostics = Readonly<{
  classification:
    | "cgroup-oom-kill"
    | "pid-limit"
    | "provider-state"
    | "unproven";
  memoryOomKillDelta?: number;
  memoryPeakBytes?: number;
  pidsCurrent?: number;
  pidsLimit?: number;
  pidsMaxEventDelta?: number;
  providerState?: "running" | "stopped" | "unavailable";
}>;

/** Formats bounded SIGKILL evidence without exposing provider diagnostics. */
export function describeDependencyInstallSigkill(
  diagnostics: PreparationWorkspaceResourceDiagnostics | undefined,
  context: "agent" | "preflight",
): string {
  const prefix =
    context === "agent"
      ? "SIGKILL observed"
      : "Dependency installation ended with SIGKILL";
  if (diagnostics?.classification === "cgroup-oom-kill") {
    return `${prefix}; cgroup evidence recorded an OOM kill.`;
  }
  if (diagnostics?.classification === "pid-limit") {
    return `${prefix}; cgroup evidence recorded PID-limit pressure.`;
  }
  if (diagnostics?.classification === "provider-state") {
    return `${prefix} while the provider reported an unavailable runtime.`;
  }
  return context === "agent"
    ? `${prefix}; OOM pressure, provider termination, and external kill remain possible.`
    : `${prefix}; the cause remains unproven.`;
}
