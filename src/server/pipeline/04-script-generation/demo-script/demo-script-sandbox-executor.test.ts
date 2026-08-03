import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";
import {
  DemoScriptTypeValidationError,
  executeDemoScriptInSandbox,
} from "./demo-script-sandbox-executor";

describe("Demo Script sandbox execution", () => {
  it("stages and executes a typed Demo Script in submitted code", async () => {
    const executedCommands: Array<{
      command: string;
      timeoutMs: number | undefined;
    }> = [];
    const captureRequests: unknown[] = [];
    const uploadedFiles = new Map<string, string>();
    const workspace = sandboxWorkspace({
      async executeSubmittedCode(command, options) {
        executedCommands.push({ command, timeoutMs: options?.timeoutMs });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeMakeADemoCapture(request) {
        captureRequests.push(request);
        return {
          exitCode: 0,
          stderr:
            '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime","resourceType":"fetch","url":"https://analytics.example.com/event"}',
          stdout:
            '[makeademo:scene] {"elapsedMs":25,"event":"succeeded","sceneId":"scene_one"}',
        };
      },
      async uploadSubmittedCodeFiles(files) {
        await Promise.all(
          files.map(async (file) => {
            uploadedFiles.set(
              file.destinationPath,
              await readFile(file.sourcePath, "utf8"),
            );
          }),
        );
      },
    });

    const result = await executeDemoScriptInSandbox({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: validTypedScript(),
      mode: "validation",
      remoteRunDirectory: "/workspace/.makeademo/demo-script-runs/run_one",
      scriptFilename: "demo-script.ts",
      timeoutMs: 16_500,
      workspace,
    });

    expect(uploadedFiles.size).toBe(5);
    expect(
      uploadedFiles.get(
        "/workspace/.makeademo/demo-script-runs/run_one/makeademo-capture-sdk.mjs",
      ),
    ).toContain("export async function setup");
    expect(
      uploadedFiles.has(
        "/workspace/.makeademo/demo-script-runs/run_one/makeademo-capture-sdk.js",
      ),
    ).toBe(false);
    expect(
      uploadedFiles.get(
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.mjs",
      ),
    ).toContain("https://preview.example.test/");
    expect(
      uploadedFiles.get(
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.mjs",
      ),
    ).not.toContain(": string");
    expect(
      uploadedFiles.get(
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.mjs",
      ),
    ).toContain('from "/opt/makeademo/capture-runtime/playwright.mjs"');
    expect(
      uploadedFiles.get(
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.mjs",
      ),
    ).not.toContain('from "@playwright/test"');
    expect(
      uploadedFiles.get(
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.mjs",
      ),
    ).toContain('from "./makeademo-capture-sdk.mjs"');
    expect(executedCommands[0]?.command).toBe(
      "mkdir -p '/workspace/.makeademo/demo-script-runs/run_one'",
    );
    expect(executedCommands).toHaveLength(1);
    expect(captureRequests).toEqual([
      {
        runDirectory: "/workspace/.makeademo/demo-script-runs/run_one",
        scriptPath:
          "/workspace/.makeademo/demo-script-runs/run_one/demo-script.mjs",
        stderrPath:
          "/workspace/.makeademo/demo-script-runs/run_one/demo-script.stderr.log",
        stdoutPath:
          "/workspace/.makeademo/demo-script-runs/run_one/demo-script.stdout.log",
        timeoutMs: 16_500,
      },
    ]);
    expect(result).toEqual({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "analytics.example.com",
          phase: "runtime",
          url: "https://analytics.example.com/event",
        },
      ],
      exitCode: 0,
      runDirectory: "/workspace/.makeademo/demo-script-runs/run_one",
      scriptPath:
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.mjs",
      stderr:
        '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime","resourceType":"fetch","url":"https://analytics.example.com/event"}',
      stderrPath:
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.stderr.log",
      stdout:
        '[makeademo:scene] {"elapsedMs":25,"event":"succeeded","sceneId":"scene_one"}',
      stdoutPath:
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.stdout.log",
      timedOut: false,
    });
  }, 20_000);

  it("rejects Capture SDK type errors before sandbox work begins", async () => {
    const sandboxCalls: string[] = [];
    const workspace = sandboxWorkspace({
      async executeSubmittedCode(command) {
        sandboxCalls.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadSubmittedCodeFiles() {
        sandboxCalls.push("upload");
      },
    });

    const execution = executeDemoScriptInSandbox({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "import { setup } from './makeademo-capture-sdk';",
        "await setup(async ({ missingThing }) => {",
        "  await missingThing();",
        "});",
      ].join("\n"),
      mode: "validation",
      remoteRunDirectory: "/workspace/.makeademo/demo-script-runs/type_error",
      scriptFilename: "demo-script.ts",
      timeoutMs: 16_500,
      workspace,
    });

    await expect(execution).rejects.toBeInstanceOf(
      DemoScriptTypeValidationError,
    );
    await expect(execution).rejects.toThrow("missingThing");
    expect(sandboxCalls).toEqual([]);
  }, 20_000);

  it("rejects self-launching Playwright scripts before sandbox work begins", async () => {
    const sandboxCalls: string[] = [];
    const workspace = sandboxWorkspace({
      async executeMakeADemoCapture() {
        sandboxCalls.push("capture");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode(command) {
        sandboxCalls.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadSubmittedCodeFiles() {
        sandboxCalls.push("upload");
      },
    });

    const execution = executeDemoScriptInSandbox({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "export {};",
        "declare const chromium: { launch(): Promise<any> };",
        "const browser = await chromium.launch();",
        'const context = await browser.newContext({ recordVideo: { dir: "artifacts/videos" } });',
        "const page = await context.newPage();",
        "await page.goto('http://localhost:3000');",
        "await context.close();",
        "await browser.close();",
      ].join("\n"),
      mode: "validation",
      remoteRunDirectory:
        "/workspace/.makeademo/demo-script-runs/self_launching",
      scriptFilename: "demo-script.ts",
      timeoutMs: 16_500,
      workspace,
    });

    await expect(execution).rejects.toBeInstanceOf(
      DemoScriptTypeValidationError,
    );
    await expect(execution).rejects.toThrow(
      "Demo Scripts must not launch their own Playwright browser",
    );
    expect(sandboxCalls).toEqual([]);
  }, 20_000);
});

function sandboxWorkspace(
  overrides: Pick<
    PreparationWorkspace,
    "executeSubmittedCode" | "uploadSubmittedCodeFiles"
  > &
    Partial<Pick<PreparationWorkspace, "executeMakeADemoCapture">>,
): PreparationWorkspace {
  return {
    async execute() {
      throw new Error("parent workspace execution must not run Demo Scripts");
    },
    ...overrides,
    async getPreviewUrl() {
      return "https://preview.example.test/";
    },
    async uploadFiles() {
      throw new Error("parent upload must not stage Demo Scripts");
    },
  };
}

function validTypedScript() {
  return [
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async ({ page, baseUrl, expect }) => {",
    "  await page.goto(baseUrl);",
    "  await expect(page.locator('body')).toBeVisible();",
    "});",
    "await scene('scene_one', async ({ page, expect }) => {",
    "  const label: string = 'body';",
    "  await expect(page.locator(label)).toBeVisible();",
    "});",
  ].join("\n");
}
