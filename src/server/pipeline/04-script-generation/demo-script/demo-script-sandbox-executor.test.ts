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
    const uploadedFiles = new Map<string, string>();
    const workspace = sandboxWorkspace({
      async executeSubmittedCode(command, options) {
        executedCommands.push({ command, timeoutMs: options?.timeoutMs });
        if (command.includes(" bun ")) {
          return {
            exitCode: 0,
            stderr:
              '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime","resourceType":"fetch","url":"https://analytics.example.com/event"}',
            stdout:
              '[makeademo:scene] {"elapsedMs":25,"event":"succeeded","sceneId":"scene_one"}',
          };
        }

        return { exitCode: 0, stderr: "", stdout: "" };
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
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.ts",
      ),
    ).toContain("https://preview.example.test/");
    expect(executedCommands[0]?.command).toBe(
      "mkdir -p '/workspace/.makeademo/demo-script-runs/run_one'",
    );
    expect(executedCommands[1]).toMatchObject({ timeoutMs: 21_500 });
    expect(executedCommands[1]?.command).toContain(
      "MAKEADEMO_PLAYWRIGHT_MODULE_ROOT",
    );
    expect(executedCommands[1]?.command).toContain(
      "/opt/makeademo/playwright-runtime/node_modules",
    );
    expect(executedCommands[1]?.command).not.toContain("npm root -g");
    expect(executedCommands[1]?.command).toContain(
      "rm -rf node_modules/@playwright node_modules/playwright node_modules/playwright-core",
    );
    expect(executedCommands[1]?.command).toContain("|| exit $?");
    expect(executedCommands[1]?.command).toContain("timeout -s TERM 17 bun");
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
        "/workspace/.makeademo/demo-script-runs/run_one/demo-script.ts",
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
});

function sandboxWorkspace(
  overrides: Pick<
    PreparationWorkspace,
    "executeSubmittedCode" | "uploadSubmittedCodeFiles"
  >,
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
    "  await expect(page.locator('body')).toBeVisible();",
    "});",
  ].join("\n");
}
