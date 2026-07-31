/**
 * Safe, provider-neutral context for a preparation workspace failure. It must
 * never contain a sandbox identity, provider error, repository content, or
 * credential. Pipeline callers use it to distinguish an inconclusive
 * infrastructure failure from a preparation failure an agent could repair.
 */
export type PreparationWorkspaceInfrastructureDiagnostic = Readonly<{
  phase:
    | "creation-settlement"
    | "exec-transport"
    | "registry-acquisition"
    | "release-settlement"
    | "trusted-provisioning";
  provider: "daytona";
}>;

/** A provider failure that has only safe infrastructure attribution attached. */
interface PreparationWorkspaceInfrastructureFailure {
  readonly preparationWorkspaceInfrastructureDiagnostic: PreparationWorkspaceInfrastructureDiagnostic;
}

/**
 * Provider-owned preparation workspace failure with an intentionally
 * non-sensitive message. Implementations must not attach the underlying cause
 * because terminal Pipeline artifacts are durable and user-visible.
 */
export class PreparationWorkspaceInfrastructureError
  extends Error
  implements PreparationWorkspaceInfrastructureFailure
{
  constructor(
    readonly preparationWorkspaceInfrastructureDiagnostic: PreparationWorkspaceInfrastructureDiagnostic,
  ) {
    super(
      `Preparation Workspace infrastructure failed during ${preparationWorkspaceInfrastructureDiagnostic.phase.replaceAll("-", " ")}.`,
    );
    this.name = "PreparationWorkspaceInfrastructureError";
  }
}

/** Returns only explicitly safe preparation workspace infrastructure context. */
export function readPreparationWorkspaceInfrastructureDiagnostic(
  error: unknown,
): PreparationWorkspaceInfrastructureDiagnostic | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("preparationWorkspaceInfrastructureDiagnostic" in error)
  ) {
    return undefined;
  }
  const diagnostic = (
    error as Partial<PreparationWorkspaceInfrastructureFailure>
  ).preparationWorkspaceInfrastructureDiagnostic;
  if (
    diagnostic?.provider !== "daytona" ||
    ![
      "creation-settlement",
      "exec-transport",
      "registry-acquisition",
      "release-settlement",
      "trusted-provisioning",
    ].includes(diagnostic.phase)
  ) {
    return undefined;
  }
  return diagnostic;
}
