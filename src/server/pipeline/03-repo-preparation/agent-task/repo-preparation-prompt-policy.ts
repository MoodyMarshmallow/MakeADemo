import type { readPreparationManifest } from "../preparation-manifest";
import type { PreparationWorkspaceCommandResult } from "../preparation-workspace.interface";
import type { RepoPreparationInput } from "../repo-preparation-agent.interface";
import type { RepoPreparationPreflightResult } from "../repo-preparation-preflight.interface";
import {
  preparationManifestDirectory,
  preparationManifestPath,
} from "./repo-preparation-artifact-handoff";
import {
  boundRepoPreparationEvidence,
  redactRepoPreparationEvidence,
  repoPreparationEvidenceCaps,
} from "./repo-preparation-evidence";

const dependencyInstallOutputTailMaxLength = 1_500;
export function createDaytonaRepoPreparationPrompt(
  input: RepoPreparationInput,
  options: {
    toolchainAdvisory?: { code: string; reason: string };
  } = {},
): string {
  return [
    "# MakeADemo Repo Preparation",
    "",
    "## Goal",
    "Prepare the submitted repo inside `/workspace` so MakeADemo preparation preflight can start a deterministic, browser-accessible demo without secrets, hosted services, OAuth, or external APIs after setup.",
    "",
    "- Leave prepared files in `/workspace` on success.",
    "",
    "## Dependency Installation",
    "- Do not run dependency install commands yourself; submitted dependency execution is backend-controlled in the submitted-code sandbox.",
    "- If dependencies must be installed, call `makeademo_dependency_request_install` without arguments, then stop; the backend selects the exact immutable command.",
    '- Set the Preparation Manifest `dependencyInstall` field to `"not-required"` only when no further install is needed, such as a standard-library-only server or dependencies already installed through the backend tool; otherwise omit it or use `"inferred"`.',
    "- Do not infer `not-required` from command shape alone.",
    "",
    "## Preparation Strategy",
    "- Prefer the smallest safe change that creates or exposes a deterministic demo path.",
    "- The visible interface must remain the submitted repository's native source-controlled UI. Do not create a replacement frontend, standalone simulation, walkthrough, or HTML entrypoint.",
    "- You may add fixtures, mock adapters, configuration, and small glue/demo routes only when the rendered screens import native source-controlled UI components, styles, or assets.",
    "- If the native visible interface cannot be prepared, submit status failed with a clear blocker instead of substituting a new UI.",
    "- Prefer local mock data, fixture data, or frontend-only demo modes over hosted services.",
    "- Keep existing project conventions where practical.",
    "- If the repo already has a suitable demo command, use it rather than creating a new one.",
    ...(options.toolchainAdvisory === undefined
      ? []
      : [
          "",
          "## Toolchain Repair Context",
          `The initial advisory scan found repairable repository metadata (${options.toolchainAdvisory.code}): ${options.toolchainAdvisory.reason}`,
          "Repair the repository metadata before requesting dependency installation or preparation validation.",
        ]),
    `- Write the draft Preparation Manifest JSON to ${preparationManifestPath}, then call makeademo_validate_preparation with that manifest path and stop for preparation preflight feedback.`,
    "- If preparation preflight fails, repair the repo using the feedback and call `makeademo_validate_preparation` again.",
    "- Call `makeademo_submit_preparation_result` only after the latest preparation preflight passes.",
    "",
    "## Few-Shot Examples",
    "### Example: dependencies missing",
    "Observation: `node_modules` is absent and `package-lock.json` exists.",
    "Action: call `makeademo_dependency_request_install` without arguments, then stop; the backend selects the exact immutable command.",
    "",
    "### Example: frontend needs mock API",
    "Observation: the app calls a hosted API at runtime.",
    `Action: add a local mock-data/demo mode, configure the demo command to use it, write ${preparationManifestPath}, then call makeademo_validate_preparation with the manifest path.`,
    "",
    "## Final Response Contract",
    "When preparation preflight has passed, call `makeademo_submit_preparation_result` exactly once. Do not print final JSON in plain text.",
    "",
    ...createPreparationManifestGuidance(input),
    "",
    "```json",
    '{"status":"failed","blockers":[],"assumptions":[],"suggestedChanges":[]}',
    "```",
    "",
    "## Submission Context",
    "```json",
    JSON.stringify(
      {
        normalizedSupportingDocuments: input.normalizedSupportingDocuments,
        repoUrl: input.repoUrl,
        structuredDemoIntent: input.structuredDemoIntent,
        workspaceId: input.workspaceId,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function createContinueRepoPreparationPrompt(
  input: RepoPreparationInput,
): string {
  return [
    "# Continue MakeADemo Repo Preparation",
    "",
    "## Current State",
    "Dependency install ran in the submitted-code sandbox and completed successfully.",
    "The parent agent workspace `/workspace` may not contain `node_modules`; do not fail solely because parent `/workspace/node_modules` is absent.",
    "Validate readiness by writing the Preparation Manifest and calling MakeADemo preparation preflight.",
    "",
    "## Goal",
    "Finish preparing `/workspace` for MakeADemo preparation preflight with a deterministic browser-accessible demo that does not require secrets.",
    "",
    "## Dependency Installation",
    "- Do not request another dependency install unless it is strictly required.",
    "- If another install is required, call `makeademo_dependency_request_install` without arguments, then stop; the backend selects the exact immutable command.",
    '- Use `dependencyInstall: "not-required"` only when no further install is needed (for example, a standard-library-only server or dependencies already installed through the backend tool).',
    "",
    "## Few-Shot Examples",
    "### Example: install succeeded",
    "Observation: dependencies are installed and the app can run with a local demo flag.",
    "Action: add any required mock/demo config, verify the command shape, then return a success manifest.",
    "",
    "## Final Response Contract",
    "When preparation preflight has passed, call `makeademo_submit_preparation_result` exactly once. Do not print final JSON in plain text.",
    `If validation has not passed yet, write ${preparationManifestPath}, call makeademo_validate_preparation with that path, and stop for feedback.`,
    'For success, pass only `status: "succeeded"`. The backend will submit the latest validated manifest file. For failure, pass `status: "failed"`, `blockers`, `assumptions`, and `suggestedChanges`.',
    "",
    ...createPreparationManifestGuidance(input),
    "",
    "## Submission Context",
    "```json",
    JSON.stringify(
      {
        repoUrl: input.repoUrl,
        workspaceId: input.workspaceId,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function createToolchainRepairPrompt(
  input: RepoPreparationInput,
  issue: { code: string; reason: string },
): string {
  return [
    "# Continue MakeADemo Repo Preparation",
    "",
    "## Repair Required",
    `The authoritative dependency scan found repairable repository metadata (${issue.code}): ${issue.reason}`,
    "Repair the submitted package-manager, Node-version, or canonical lockfile metadata in `/workspace`, then request dependency installation again.",
    "Do not run a dependency install command directly.",
    "",
    "## Submission Context",
    "```json",
    JSON.stringify(
      { repoUrl: input.repoUrl, workspaceId: input.workspaceId },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function createDependencyInstallFailurePrompt(
  input: RepoPreparationInput,
  result: PreparationWorkspaceCommandResult,
): string {
  return [
    "# Continue MakeADemo Repo Preparation",
    "",
    "## Current State",
    `Dependency installation failed in the submitted-code sandbox with exit code ${result.exitCode}.`,
    "Use the bounded stdout/stderr tails below to decide whether to request the backend-selected install again or submit a clear preparation blocker.",
    "",
    "## Dependency Install stdout Tail",
    "```text",
    limitTextTail(result.stdout, dependencyInstallOutputTailMaxLength),
    "```",
    "",
    "## Dependency Install stderr Tail",
    "```text",
    limitTextTail(result.stderr, dependencyInstallOutputTailMaxLength),
    "```",
    "",
    "## Dependency Installation",
    "- Do not request another dependency install unless it is strictly required.",
    "- If another install is required, call `makeademo_dependency_request_install` without arguments, then stop; the backend selects the exact immutable command.",
    '- Use `dependencyInstall: "not-required"` only when no further install is needed (for example, a standard-library-only server or dependencies already installed through the backend tool).',
    "",
    "## Final Response Contract",
    "When preparation preflight has passed, call `makeademo_submit_preparation_result` exactly once. Do not print final JSON in plain text.",
    `If validation has not passed yet, write ${preparationManifestPath}, call makeademo_validate_preparation with that path, and stop for feedback.`,
    'For failure, pass `status: "failed"`, `blockers`, `assumptions`, and `suggestedChanges`.',
    "",
    ...createPreparationManifestGuidance(input),
    "",
    "## Submission Context",
    "```json",
    JSON.stringify(
      {
        repoUrl: input.repoUrl,
        workspaceId: input.workspaceId,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function createPreparationManifestGuidance(
  input: Pick<RepoPreparationInput, "repoUrl" | "workspaceId">,
): string[] {
  return [
    "## Preparation Manifest File",
    `Write the successful manifest to ${preparationManifestPath} before calling validation.`,
    "Each field must be present unless described as an array that may be empty.",
    "",
    "### Field Guide",
    `- repoUrl: submitted repository URL. Example: ${input.repoUrl}`,
    `- workspaceId: MakeADemo workspace/request ID from the submission context. Example: ${input.workspaceId}`,
    '- status: preparation strategy, one of "created-new-demo", "adapted-existing-demo", or "reused-existing-demo". Example: "created-new-demo".',
    '- setupSummary: one short paragraph explaining what changed and how the demo runs. Example: "Prepared a frontend-only demo that uses local mock RealWorld API data."',
    '- createdFiles: files newly created for MakeADemo. Example: ["frontend/src/demoApi.js"]. Use [] if none.',
    '- modifiedFiles: existing files changed for MakeADemo. Example: ["package.json", "frontend/src/main.jsx"]. Use [] if none.',
    "- nativeVisibleInterface: required provenance for the rendered native UI. sourceControlledUiPaths must list submitted-repository UI components, routes, styles, or assets rendered by the demo; nativeStartupAttempts must list the native startup commands or strategies attempted. The backend rejects paths created during preparation.",
    '- demoCommand: command MakeADemo preparation preflight and Capture Path Validation should run from /workspace to start a long-running local server. Example: "npm run demo".',
    '- dependencyInstall: optional install strategy. Use "not-required" only when no further install is needed (for example, a standard-library-only server or dependencies already installed through the backend tool); otherwise use "inferred".',
    '- url: local HTTP URL served by demoCommand. Example: "http://localhost:4173/".',
    '- mockedServices: external services replaced with local mocks or fixtures. Example: ["RealWorld API", "avatar image service"]. Use [] if none.',
    '- assumptions: assumptions made while preparing the demo. Example: ["Demo data can be in-memory and reset on reload"]. Use [] if none.',
    '- risks: remaining concerns that could affect later capture. Example: ["Repository tests require undeclared jsdom but the browser demo path does not"]. Use [] if none.',
    '- existingDemoEvidence: evidence that an existing demo was reused or adapted. Example: ["frontend/package.json already had a preview script"]. Use [] if none.',
    '- scriptGenerationContext: concrete product flows, routes, demo credentials, visual beats, and mock behavior for the next pipeline stage. Example: ["Home feed shows seeded articles and tags", "Login accepts demo@example.com with any password", "Editor stores articles in local mock state"].',
    '- diffArtifactId: stable identifier for the workspace diff artifact if available. Example: "workspace-diff".',
    "",
    "### File-Writing Example",
    "```bash",
    `mkdir -p ${preparationManifestDirectory}`,
    `cat > ${preparationManifestPath} <<'JSON'`,
    JSON.stringify(
      {
        assumptions: ["Demo data can be in-memory and reset on reload"],
        createdFiles: ["frontend/src/demoApi.js"],
        demoCommand: "npm run demo",
        dependencyInstall: "inferred",
        diffArtifactId: "workspace-diff",
        existingDemoEvidence: [
          "frontend/package.json already had build and preview scripts",
        ],
        mockedServices: ["RealWorld API", "avatar image service"],
        modifiedFiles: ["package.json", "frontend/src/main.jsx"],
        nativeVisibleInterface: {
          nativeStartupAttempts: ["npm run demo"],
          sourceControlledUiPaths: [
            "frontend/src/main.jsx",
            "frontend/src/App.jsx",
            "frontend/src/index.css",
          ],
        },
        repoUrl: input.repoUrl,
        risks: [
          "Repository tests require undeclared jsdom but the browser demo path does not",
        ],
        scriptGenerationContext: [
          "Home feed shows seeded articles and tags",
          "Login accepts demo@example.com with any password",
          "Editor stores articles in local mock state",
        ],
        setupSummary:
          "Prepared a frontend-only demo that uses local mock RealWorld API data.",
        status: "created-new-demo",
        url: "http://localhost:4173/",
        workspaceId: input.workspaceId,
      },
      null,
      2,
    ),
    "JSON",
    "```",
    "",
    `Then call makeademo_validate_preparation with manifestPath set to ${preparationManifestPath} and stop for feedback.`,
  ];
}

export function createValidationFeedbackPrompt(input: {
  manifest: ReturnType<typeof readPreparationManifest> | undefined;
  manifestPath: string;
  remainingBudgetMs: number;
  runtimePreflight: RepoPreparationPreflightResult;
}): string {
  const prompt = [
    "# MakeADemo Validation Feedback",
    "",
    "Backend-owned preparation preflight ran against your prepared workspace.",
    "Use this deterministic feedback to repair the repo, then call `makeademo_validate_preparation` again.",
    "Call `makeademo_submit_preparation_result` only after validation passes.",
    "",
    "## Preparation Preflight Result",
    "```json",
    JSON.stringify(
      createRuntimePreflightRepairProjection(input.runtimePreflight),
      null,
      2,
    ),
    "```",
    "",
    ...(input.manifest === undefined
      ? [
          "## Manifest Handoff",
          `The agent wrote or referenced ${input.manifestPath}, but MakeADemo could not parse it as a valid Preparation Manifest. Fix that file and call makeademo_validate_preparation again with the same manifest path.`,
        ]
      : [
          "## Validated Manifest Draft",
          "```json",
          JSON.stringify(
            createBoundedManifestProjection(input.manifest),
            null,
            2,
          ),
          "```",
        ]),
    "",
    "## Debugging Guidance",
    "- If `blockedNetworkAttempts` is non-empty, remove or replace every listed external runtime request with local mocks, bundled assets, or system defaults.",
    ...(input.runtimePreflight.blockedNetworkAttempts.length === 0
      ? []
      : [
          `- Remaining Repo Preparation budget: about ${formatDuration(input.remainingBudgetMs)}. Patch those listed runtime requests first, then rerun preflight before spending time on broader investigation.`,
          "- Network feedback is scoped: repair only the observed runtime network requests listed in `blockedNetworkAttempts`.",
          "- Ignore package metadata URLs, lockfile URLs, and ordinary external anchor links unless the demo actually clicks or navigates to those links.",
          "- After removing or replacing the listed runtime requests, rerun `makeademo_validate_preparation` promptly; do not broad-search unrelated URLs first.",
        ]),
    "- If the page is not interactable, inspect the validation logs and demo server logs, then fix the route, demo command, or browser runtime error.",
    "- If the demo URL did not become ready, make the submitted `demoCommand` start a long-running local server on the manifest `url` port.",
    "- Do not request dependency installation unless a new backend-selected immutable install is strictly required.",
  ].join("\n");

  return prompt;
}

function createRuntimePreflightRepairProjection(
  runtimePreflight: RepoPreparationPreflightResult,
) {
  return {
    blockedNetworkAttempts: runtimePreflight.blockedNetworkAttempts
      .map((attempt) => ({
        ...attempt,
        ...(attempt.url === undefined
          ? {}
          : { url: redactRepoPreparationEvidence(attempt.url) }),
      }))
      .filter(
        (attempt, index, attempts) =>
          attempts.findIndex(
            (candidate) =>
              `${candidate.direction}:${candidate.host}:${candidate.phase}:${candidate.url ?? ""}` ===
              `${attempt.direction}:${attempt.host}:${attempt.phase}:${attempt.url ?? ""}`,
          ) === index,
      )
      .slice(0, 8),
    browserUrl: runtimePreflight.browserUrl,
    evidence:
      runtimePreflight.evidence === undefined
        ? undefined
        : {
            ...(runtimePreflight.evidence.serverLog === undefined
              ? {}
              : {
                  serverLog: boundRepoPreparationEvidence(
                    runtimePreflight.evidence.serverLog.text,
                    2 * 1024,
                  ),
                }),
            ...(runtimePreflight.evidence.browser === undefined
              ? {}
              : {
                  browser: boundRepoPreparationEvidence(
                    runtimePreflight.evidence.browser.text,
                    2 * 1024,
                  ),
                }),
          },
    failureKind: runtimePreflight.failureKind,
    failureReason:
      runtimePreflight.failureReason === undefined
        ? undefined
        : boundRepoPreparationEvidence(
            runtimePreflight.failureReason,
            repoPreparationEvidenceCaps.failureReason,
          ).text,
    localUrl: runtimePreflight.localUrl,
    logs: createRepairLogs(runtimePreflight.logs),
    previewUrl: runtimePreflight.previewUrl,
    screenshot: runtimePreflight.screenshot,
    warnings: [
      ...new Set(
        runtimePreflight.warnings.map(
          (warning) => boundRepoPreparationEvidence(warning, 512).text,
        ),
      ),
    ].slice(0, 8),
  };
}

function createRepairLogs(logs: string[]) {
  const maxLogCount = 4;
  const maxLogBytes = 6 * 1024;
  let used = 0;
  const included: string[] = [];

  for (const log of logs) {
    if (isInlineBinaryLog(log)) {
      continue;
    }
    const remaining = maxLogBytes - used;
    if (remaining <= 0 || included.length >= maxLogCount) {
      break;
    }
    const excerpt = boundRepoPreparationEvidence(
      log,
      Math.min(2 * 1024, remaining),
    );
    included.push(excerpt.text);
    used += excerpt.text.length;
  }

  return included;
}

function createBoundedManifestProjection(
  manifest: NonNullable<ReturnType<typeof readPreparationManifest>>,
) {
  return {
    excerpt: boundRepoPreparationEvidence(
      JSON.stringify(manifest, null, 2),
      4 * 1024,
    ).text,
  };
}

function isInlineBinaryLog(value: string) {
  return (
    /^\s*(?:screenshot:|data:)/i.test(value) ||
    /^[A-Za-z0-9+/]{512,}={0,2}$/.test(value.trim())
  );
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0
    ? `${minutes}m`
    : `${minutes}m ${remainingSeconds}s`;
}

function limitTextTail(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `[truncated ${value.length - maxLength} chars]\n${value.slice(-maxLength)}`;
}
