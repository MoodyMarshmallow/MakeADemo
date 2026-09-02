import { describe, expect, it } from "vitest";

import { buildBenchmarkPipelineArgs } from "./benchmark-suite";
import {
  materializePreparedApplicationIdentityEvaluationCase,
  preparedApplicationIdentityEvaluationCases,
  selectPreparedApplicationIdentityEvaluationCases,
} from "./prepared-application-identity-evaluation-suite";

describe("preparedApplicationIdentityEvaluationCases", () => {
  it("covers pinned REST, tRPC, authentication, and local-database preparations with expected identity outcomes", () => {
    expect(
      preparedApplicationIdentityEvaluationCases.map((evaluation) => ({
        expectedDecision: evaluation.expectedDecision,
        integration: evaluation.fixture.integration,
        playbook: evaluation.fixture.requiredPlaybook,
        preparationShape: evaluation.fixture.preparationShape,
        repoId: evaluation.repo.id,
      })),
    ).toEqual([
      {
        expectedDecision: { verdict: "pass" },
        integration: "rest",
        playbook: "mock-backend-data",
        preparationShape: "native-boundary-mock",
        repoId: "directus",
      },
      {
        expectedDecision: { verdict: "pass" },
        integration: "trpc",
        playbook: "mock-backend-data",
        preparationShape: "native-boundary-mock",
        repoId: "calcom",
      },
      {
        expectedDecision: { verdict: "pass" },
        integration: "authentication",
        playbook: "local-authentication",
        preparationShape: "native-boundary-mock",
        repoId: "mattermost",
      },
      {
        expectedDecision: {
          failureKind: "replacement-detected",
          verdict: "fail",
        },
        integration: "local-database",
        playbook: "seed-local-database",
        preparationShape: "replacement-shell",
        repoId: "midday",
      },
    ]);
    expect(
      preparedApplicationIdentityEvaluationCases.every(
        ({ repo }) =>
          /^[0-9a-f]{40}$/.test(repo.commitSha) &&
          repo.repoUrl.startsWith("https://github.com/"),
      ),
    ).toBe(true);
  });

  it("selects pinned identity cases by benchmark repo id", () => {
    expect(
      selectPreparedApplicationIdentityEvaluationCases({
        cases: preparedApplicationIdentityEvaluationCases,
        repoIds: ["mattermost", "midday"],
      }).map((evaluation) => evaluation.id),
    ).toEqual([
      "mattermost-authentication-native",
      "midday-local-database-replacement",
    ]);
  });

  it("routes a native-boundary case through the full Pipeline", () => {
    const directus = materializePreparedApplicationIdentityEvaluationCase(
      preparedApplicationIdentityEvaluationCases[0],
    );

    expect(directus.execution).toBe("full-pipeline");
    expect(directus.repo.features.slice(0, 2)).toEqual(
      directus.materializedInstructions,
    );
    expect(
      readPipelineFeatures(
        buildBenchmarkPipelineArgs({
          outputRoot: ".benchmark-output",
          repo: directus.repo,
        }),
      ).slice(0, 2),
    ).toEqual(directus.materializedInstructions);
  });

  it.each([1, 2] as const)(
    "puts every remaining native case into real Pipeline features",
    (caseIndex) => {
      const materialized = materializePreparedApplicationIdentityEvaluationCase(
        preparedApplicationIdentityEvaluationCases[caseIndex],
      );

      expect(materialized.execution).toBe("full-pipeline");
      expect(
        readPipelineFeatures(
          buildBenchmarkPipelineArgs({
            outputRoot: ".benchmark-output",
            repo: materialized.repo,
          }),
        ).slice(0, 2),
      ).toEqual(materialized.materializedInstructions);
    },
  );

  it("routes the Midday adversarial case through standalone identity review", () => {
    const midday = materializePreparedApplicationIdentityEvaluationCase(
      preparedApplicationIdentityEvaluationCases[3],
    );

    expect(midday.execution).toBe("standalone-identity-review");
    expect(midday.repo.features).toEqual(
      preparedApplicationIdentityEvaluationCases[3].repo.features,
    );
  });
});

function readPipelineFeatures(args: readonly string[]): string[] {
  return args.flatMap((argument, index) =>
    argument === "--feature" ? [args[index + 1] as string] : [],
  );
}
