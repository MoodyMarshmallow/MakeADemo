import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeGeneratedCaptureSdkHarness } from "./capture-sdk-harness";
import { prepareStylizedPlaywrightScript } from "./stylized-playwright-script";

describe("prepareStylizedPlaywrightScript", () => {
  it("leaves public browser requests available when composition selects unrestricted public networking", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.goto(baseUrl);",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        mode: "validation",
        pauseAfterSceneMs: 0,
        runtimeNetworkPolicy: "unrestricted-public",
      },
    );

    expect(prepared).not.toContain('context.route("**/*"');
    expect(prepared).not.toContain("makeADemoOriginalFetch");
    expect(prepared).not.toContain("[makeademo:network-blocked]");
  });

  it("keeps validation dry runs fast and free of recording-only behavior", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByLabel(/message/i).fill('Show me the launch plan');\nawait page.getByRole('button', { name: /send/i }).click();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        mode: "validation",
        pauseAfterSceneMs: 900,
      },
    );

    expect(prepared).toContain(
      "await page.getByLabel(/message/i).fill('Show me the launch plan');",
    );
    expect(prepared).toContain(
      "await page.getByRole('button', { name: /send/i }).click();",
    );
    expect(prepared).not.toContain("recordVideo");
    expect(prepared).not.toContain("humanType");
    expect(prepared).not.toContain("animatedClick");
    expect(prepared).not.toContain("waitForTimeout(900)");
    expect(prepared).toContain("[makeademo:validation] script started");
    expect(prepared).toContain("[makeademo:validation] script failed");
  });

  it("executes Demo Script setup and scene helpers during validation", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-validation-script-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const scriptPath = join(runDirectory, "demo-script.ts");
    await writeGeneratedCaptureSdkHarness(runDirectory);
    const prepared = prepareStylizedPlaywrightScript(
      [
        "await setup(async ({ page, baseUrl, expect }) => {",
        "  await page.goto(baseUrl);",
        "  await expect(page.locator('body')).toBeVisible();",
        "  console.log('setup callback ran', page.url());",
        "});",
        "await scene('scene_validation', async ({ page, baseUrl, expect }) => {",
        "  await expect(page.locator('main')).toContainText('MakeADemo');",
        "  console.log('scene callback ran', baseUrl);",
        "});",
      ].join("\n"),
      {
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        headed: false,
        mode: "validation",
        pauseAfterSceneMs: 900,
      },
    );

    await writeFile(scriptPath, prepared);

    try {
      const result = await runPreparedScript(scriptPath);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("setup callback ran");
      expect(result.stdout).toContain("scene callback ran");
      expect(readSceneMarkers(result.stdout)).toEqual([
        expect.objectContaining({
          event: "started",
          sceneId: "scene_validation",
        }),
        expect.objectContaining({
          event: "succeeded",
          sceneId: "scene_validation",
        }),
      ]);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("types filled text with human pacing instead of instantly setting the input", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByLabel(/message/i).fill('Show me the launch plan');",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("const humanTypingDelayMs = 100;");
    expect(prepared).toContain(
      "await humanType(page, page.getByLabel(/message/i), 'Show me the launch plan');",
    );
    expect(prepared).not.toContain(".fill('Show me the launch plan')");
  });

  it("defines Demo Script helpers in the recording wrapper", () => {
    const prepared = prepareStylizedPlaywrightScript(
      [
        "await setup(async ({ page, baseUrl, expect }) => {",
        "  await page.goto(baseUrl);",
        "  await expect(page.locator('body')).toBeVisible();",
        "});",
        "await scene('scene_recording', async ({ page }) => {",
        "  await page.getByRole('button', { name: /send/i }).click();",
        "});",
      ].join("\n"),
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain(
      'import { setup, scene } from "./makeademo-capture-sdk.js";',
    );
    expect(prepared).not.toContain("async function setup(callback)");
    expect(prepared).not.toContain("async function scene(id, callback)");
    expect(prepared).toContain(
      "const makeADemoCaptureContext = { page, baseUrl, expect };",
    );
    expect(prepared).toContain("globalThis.__makeademoCaptureSdk");
    expect(prepared).toContain("recordVideo");
    expect(prepared).toContain(
      "await animatedClick(page, page.getByRole('button', { name: /send/i }));",
    );
  });

  it("emits a failed Scene marker before rethrowing scene callback failures", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-validation-script-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const scriptPath = join(runDirectory, "demo-script.ts");
    await writeGeneratedCaptureSdkHarness(runDirectory);
    const prepared = prepareStylizedPlaywrightScript(
      [
        "await scene('scene_failure', async () => {",
        "  throw new Error('scene exploded');",
        "});",
      ].join("\n"),
      {
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        headed: false,
        mode: "validation",
        pauseAfterSceneMs: 0,
      },
    );

    await writeFile(scriptPath, prepared);

    try {
      const result = await runPreparedScript(scriptPath);

      expect(result.exitCode).not.toBe(0);
      expect(readSceneMarkers(result.stdout)).toEqual([
        expect.objectContaining({ event: "started", sceneId: "scene_failure" }),
        expect.objectContaining({
          event: "failed",
          message: "scene exploded",
          sceneId: "scene_failure",
        }),
      ]);
      expect(result.stderr).toContain("scene exploded");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("animates clicks through the visible recording pointer", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByRole('button', { name: /send/i }).click();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedClick(page, locator)");
    expect(prepared).toContain(
      "await animatedClick(page, page.getByRole('button', { name: /send/i }));",
    );
    expect(prepared).not.toContain(
      "await page.getByRole('button', { name: /send/i }).click();",
    );
  });

  it("animates hovers through the visible recording pointer", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByRole('button', { name: /launch plan chat/i }).hover();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedHover(page, locator)");
    expect(prepared).toContain(
      "await animatedHover(page, page.getByRole('button', { name: /launch plan chat/i }));",
    );
    expect(prepared).not.toContain(
      "await page.getByRole('button', { name: /launch plan chat/i }).hover();",
    );

    const hoverHelper = getFunctionSource(prepared, "animatedHover");
    expect(hoverHelper).toContain("await page.mouse.move(");
    expect(hoverHelper).not.toContain("target.click");
    expect(hoverHelper).not.toContain("target.hover");
    expect(hoverHelper).not.toContain("pulseRecordingPointer");
  });

  it("animates scripted transcript scrolls", () => {
    const prepared = prepareStylizedPlaywrightScript(
      `const transcript = page.getByRole('log', { name: /conversation transcript/i });
await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
await transcript.evaluate((element) => { element.scrollTop = 0; });`,
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedScrollTo(page, locator");
    expect(prepared).toContain(
      "async function showScrollCue(page, box, position)",
    );
    expect(prepared).toContain("async function hideScrollCue(page)");
    expect(prepared).toContain("await showScrollCue(page, box, position);");
    expect(prepared).toContain("await hideScrollCue(page);");
    expect(prepared).toContain(
      'await animatedScrollTo(page, transcript, "bottom");',
    );
    expect(prepared).toContain(
      'await animatedScrollTo(page, transcript, "top");',
    );
    expect(prepared).not.toContain("element.scrollTop = element.scrollHeight");
    expect(prepared).not.toContain("element.scrollTop = 0");
  });

  it("does not rewrite the recording helper internals when preparing full Playwright scripts", () => {
    const prepared = prepareStylizedPlaywrightScript(
      `import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const context = await browser.newContext({
  recordVideo: { dir: "artifacts/videos" },
});
const page = await context.newPage();
await page.getByRole("button", { name: /send/i }).click();
await context.close();
await browser.close();`,
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain(
      'await animatedClick(page, page.getByRole("button", { name: /send/i }));',
    );
    expect(prepared).toContain("await target.click();");
  });
});

async function runPreparedScript(scriptPath: string) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn("bun", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

function readSceneMarkers(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("[makeademo:scene] "))
    .map((line) => JSON.parse(line.slice("[makeademo:scene] ".length)));
}

function getFunctionSource(source: string, functionName: string) {
  const start = source.indexOf(`async function ${functionName}`);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextFunction = source.indexOf("\nasync function ", start + 1);
  if (nextFunction === -1) {
    return source.slice(start);
  }

  return source.slice(start, nextFunction);
}
