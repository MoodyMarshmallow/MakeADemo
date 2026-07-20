import { describe, expect, it } from "vitest";

import { assertCaptureReadyScriptQuality } from "./demo-script-quality";
import type { DemoScript } from "./demo-script/demo-script.schema";

describe("assertCaptureReadyScriptQuality", () => {
  it("accepts a setup body smoke check when Scenes use finite product interactions", () => {
    expect(() =>
      assertCaptureReadyScriptQuality(
        demoScript({
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async ({ page, baseUrl, expect }) => {",
            "  await page.goto(baseUrl);",
            "  await expect(page.locator('body')).toBeVisible();",
            "});",
            "await scene('scene_time', async ({ page, expect }) => {",
            "  await page.getByRole('button', { name: 'Log 30m' }).click();",
            "  await expect(page.locator('#billableHours')).toContainText('0.5');",
            "});",
          ].join("\n"),
        }),
      ),
    ).not.toThrow();
  });

  it("rejects Demo Scripts that only smoke-check the page body", () => {
    expect(() =>
      assertCaptureReadyScriptQuality(
        demoScript({
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async ({ page, baseUrl, expect }) => {",
            "  await page.goto(baseUrl);",
            "  await expect(page.locator('body')).toBeVisible();",
            "});",
            "await scene('scene_placeholder', async ({ page, expect }) => {",
            "  await expect(page.locator('body')).toBeVisible();",
            "});",
          ].join("\n"),
        }),
      ),
    ).toThrow("demoPlaywrightScript contains placeholder actions");
  });

  it("rejects Demo Scripts that leave any declared Scene as a body-only placeholder", () => {
    expect(() =>
      assertCaptureReadyScriptQuality(
        demoScript({
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl); });",
            "await scene('scene_time', async ({ page, expect }) => {",
            "  await page.getByRole('button', { name: 'Log 30m' }).click();",
            "  await expect(page.locator('#billableHours')).toContainText('0.5');",
            "});",
            "await scene('scene_placeholder', async ({ page, expect }) => {",
            "  await expect(page.locator('body')).toBeVisible();",
            "});",
          ].join("\n"),
          scenes: [
            {
              expectedVisibleOutcome: "Billable time is visible.",
              humanReadableDescription: "Log billable time.",
              id: "scene_time",
            },
            {
              expectedVisibleOutcome: "Placeholder is visible.",
              humanReadableDescription: "Show placeholder.",
              id: "scene_placeholder",
            },
          ],
        }),
      ),
    ).toThrow("Scene scene_placeholder contains placeholder actions");
  });
});

function demoScript(
  overrides: Pick<DemoScript, "demoPlaywrightScript"> & Partial<DemoScript>,
): DemoScript {
  return {
    format: "16:9",
    presentation: {
      music: { enabled: false },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Billable time is visible.",
        humanReadableDescription: "Log billable time.",
        id: "scene_time",
      },
    ],
    scriptId: "script_time_tracking",
    title: "Time tracking demo",
    version: 1,
    ...overrides,
  };
}
