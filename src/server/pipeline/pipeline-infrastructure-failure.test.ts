import { describe, expect, it } from "vitest";

import {
  type PipelineInfrastructureFailureKind,
  isPipelineInfrastructureFailureKind,
} from "./pipeline-infrastructure-failure";

describe("isPipelineInfrastructureFailureKind", () => {
  it.each([
    "browser-validation-protocol-failed",
    "dependency-install-sigkill",
    "fresh-capture-baseline-failed",
    "invalid-output",
    "preparation-workspace-cleanup-failed",
    "sandbox-infrastructure-failed",
    "sandbox-execution-failed",
    "submitted-code-toolchain-provisioning-failed",
    "submitted-code-workspace-sync-failed",
    "submitted-toolchain-inspection-failed",
    "timeout",
    "unexpected-pipeline-error",
    "unavailable",
    "validator-dependency-failed",
  ] satisfies readonly PipelineInfrastructureFailureKind[])(
    "recognizes %s as infrastructure-owned",
    (failureKind) => {
      expect(isPipelineInfrastructureFailureKind(failureKind)).toBe(true);
    },
  );

  it.each(["browser-not-interactable", "dependency-install-failed", undefined])(
    "keeps repairable or absent kind %s outside infrastructure",
    (failureKind) => {
      expect(isPipelineInfrastructureFailureKind(failureKind)).toBe(false);
    },
  );
});
