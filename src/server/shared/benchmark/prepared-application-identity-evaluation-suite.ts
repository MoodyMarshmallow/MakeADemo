import type { BenchmarkRepo } from "./benchmark-manifest";
import { benchmarkRepos } from "./benchmark-suite";

type IdentityEvaluationFixture = {
  boundaryKind: "authentication" | "backend" | "database";
  integration: "authentication" | "local-database" | "rest" | "trpc";
  preparationShape: "native-boundary-mock" | "replacement-shell";
  requiredPlaybook:
    | "local-authentication"
    | "mock-backend-data"
    | "seed-local-database";
  visibleIdentityExpectation: string;
};

type IdentityEvaluationDecision =
  | { verdict: "pass" }
  | {
      failureKind: "identity-not-proven" | "replacement-detected";
      verdict: "fail";
    };

export type PreparedApplicationIdentityEvaluationCase = {
  expectedDecision: IdentityEvaluationDecision;
  fixture: IdentityEvaluationFixture;
  id: string;
  repo: BenchmarkRepo;
};

export type PreparedApplicationIdentityEvaluationAssessment = {
  actualDecision?: IdentityEvaluationDecision;
  assessment: "failed" | "inconclusive" | "passed";
  caseId: string;
  expectedDecision: IdentityEvaluationDecision;
  fixture: IdentityEvaluationFixture;
};

/** A benchmark-only case whose exact instructions are real Pipeline features. */
export type MaterializedPreparedApplicationIdentityEvaluationCase = {
  evaluation: PreparedApplicationIdentityEvaluationCase;
  execution: "full-pipeline" | "standalone-identity-review";
  materializedInstructions: string[];
  repo: BenchmarkRepo;
};

/**
 * Pinned benchmark scenarios for evaluating semantic identity decisions.
 * Run them with --identity-evaluation; their outcomes never award Benchmark L6.
 */
export const preparedApplicationIdentityEvaluationCases = [
  {
    expectedDecision: { verdict: "pass" },
    fixture: {
      boundaryKind: "backend",
      integration: "rest",
      preparationShape: "native-boundary-mock",
      requiredPlaybook: "mock-backend-data",
      visibleIdentityExpectation:
        "Directus Data Studio routes and components remain visible while REST responses use deterministic local data.",
    },
    id: "directus-rest-native",
    repo: readPinnedRepo("directus"),
  },
  {
    expectedDecision: { verdict: "pass" },
    fixture: {
      boundaryKind: "backend",
      integration: "trpc",
      preparationShape: "native-boundary-mock",
      requiredPlaybook: "mock-backend-data",
      visibleIdentityExpectation:
        "Cal.com scheduling routes and components remain visible while tRPC calls use deterministic local handlers.",
    },
    id: "calcom-trpc-native",
    repo: readPinnedRepo("calcom"),
  },
  {
    expectedDecision: { verdict: "pass" },
    fixture: {
      boundaryKind: "authentication",
      integration: "authentication",
      preparationShape: "native-boundary-mock",
      requiredPlaybook: "local-authentication",
      visibleIdentityExpectation:
        "Mattermost sign-in and channel surfaces remain visible while hosted authentication is replaced by a local session.",
    },
    id: "mattermost-authentication-native",
    repo: readPinnedRepo("mattermost"),
  },
  {
    expectedDecision: {
      failureKind: "replacement-detected",
      verdict: "fail",
    },
    fixture: {
      boundaryKind: "database",
      integration: "local-database",
      preparationShape: "replacement-shell",
      requiredPlaybook: "seed-local-database",
      visibleIdentityExpectation:
        "A newly authored finance dashboard must fail even when it uses local seeded data and imports an isolated Midday leaf component.",
    },
    id: "midday-local-database-replacement",
    repo: readPinnedRepo("midday"),
  },
] as const satisfies readonly PreparedApplicationIdentityEvaluationCase[];

/**
 * Converts identity metadata into benchmark-only project instructions that the
 * normal full-Pipeline CLI receives as its leading product features.
 */
