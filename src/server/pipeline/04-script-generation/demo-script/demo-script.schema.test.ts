import { describe, expect, it } from "vitest";
import { parseDemoScript } from "./demo-script.schema";

describe("parseDemoScript", () => {
  it("accepts a complete Demo Script artifact", () => {
    expect(parseDemoScript(validDemoScript())).toEqual({
      demoPlaywrightScript: expect.stringContaining("await scene"),
      format: "16:9",
      presentation: {
        music: { enabled: true, trackId: "focus" },
        textOverlays: [expect.objectContaining({ sceneId: "scene_one" })],
        transitions: [],
      },
      scenes: [
        {
          expectedVisibleOutcome: "Main content is visible.",
          humanReadableDescription: "Show main content.",
          id: "scene_one",
        },
      ],
      scriptId: "script_001",
      title: "Demo Script",
      version: 1,
    });
  });

  it("rejects legacy Scene descriptions and unsupported output formats at Script Generation", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        scenes: [
          {
            description: "Show main content.",
            expectedVisibleOutcome: "Main content is visible.",
            id: "scene_one",
          },
        ],
      }),
    ).toThrow("scenes[0].humanReadableDescription must be a non-empty string");

    expect(() =>
      parseDemoScript({ ...validDemoScript(), format: "4:3" }),
    ).toThrow("format must be 16:9");
  });

  it("rejects missing required Demo Script fields", () => {
    const invalidCases: Array<[string, unknown]> = [
      ["demoPlaywrightScript", { demoPlaywrightScript: "" }],
      [
        "expected visible outcome",
        { scenes: [{ expectedVisibleOutcome: "" }] },
      ],
      ["scene description", { scenes: [{ humanReadableDescription: "" }] }],
      ["music", { presentation: { music: null } }],
      ["text overlays", { presentation: { textOverlays: null } }],
      ["transitions", { presentation: { transitions: null } }],
      [
        "transition duration",
        {
          presentation: {
            transitions: [
              {
                durationSeconds: 0,
                fromSceneId: "scene_one",
                style: "fade",
                toSceneId: "scene_one",
              },
            ],
          },
        },
      ],
      [
        "overlay content",
        {
          presentation: {
            textOverlays: [{ content: "", sceneId: "scene_one" }],
          },
        },
      ],
    ];

    for (const [label, patch] of invalidCases) {
      expect(
        () => parseDemoScript(mergeDemoScript(validDemoScript(), patch)),
        label,
      ).toThrow();
    }
  });

  it("rejects unsupported presentation metadata", () => {
    const invalidCases: Array<[string, unknown]> = [
      [
        "font",
        {
          presentation: {
            textOverlays: [{ font: "Comic Sans", sceneId: "scene_one" }],
          },
        },
      ],
      [
        "music track",
        { presentation: { music: { enabled: true, trackId: "unknown" } } },
      ],
      [
        "transition style",
        {
          presentation: {
            transitions: [{ style: "wipe", toSceneId: "scene_one" }],
          },
        },
      ],
      [
        "text overlay scene",
        { presentation: { textOverlays: [{ sceneId: "scene_missing" }] } },
      ],
      [
        "transition scene",
        {
          presentation: {
            transitions: [{ fromSceneId: "scene_missing" }],
          },
        },
      ],
    ];

    for (const [, patch] of invalidCases) {
      expect(() =>
        parseDemoScript(mergeDemoScript(validDemoScript(), patch)),
      ).toThrow();
    }
  });

  it("rejects duplicate Scene IDs and agent-authored recorded Scene durations", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        scenes: [scene("scene_one"), scene("scene_one")],
      }),
    ).toThrow("scenes[1].id must be unique");

    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        scenes: [{ ...scene("scene_one"), durationSeconds: 3 }],
      }),
    ).toThrow("scenes[0].durationSeconds is not allowed");
  });
});

function validDemoScript() {
  return {
    demoPlaywrightScript: [
      "import { setup, scene } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl, expect }) => {",
      "  await page.goto(baseUrl);",
      "  await expect(page.locator('main')).toBeVisible();",
      "});",
      "await scene('scene_one', async ({ page, expect }) => {",
      "  await expect(page.locator('main')).toBeVisible();",
      "});",
    ].join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "focus" },
      textOverlays: [
        {
          content: "Scene one",
          font: "Inter",
          position: "top-left",
          sceneId: "scene_one",
          size: "medium",
        },
      ],
      transitions: [],
    },
    scenes: [scene("scene_one")],
    scriptId: "script_001",
    title: "Demo Script",
    version: 1,
  };
}

function scene(id: string) {
  return {
    expectedVisibleOutcome: "Main content is visible.",
    humanReadableDescription: "Show main content.",
    id,
  };
}

function mergeDemoScript(base: Record<string, unknown>, patch: unknown) {
  return merge(base, patch) as unknown;
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch === undefined ? base : patch;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = merge(merged[key], value);
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
