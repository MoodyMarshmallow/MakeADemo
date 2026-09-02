import { describe, expect, it } from "vitest";

import { createAdversarialPreparedApplicationIdentityReviewInput } from "./prepared-application-identity-evaluation-harness";
import {
  materializePreparedApplicationIdentityEvaluationCase,
  preparedApplicationIdentityEvaluationCases,
} from "./prepared-application-identity-evaluation-suite";

describe("createAdversarialPreparedApplicationIdentityReviewInput", () => {
  it("materializes the Midday replacement shell as real reviewer evidence", async () => {
    const materialized = materializePreparedApplicationIdentityEvaluationCase(
      preparedApplicationIdentityEvaluationCases[3],
    );
    const input =
      createAdversarialPreparedApplicationIdentityReviewInput(materialized);

    expect(input.evidenceLedger.preparedWorkspaceDiff).toMatchObject({
      createdPaths: ["apps/dashboard/src/app/[locale]/demo/page.tsx"],
      deletedPaths: [],
      modifiedPaths: [],
    });
    expect(input.evidenceLedger.preparedWorkspaceDiff.patch).toContain(
      "data-makeademo-replacement-shell",
    );
    expect(input.preparationManifest).toMatchObject({
      createdFiles: ["apps/dashboard/src/app/[locale]/demo/page.tsx"],
      mockingPlan: {
        loadedPlaybooks: ["seed-local-database"],
        nativeUiRoots: [
          "apps/dashboard/src/components/charts/cash-flow-chart.tsx",
        ],
      },
      scriptGenerationContext: materialized.materializedInstructions,
      status: "created-new-demo",
    });
    expect(
      input.evidenceLedger.evidence.some(
        ({ content, kind }) =>
          kind === "accessibility-snapshot" &&
          content.includes("Standalone Finance Dashboard"),
      ),
    ).toBe(true);

    await expect(
      input.preparationWorkspace.workspace.executeReadOnlyCommand?.(
        {
          argv: [
            "git",
            "show",
            `${input.evidenceLedger.applicationIdentityBaseline.sourceTreeObjectId}:apps/dashboard/src/components/charts/cash-flow-chart.tsx`,
          ],
        },
        { timeoutMs: 10_000 },
      ),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("CashFlowChart"),
    });
  });

  it("rejects native-boundary cases because they must run through the full Pipeline", () => {
    expect(() =>
      createAdversarialPreparedApplicationIdentityReviewInput(
        materializePreparedApplicationIdentityEvaluationCase(
          preparedApplicationIdentityEvaluationCases[0],
        ),
      ),
    ).toThrow("replacement-shell identity evaluation case");
  });
});
