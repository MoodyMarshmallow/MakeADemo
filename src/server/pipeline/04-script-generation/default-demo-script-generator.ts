import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type {
  DemoScript,
  SceneDescription,
} from "./demo-script/demo-script.schema";

export type DefaultDemoScriptGeneratorInput = {
  demoBrief: DemoBrief;
};

/**
 * Builds MakeADemo's deterministic fallback Demo Script. The generated flow
 * preserves the requested feature order and uses one continuous Capture SDK
 * script with event-marked Scenes.
 */
export function generateDefaultDemoScript(
  input: DefaultDemoScriptGeneratorInput,
): DemoScript {
  const sceneIds = createSceneIds(input.demoBrief.keyProductFeatures);
  const scenes: SceneDescription[] = input.demoBrief.keyProductFeatures.map(
    (feature, index) => ({
      expectedVisibleOutcome: `The ${feature} result is visible.`,
      humanReadableDescription: `Demonstrate ${feature}.`,
      id: sceneIds[index] ?? "scene-feature",
    }),
  );

  return {
    demoPlaywrightScript: createPlaywrightScript(
      input.demoBrief.keyProductFeatures,
      sceneIds,
    ),
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "clean" },
      textOverlays: scenes.map((scene) => ({
        content: scene.humanReadableDescription,
        font: "Inter",
        position: "bottom-left",
        sceneId: scene.id,
        size: "medium",
      })),
      transitions: scenes.slice(0, -1).map((scene, sceneIndex) => ({
        durationSeconds: 0.25,
        fromSceneId: scene.id,
        style: "fade",
        toSceneId: scenes[sceneIndex + 1]?.id ?? scene.id,
      })),
    },
    scenes,
    scriptId: "generated-makeademo-script",
    title: "Generated MakeADemo Script",
    version: 1,
  };
}

function createPlaywrightScript(
  features: string[],
  sceneIds: string[],
): string {
  const lines = [
    "import { scene, setup } from './makeademo-capture-sdk';",
    "",
    "await setup(async ({ page, baseUrl, expect }) => {",
    "  await page.goto(baseUrl);",
    "  await expect(page.locator('html')).toBeVisible();",
    "});",
  ];

  for (const [index, feature] of features.entries()) {
    const sceneId = sceneIds[index] ?? "scene-feature";
    lines.push(
      `await scene(${JSON.stringify(sceneId)}, async ({ page, expect }) => {`,
      `  await expect(page.getByText(${JSON.stringify(feature)}, { exact: false }).first()).toBeVisible();`,
      "});",
    );
  }

  return lines.join("\n");
}

function createSceneIds(features: string[]): string[] {
  const seenSceneIds = new Map<string, number>();
  return features.map((feature) => {
    const baseSceneId = `scene-${slug(feature) || "feature"}`;
    const occurrence = (seenSceneIds.get(baseSceneId) ?? 0) + 1;
    seenSceneIds.set(baseSceneId, occurrence);
    return occurrence === 1 ? baseSceneId : `${baseSceneId}-${occurrence}`;
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
