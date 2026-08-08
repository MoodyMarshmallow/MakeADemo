import type {
  PreparationMockingPlan,
  RepoPreparationPlaybookId,
} from "../../preparation-mocking-plan.schema";
import { repoPreparationPlaybookIds } from "../../preparation-mocking-plan.schema";

const repoPreparationPlaybookDescriptions = {
  "local-authentication":
    "Preserve native sign-in and authenticated UI while replacing hosted identity behind the existing auth boundary.",
  "mock-backend-data":
    "Preserve native UI and client data shapes while replacing hosted API or RPC calls with deterministic local state.",
  "seed-local-database":
    "Preserve the existing data model and native UI while initializing a deterministic local database.",
} as const satisfies Record<RepoPreparationPlaybookId, string>;

const repoPreparationPlaybooks = {
  "local-authentication": [
    "# Local Authentication",
    repoPreparationPlaybookDescriptions["local-authentication"],
    "Replace OAuth or hosted identity calls behind the existing auth boundary with deterministic local demo credentials and session state.",
    "Keep sign-in, sign-out, authorization checks, and a fresh-start reset working without secrets or redirects to an external provider.",
  ].join("\n"),
  "mock-backend-data": [
    "# Mock Backend Data",
    repoPreparationPlaybookDescriptions["mock-backend-data"],
    "Replace hosted backend calls at that boundary with deterministic local fixtures and state, including mutations needed by the intended demo flow.",
    "Keep the replacement narrow and make fresh startup restore the same useful demo state.",
  ].join("\n"),
  "seed-local-database": [
    "# Seed a Local Database",
    repoPreparationPlaybookDescriptions["seed-local-database"],
    "Use a local database or repository-supported embedded mode with deterministic, idempotent seed data and no hosted credentials.",
    "Ensure the demo command initializes the required schema and restores a known fresh state without manual setup.",
  ].join("\n"),
} as const satisfies Record<RepoPreparationPlaybookId, string>;

/** Lists the trusted catalog without eagerly loading any playbook body. */
export function describeRepoPreparationPlaybookCatalog(): string[] {
  return repoPreparationPlaybookIds.map(
    (id) => `- \`${id}\`: ${repoPreparationPlaybookDescriptions[id]}`,
  );
}

/** Returns backend-bundled Repo Preparation guidance for one trusted ID. */
export function readRepoPreparationPlaybook(
  id: RepoPreparationPlaybookId,
): string {
  return repoPreparationPlaybooks[id];
}

const requiredPlaybookByBoundary = {
  authentication: "local-authentication",
  backend: "mock-backend-data",
  database: "seed-local-database",
} as const satisfies Record<
  PreparationMockingPlan["boundaries"][number]["kind"],
  RepoPreparationPlaybookId
>;

/**
 * Verifies that durable playbook claims match backend-recorded tool use and
 * cover every mocked runtime boundary.
 */
export function validatePreparationMockingPlanPlaybooks(
  plan: PreparationMockingPlan,
  loadedPlaybooks: readonly RepoPreparationPlaybookId[],
): void {
  const actual = new Set(loadedPlaybooks);
  const declared = new Set(plan.loadedPlaybooks);

  for (const playbook of declared) {
    if (!actual.has(playbook)) {
      throw new Error(
        `mockingPlan.loadedPlaybooks claims ${playbook}, but makeademo_load_playbook did not load it`,
      );
    }
  }
  for (const playbook of actual) {
    if (!declared.has(playbook)) {
      throw new Error(
        `mockingPlan.loadedPlaybooks must record the loaded ${playbook} playbook`,
      );
    }
  }
  for (const boundary of plan.boundaries) {
    const requiredPlaybook = requiredPlaybookByBoundary[boundary.kind];
    if (!actual.has(requiredPlaybook)) {
      throw new Error(
        `Mocking the ${boundary.kind} boundary requires loading ${requiredPlaybook} with makeademo_load_playbook`,
      );
    }
  }
}
