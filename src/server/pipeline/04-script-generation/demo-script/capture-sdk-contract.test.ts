import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertDemoScriptCaptureSdkContract } from "./capture-sdk-contract";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "./capture-sdk-harness";
import type { DemoScript } from "./demo-script.schema";

describe("Capture SDK Contract", () => {
  it("preserves Locator identity through action instrumentation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-locator-"));
    await writeGeneratedCaptureSdkHarness(workspace);

    class Locator {}
    const page = {
      locator() {
        return new Locator();
      },
    };
    const strictExpect = (actual: unknown) => {
      if (
        typeof actual !== "object" ||
        actual === null ||
        actual.constructor.name !== "Locator"
      ) {
        throw new Error("toBeVisible can be only used with Locator object");
      }
      return { async toBeVisible() {} };
    };
    Reflect.set(globalThis, "__makeademoCaptureSdk", {
      context: { baseUrl: "http://localhost", expect: strictExpect, page },
      startedAt: performance.now(),
    });

    try {
      const sdk = (await import(
        `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
      )) as {
        setup(
          callback: (context: {
            expect: typeof strictExpect;
            page: typeof page;
          }) => Promise<void>,
        ): Promise<void>;
      };

      await sdk.setup(async ({ expect, page }) => {
        await expect(page.locator()).toBeVisible();
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__makeademoCaptureSdk");
    }
  });

  it("writes generated runtime, declaration, and instruction harness files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));

    await writeGeneratedCaptureSdkHarness(workspace);

    const runtime = await readFile(
      join(workspace, "makeademo-capture-sdk.js"),
      "utf8",
    );
    expect(runtime).toContain("export async function setup");
    expect(runtime).toContain("[makeademo:action]");
    expect(runtime).toContain("timeoutMs");
    await expect(
      readFile(join(workspace, "makeademo-capture-sdk.d.ts"), "utf8"),
    ).resolves.toContain("MakeADemoSceneContext");
    const instructions = await readFile(
      join(workspace, "makeademo-capture-sdk.instructions.md"),
      "utf8",
    );
    expect(instructions).toContain("Do not launch browsers");
    expect(instructions).toContain("Do not use real-time network access");
    expect(instructions).toContain("fetch");
    expect(instructions).toContain("page.evaluate");
  });

  it("requires Demo Scripts to import both setup and scene from the SDK", () => {
    expect(() =>
      assertDemoScriptCaptureSdkContract(
        demoScript("import { scene } from './makeademo-capture-sdk';"),
      ),
    ).toThrow("must import { setup, scene }");
    expect(() =>
      assertDemoScriptCaptureSdkContract(
        demoScript("import { setup } from './makeademo-capture-sdk';"),
      ),
    ).toThrow("must import { setup, scene }");
  });

  it("requires each Scene to include a visible Playwright assertion", () => {
    expect(() =>
      assertDemoScriptCaptureSdkContract(
        demoScript(
          [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await scene('scene_one', async ({ page, expect }) => {",
            "  await expect(page.locator('main')).toBeVisible();",
            "});",
          ].join("\n"),
        ),
      ),
    ).not.toThrow();

    for (const script of [
      [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await scene('scene_one', async () => {",
        "  // await expect(page.locator('main')).toBeVisible();",
        "});",
      ].join("\n"),
      [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await scene('scene_one', async () => {",
        "  const fake = \"await expect(page.locator('main')).toBeVisible();\";",
        "  void fake;",
        "});",
      ].join("\n"),
      [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await scene('scene_one', async ({ expect }) => {",
        "  await expect(1).toBe(1);",
        "});",
      ].join("\n"),
    ]) {
      expect(() =>
        assertDemoScriptCaptureSdkContract(demoScript(script)),
      ).toThrow("visible Playwright assertion");
    }
  });

  it("rejects generated Demo Scripts that use runtime network APIs", () => {
    for (const [script, expectedReason] of [
      [
        [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await fetch('https://analytics.example.com/pixel');",
          "  await expect(page.locator('body')).toBeVisible();",
          "});",
        ].join("\n"),
        "Generated Demo Scripts must not call fetch",
      ],
      [
        [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "import http from 'node:http';",
          "void http;",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await expect(page.locator('body')).toBeVisible();",
          "});",
        ].join("\n"),
        "Generated Demo Scripts must not import Node network modules",
      ],
      [
        [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await page.waitForResponse('https://api.example.com/data');",
          "  await expect(page.locator('body')).toBeVisible();",
          "});",
        ].join("\n"),
        "Generated Demo Scripts must not wait on network requests",
      ],
    ] as const) {
      expect(() =>
        assertDemoScriptCaptureSdkContract(demoScript(script)),
      ).toThrow(expectedReason);
    }
  });

  it("rejects generated Demo Scripts that mutate or inspect app internals", () => {
    for (const [script, expectedReason] of [
      [
        [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await page.evaluate(() => localStorage.setItem('demo', 'ready'));",
          "  await expect(page.locator('body')).toBeVisible();",
          "});",
        ].join("\n"),
        "Generated Demo Scripts must not execute arbitrary page JavaScript",
      ],
      [
        [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await page.addScriptTag({ content: 'window.demo = true' });",
          "  await expect(page.locator('body')).toBeVisible();",
          "});",
        ].join("\n"),
        "Generated Demo Scripts must not inject scripts into the prepared app",
      ],
    ] as const) {
      expect(() =>
        assertDemoScriptCaptureSdkContract(demoScript(script)),
      ).toThrow(expectedReason);
    }
  });

  it("validates Demo Script code against the generated SDK declarations", async () => {
    const workspace = await sdkWorkspace();

    await expect(
      validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: validTypedScript(),
        directory: workspace,
      }),
    ).resolves.toBeUndefined();
  }, 20_000);

  it("rejects Demo Script code that misuses the SDK context types", async () => {
    const workspace = await sdkWorkspace();

    await expect(
      validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await setup(async ({ missingThing }) => {",
          "  await missingThing();",
          "});",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await expect(page.locator('body')).toBeVisible();",
          "});",
        ].join("\n"),
        directory: workspace,
      }),
    ).rejects.toThrow("failed Capture SDK TypeScript validation");
  }, 20_000);
});

async function sdkWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
  await symlink(
    join(process.cwd(), "node_modules"),
    join(workspace, "node_modules"),
  );
  await writeGeneratedCaptureSdkHarness(workspace);
  return workspace;
}

function validTypedScript() {
  return [
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async ({ page, baseUrl, expect }) => {",
    "  await page.goto(baseUrl);",
    "  await expect(page.locator('body')).toBeVisible();",
    "});",
    "await scene('scene_one', async ({ page, expect }) => {",
    "  await expect(page.locator('body')).toBeVisible();",
    "});",
  ].join("\n");
}

function demoScript(demoPlaywrightScript: string): DemoScript {
  return {
    demoPlaywrightScript,
    format: "16:9",
    presentation: {
      music: { enabled: false },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Body is visible.",
        humanReadableDescription: "Show body.",
        id: "scene_one",
      },
    ],
    scriptId: "script-001",
    title: "Demo Script",
    version: 1,
  };
}
