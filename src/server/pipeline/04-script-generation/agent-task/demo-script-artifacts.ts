import type { AgenticScriptGenerationInput } from "../script-generation-agent.interface";

const makeADemoArtifactDirectory = "/workspace/.makeademo";
export const demoScriptPath = `${makeADemoArtifactDirectory}/demo-script.json`;

export function boundedArtifactTimeout(
  timeoutMs: number,
  hardDeadlineAt: number,
): number {
  return Math.max(1, Math.min(timeoutMs, hardDeadlineAt - Date.now()));
}

export async function readDemoScriptArtifact(
  input: Pick<AgenticScriptGenerationInput, "preparationWorkspace">,
  options: { timeoutMs?: number } = {},
): Promise<
  { status: "succeeded"; value: unknown } | { reason: string; status: "failed" }
> {
  const result = await input.preparationWorkspace.workspace.execute(
    `if test -f ${shellQuote(demoScriptPath)}; then cat ${shellQuote(demoScriptPath)}; else exit 1; fi`,
    options,
  );
  if (result.exitCode !== 0) {
    return {
      reason: `Agent task did not write ${demoScriptPath}.`,
      status: "failed",
    };
  }

  try {
    return { status: "succeeded", value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      reason: `Demo Script artifact is not valid JSON: ${readErrorMessage(error)}`,
      status: "failed",
    };
  }
}

export function createDemoScriptSchemaPrompt(): string {
  return [
    "## Required Demo Script Shape",
    "The artifact must be one JSON object with every required top-level field present.",
    "Use this exact shape, replacing example strings and scripts with repo-specific content:",
    "```json",
    JSON.stringify(
      {
        demoPlaywrightScript:
          "import { setup, scene } from './makeademo-capture-sdk';\n\nawait setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });\nawait scene('scene_requested_feature', async ({ page, expect }) => {\n  await page.getByRole('button', { name: /example/i }).click();\n  await expect(page.getByText(/result/i)).toBeVisible();\n});",
        format: "16:9",
        presentation: {
          music: { enabled: true, trackId: "clean" },
          textOverlays: [
            {
              content: "Show the requested feature",
              font: "Inter",
              position: "bottom-left",
              sceneId: "scene_requested_feature",
              size: "medium",
            },
          ],
          transitions: [],
        },
        scenes: [
          {
            humanReadableDescription:
              "Show the requested feature with real UI interactions.",
            expectedVisibleOutcome: "The feature result is visible.",
            id: "scene_requested_feature",
          },
        ],
        scriptId: "script_unique_demo_id",
        title: "Concise demo title",
        version: 1,
      },
      null,
      2,
    ),
    "```",
    "Top-level `scriptId`, `title`, `format`, `version`, `demoPlaywrightScript`, non-empty `scenes`, and `presentation` are mandatory on every attempt.",
    "Each Scene must include `id`, `humanReadableDescription`, and `expectedVisibleOutcome`. Do not include `durationSeconds` on recorded Scenes.",
  ].join("\n");
}

export function createDemoScriptCaptureContractPrompt(): string[] {
  return [
    "- Only use the MakeADemo Capture SDK: import `{ setup, scene }` from `./makeademo-capture-sdk` and write interactions inside those callbacks.",
    "- Do not use real-time network access in the Demo Script. Do not call `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `page.request`, `page.waitForRequest`, `page.waitForResponse`, `page.route`, `page.unroute`, or Node network modules such as `http`, `https`, `net`, or `dns`.",
    "- Use the prepared app through the provided `baseUrl`, deterministic user-visible interactions, and Playwright locator assertions. Do not inspect app internals, mutate app state with injected JavaScript, or depend on network request timing.",
    "- Every Scene step must be executable against the prepared app and must finish with a visible locator assertion proving the expected outcome.",
  ];
}

export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncateForPrompt(value: string, maxLength = 20_000): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
