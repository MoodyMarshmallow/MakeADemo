import { createPreparedApplicationIdentityEvidenceLedger } from "../../pipeline/03-prepared-application-identity-review/prepared-application-identity-evidence";
import type { PreparedApplicationIdentityReviewInput } from "../../pipeline/03-prepared-application-identity-review/prepared-application-identity-reviewer.interface";
import {
  createApplicationIdentityBaseline,
  createPreparedWorkspaceDiff,
} from "../../pipeline/03-repo-preparation/application-identity-evidence";
import type { PreparationManifest } from "../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { MaterializedPreparedApplicationIdentityEvaluationCase } from "./prepared-application-identity-evaluation-suite";

const replacementRoute = "apps/dashboard/src/app/[locale]/demo/page.tsx";
const nativeCashFlowChart =
  "apps/dashboard/src/components/charts/cash-flow-chart.tsx";
const nativeOverviewRoute =
  "apps/dashboard/src/app/[locale]/(app)/(sidebar)/page.tsx";
const sourceTreeObjectId = "1111111111111111111111111111111111111111";

const replacementPatch = `diff --git a/${replacementRoute} b/${replacementRoute}
new file mode 100644
--- /dev/null
+++ b/${replacementRoute}
@@ -0,0 +1,18 @@
+import { CashFlowChart } from "../../../components/charts/cash-flow-chart";
+
+const seededRecords = [{ label: "Revenue", value: 24000 }, { label: "Expenses", value: 9000 }];
+
+export default function DemoPage() {
+  return (
+    <main data-makeademo-replacement-shell>
+      <nav>Standalone Finance Dashboard</nav>
+      <h1>Financial Overview</h1>
+      <CashFlowChart data={seededRecords} />
+    </main>
+  );
+}
`;

const pinnedSources: Readonly<Record<string, string>> = {
  [nativeCashFlowChart]: `export function CashFlowChart(props: { data: unknown[] }) {
  return <section aria-label="Cash flow chart">{props.data.length} periods</section>;
}
`,
  [nativeOverviewRoute]: `import { OverviewHeader } from "@/components/overview-header";
import { TransactionsList } from "@/components/transactions-list";

export default function OverviewPage() {
  return <><OverviewHeader /><TransactionsList /></>;
}
`,
};

/**
 * Materializes the known replacement-shell mutation as backend-owned evidence
 * for the real independent reviewer, without weakening Repo Preparation.
 */
export function createAdversarialPreparedApplicationIdentityReviewInput(
  materialized: MaterializedPreparedApplicationIdentityEvaluationCase,
): PreparedApplicationIdentityReviewInput {
  if (materialized.execution !== "standalone-identity-review") {
    throw new Error(
      "Standalone review requires a replacement-shell identity evaluation case.",
    );
  }
  const evaluation = materialized.evaluation;

  const applicationIdentityBaseline = createApplicationIdentityBaseline({
    pinnedRevision: evaluation.repo.commitSha,
    repoUrl: evaluation.repo.repoUrl,
    sourceControlledPaths: Object.keys(pinnedSources),
    sourceTreeObjectId,
  });
  const preparedWorkspaceDiff = createPreparedWorkspaceDiff({
    createdPaths: [replacementRoute],
    deletedPaths: [],
    modifiedPaths: [],
    patch: replacementPatch,
  });
  const preparationManifest: PreparationManifest = {
    assumptions: [
      "This adversarial benchmark intentionally replaces the native shell.",
    ],
    createdFiles: [replacementRoute],
    demoCommand: "bun run dev:dashboard",
    diffArtifactId: preparedWorkspaceDiff.artifactId,
    existingDemoEvidence: [],
    mockingPlan: {
      boundaries: [
        {
          kind: "database",
          localReplacement: "Deterministic seeded finance records",
          source: "database",
        },
      ],
      fixturePaths: [replacementRoute],
      loadedPlaybooks: [evaluation.fixture.requiredPlaybook],
      nativeUiRoots: [nativeCashFlowChart],
      plannedPresentationChanges: [
        "Create a standalone finance dashboard on a new demo route.",
      ],
    },
    mockedServices: ["database"],
    modifiedFiles: [],
    nativeVisibleInterface: {
      nativeStartupAttempts: ["bun run dev:dashboard"],
      sourceControlledUiPaths: [nativeCashFlowChart],
    },
    repoUrl: evaluation.repo.repoUrl,
    risks: ["Known replacement-shell identity violation."],
    scriptGenerationContext: materialized.materializedInstructions,
    setupSummary:
      "Created a standalone replacement shell that reuses only the native cash-flow chart leaf.",
    status: "created-new-demo",
    url: "http://127.0.0.1:3001/demo",
    workspaceId: "identity-evaluation-midday-replacement",
  };

  return {
    evidenceLedger: createPreparedApplicationIdentityEvidenceLedger({
      applicationIdentityBaseline,
      evidence: [
        {
          content:
            "Standalone Finance Dashboard. Financial Overview. Revenue 24000. Expenses 9000. Cash flow chart.",
          id: "accessibility-snapshot:benchmark-midday-replacement",
          kind: "accessibility-snapshot",
        },
      ],
      mockedBoundaries: ["database"],
      preparedWorkspaceDiff,
    }),
    preparationManifest,
    preparationWorkspace: createBenchmarkWorkspaceHandle(),
  };
}

function createBenchmarkWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    id: "identity-evaluation-midday-replacement",
    async release() {},
    workspace: {
      async execute() {
        throw new Error("Adversarial identity review is read-only.");
      },
      async executeReadOnlyCommand(request) {
        const objectPath = request.argv.at(-1) ?? "";
        const separatorIndex = objectPath.indexOf(":");
        const path = objectPath.slice(separatorIndex + 1);
        const source = pinnedSources[path];
        return source === undefined
          ? { exitCode: 1, stderr: "Pinned source not found.", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: source };
      },
      async uploadFiles() {
        throw new Error("Adversarial identity review is read-only.");
      },
    },
  };
}