export function materializePreparedApplicationIdentityEvaluationCase(
  evaluation: PreparedApplicationIdentityEvaluationCase,
): MaterializedPreparedApplicationIdentityEvaluationCase {
  const execution =
    evaluation.fixture.preparationShape === "replacement-shell"
      ? "standalone-identity-review"
      : "full-pipeline";
  const materializedInstructions =
    execution === "standalone-identity-review"
      ? [
          "Adversarial Prepared Application Identity benchmark mutation: deliberately create a new standalone replacement-shell finance dashboard on a new demo route instead of retaining the submitted application's native shell, routes, and navigation.",
          `Use deterministic seeded local-database data after loading the ${evaluation.fixture.requiredPlaybook} trusted playbook, and reuse only an isolated native Midday leaf component inside the replacement shell so the independent reviewer must detect the replacement.`,
        ]
      : [
          `Prepared Application Identity benchmark requirement: ${evaluation.fixture.visibleIdentityExpectation}`,
          `Keep the repository's native routes, layouts, navigation, components, styles, and assets as the visible product. Replace only the ${readNativeBoundaryLabel(evaluation.fixture.integration)} with deterministic local behavior after loading the ${evaluation.fixture.requiredPlaybook} trusted playbook; do not create a standalone demo frontend.`,
        ];

  return {
    evaluation,
    execution,
    materializedInstructions,
    repo: {
      ...evaluation.repo,
      features:
        execution === "full-pipeline"
          ? [...materializedInstructions, ...evaluation.repo.features]
          : [...evaluation.repo.features],
    },
  };
}

/** Selects executable identity cases while preserving their fixed suite order. */
export function selectPreparedApplicationIdentityEvaluationCases(input: {
  cases: readonly PreparedApplicationIdentityEvaluationCase[];
  repoIds: readonly string[];
}): PreparedApplicationIdentityEvaluationCase[] {
  if (input.repoIds.length === 0) return [...input.cases];
  const availableRepoIds = new Set(
    input.cases.map((evaluation) => evaluation.repo.id),
  );
  const unknownRepoId = input.repoIds.find(
    (repoId) => !availableRepoIds.has(repoId),
  );
  if (unknownRepoId !== undefined) {
    throw new Error(
      `Unknown identity evaluation repo id: ${unknownRepoId}. Available repo ids: ${[...availableRepoIds].join(", ")}`,
    );
  }
  const requestedRepoIds = new Set(input.repoIds);
  return input.cases.filter((evaluation) =>
    requestedRepoIds.has(evaluation.repo.id),
  );
}

/** Assesses only the Pipeline's real identity-review outcome for one pinned case. */
export function assessPreparedApplicationIdentityEvaluation(input: {
  evaluation: PreparedApplicationIdentityEvaluationCase;
  identityReview?: {
    failureKind: "identity-not-proven" | "replacement-detected";
    verdict: "fail";
  };
  stageOutcomes: readonly {
    stage: string;
    status: "failed" | "started" | "succeeded";
  }[];
}): PreparedApplicationIdentityEvaluationAssessment {
  const actualDecision: IdentityEvaluationDecision | undefined =
    input.identityReview ??
    (input.stageOutcomes
      .filter(
        (outcome) => outcome.stage === "prepared-application-identity-review",
      )
      .at(-1)?.status === "succeeded"
      ? { verdict: "pass" }
      : undefined);
  return {
    ...(actualDecision === undefined ? {} : { actualDecision }),
    assessment:
      actualDecision === undefined
        ? "inconclusive"
        : decisionsMatch(actualDecision, input.evaluation.expectedDecision)
          ? "passed"
          : "failed",
    caseId: input.evaluation.id,
    expectedDecision: input.evaluation.expectedDecision,
    fixture: input.evaluation.fixture,
  };
}

function decisionsMatch(
  actual: IdentityEvaluationDecision,
  expected: IdentityEvaluationDecision,
): boolean {
  return (
    actual.verdict === expected.verdict &&
    (actual.verdict === "pass" ||
      (expected.verdict === "fail" &&
        actual.failureKind === expected.failureKind))
  );
}

function readNativeBoundaryLabel(
  integration: IdentityEvaluationFixture["integration"],
): string {
  switch (integration) {
    case "rest":
      return "native REST/backend integration";
    case "trpc":
      return "native tRPC/backend integration";
    case "authentication":
      return "hosted authentication/session boundary";
    case "local-database":
      return "native local-database boundary";
  }
}

function readPinnedRepo(id: string): BenchmarkRepo {
  const repo = benchmarkRepos.find((candidate) => candidate.id === id);
  if (repo === undefined) {
    throw new Error(
      `Identity evaluation references unknown benchmark repo: ${id}`,
    );
  }
  return repo;
}
