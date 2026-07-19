import type { PreparationWorkspace } from "./preparation-workspace.interface";
import {
  type SubmittedCodeToolchainPlan,
  SubmittedCodeToolchainResolutionError,
  resolveSubmittedCodeToolchain,
} from "./submitted-code-toolchain.schema";

const inspectorCommand = "makeademo-inspect-submitted-code-toolchain";
const inspectorOutputMaxBytes = 1024 * 1024;

export type SubmittedCodeToolchainInspectionResult =
  | { mode: "catalog"; plan: SubmittedCodeToolchainPlan }
  | {
      code: SubmittedCodeToolchainResolutionError["code"];
      /** A bounded, redacted product blocker; never an executable fallback. */
      mode: "unsupported";
      reason: string;
    };

/** Inspects trusted bounded metadata and selects a catalog plan or product blocker. */
export async function inspectSubmittedCodeToolchain(
  workspace: PreparationWorkspace,
): Promise<SubmittedCodeToolchainInspectionResult> {
  const result = await workspace.execute(inspectorCommand, {
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Submitted-project toolchain inspection failed: ${boundedDiagnostic(result.stderr || result.stdout)}`,
    );
  }
  if (Buffer.byteLength(result.stdout) > inspectorOutputMaxBytes) {
    throw new Error(
      `Submitted-project toolchain inspection exceeded ${inspectorOutputMaxBytes} bytes.`,
    );
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "Submitted-project toolchain inspection returned malformed JSON.",
    );
  }

  try {
    return {
      mode: "catalog",
      plan: resolveSubmittedCodeToolchain(
        metadata as Parameters<typeof resolveSubmittedCodeToolchain>[0],
      ),
    };
  } catch (error) {
    if (error instanceof SubmittedCodeToolchainResolutionError) {
      return {
        code: error.code,
        mode: "unsupported",
        reason: unsupportedToolchainReason(error.code),
      };
    }
    throw new Error("Submitted toolchain metadata could not be resolved.");
  }
}

function unsupportedToolchainReason(
  code: SubmittedCodeToolchainResolutionError["code"],
): string {
  switch (code) {
    case "missing_immutable_install":
      return "The selected package manager has no catalog-owned immutable install.";
    case "missing_lockfile":
      return "The selected package manager requires its canonical lockfile.";
    case "unsupported_node_version":
      return "The submitted Node version is not available in the active catalog.";
    case "unsupported_package_manager":
      return "The submitted package manager is not available in the active catalog.";
    case "unsupported_package_manager_version":
      return "The submitted package-manager version is not available in the active catalog.";
  }
}

function boundedDiagnostic(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return "unknown inspector failure";
  return redactAndBound(normalized);
}

function redactAndBound(value: string): string {
  return value
    .replaceAll(
      /(^|[?&;\s])((?:token|api[_-]?key|secret|password)=)[^\s&;]+/gi,
      "$1$2***",
    )
    .slice(0, 1_000);
}
