import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import { DefaultCapturePathSceneValidator } from "./playwright-capture-path-scene-validator";

describe("DefaultCapturePathSceneValidator", () => {
  it("persists stdout and stderr when a dry-run scene fails", async () => {
    const validator = new DefaultCapturePathSceneValidator();

    const result = await validator.validateScene({
      baseUrl: "https://example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async () => {});",
        "await scene('scene_failure_evidence', async ({ page, expect }) => {",
        "  await expect(page.locator('body')).toBeVisible();",
        "  throw new Error('selector exploded');",
        "});",
      ].join("\n"),
      scene: {
        expectedVisibleOutcome: "The failure is visible.",
        humanReadableDescription: "Fail deterministically.",
        id: "scene_failure_evidence",
      },
      sectionId: "section_failure",
    });

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      errorMessage: "selector exploded",
    });
    expect(result.stdoutPath).toContain("scene_failure_evidence.stdout.log");
    expect(result.stderrPath).toContain("scene_failure_evidence.stderr.log");
    expect(await readFile(result.stdoutPath as string, "utf8")).toContain(
      "[makeademo:validation] script started",
    );
    expect(await readFile(result.stderrPath as string, "utf8")).toContain(
      "selector exploded",
    );
    expect(result.logs.join("\n")).toContain("selector exploded");
  }, 20_000);

  it("blocks process-level runtime network requests from generated Demo Scripts", async () => {
    const validator = new DefaultCapturePathSceneValidator();

    const result = await validator.validateScene({
      baseUrl: "https://example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async () => {});",
        "await scene('scene_external_request', async ({ page, expect }) => {",
        "  await expect(page.locator('body')).toBeVisible();",
        "  await fetch('https://analytics.example.com/pixel');",
        "});",
      ].join("\n"),
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Try an external request.",
        id: "scene_external_request",
      },
      sectionId: "section_external_request",
    });

    expect(result).toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "analytics.example.com",
          phase: "runtime",
        },
      ],
      failureReason:
        "Capture Path Validation blocked runtime network access from the generated Demo Script.",
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("[makeademo:network-blocked]");
  }, 20_000);

  it("rejects SDK type errors before running the dry-run browser script", async () => {
    const validator = new DefaultCapturePathSceneValidator();

    const result = await validator.validateScene({
      baseUrl: "https://example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async ({ missingThing }) => {",
        "  await missingThing();",
        "});",
        "await scene('scene_type_error', async ({ page, expect }) => {",
        "  await expect(page.locator('body')).toBeVisible();",
        "});",
      ].join("\n"),
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Show the page.",
        id: "scene_type_error",
      },
      sectionId: "section_type_error",
    });

    expect(result).toMatchObject({
      failureReason: "Demo Script failed Capture SDK TypeScript validation.",
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("missingThing");
    expect(result.stdoutPath).toBeUndefined();
    expect(result.stderrPath).toBeUndefined();
  }, 20_000);

  it("runs the generated dry-run script inside the prepared workspace when available", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const executedCommands: string[] = [];
    const uploadedDestinations: string[] = [];
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "workspace_123",
      workspace: {
        async execute() {
          throw new Error("outer workspace execution must not validate scenes");
        },
        async executeSubmittedCode(command) {
          executedCommands.push(command);
          if (command.includes("bun '/workspace/.makeademo/")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_workspace"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_workspace"}',
              ].join("\n"),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async setOutboundNetworkAccess() {},
        async uploadFiles() {
          throw new Error("parent upload must not be used for scene files");
        },
        async uploadSubmittedCodeFiles(files) {
          uploadedDestinations.push(
            ...files.map((file) => file.destinationPath),
          );
        },
      },
    };

    const result = await validator.validateScene({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async ({ page, baseUrl, expect }) => {",
        "  await page.goto(baseUrl);",
        "  await expect(page.locator('body')).toBeVisible();",
        "});",
        "await scene('scene_workspace', async ({ page, expect }) => {",
        "  await expect(page.locator('body')).toBeVisible();",
        "});",
      ].join("\n"),
      preparationWorkspace,
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Show the page.",
        id: "scene_workspace",
      },
      sectionId: "section_workspace",
    });

    expect(result).toMatchObject({
      runDirectory: expect.stringContaining(
        "/workspace/.makeademo/capture-path-validation-runs/",
      ),
      scriptPath: expect.stringContaining("/workspace/.makeademo/"),
      status: "succeeded",
    });
    expect(uploadedDestinations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("makeademo-capture-sdk.js"),
        expect.stringContaining("makeademo-capture-sdk.d.ts"),
        expect.stringContaining("scene_workspace.ts"),
      ]),
    );
    expect(executedCommands.join("\n")).toContain(
      "/workspace/.makeademo/capture-path-validation-runs/",
    );
  }, 20_000);

  it("makes validator-owned Playwright available to prepared-workspace dry-run scripts", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "workspace_123",
      workspace: {
        async execute() {
          throw new Error("outer workspace execution must not validate scenes");
        },
        async executeSubmittedCode(command) {
          if (command.includes("bun '/workspace/.makeademo/")) {
            if (!command.includes("npm root -g")) {
              return {
                exitCode: 1,
                stderr: "Cannot find module '@playwright/test'",
                stdout: "",
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout:
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_playwright_dependency"}',
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async setOutboundNetworkAccess() {},
        async uploadFiles() {},
      },
    };

    const result = await validator.validateScene({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async () => {});",
        "await scene('scene_playwright_dependency', async () => {});",
      ].join("\n"),
      preparationWorkspace,
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Show the page.",
        id: "scene_playwright_dependency",
      },
      sectionId: "section_playwright_dependency",
    });

    expect(result.status).toBe("succeeded");
  }, 20_000);

  it("reports missing prepared-workspace Playwright as a MakeADemo validator dependency failure", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "workspace_123",
      workspace: {
        async execute() {
          throw new Error("outer workspace execution must not validate scenes");
        },
        async executeSubmittedCode(command) {
          if (command.includes("bun '/workspace/.makeademo/")) {
            return {
              exitCode: 1,
              stderr:
                "Error: Cannot find module '@playwright/test'\nRequire stack:\n- /workspace/.makeademo/capture-path-validation-runs/run/scene/demo-script.ts",
              stdout: "",
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async setOutboundNetworkAccess() {},
        async uploadFiles() {},
      },
    };

    const result = await validator.validateScene({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async () => {});",
        "await scene('scene_missing_playwright', async () => {});",
      ].join("\n"),
      preparationWorkspace,
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Show the page.",
        id: "scene_missing_playwright",
      },
      sectionId: "section_missing_playwright",
    });

    expect(result).toMatchObject({
      failureReason:
        "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.",
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("Cannot find module");
  }, 20_000);

  it("reports the active SDK action and screenshot path when a prepared workspace dry-run scene fails", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "workspace_123",
      workspace: {
        async execute() {
          throw new Error("outer workspace execution must not validate scenes");
        },
        async executeSubmittedCode(command) {
          if (command.includes("bun '/workspace/.makeademo/")) {
            return {
              exitCode: 1,
              stderr:
                '[makeademo:validation] script failed {"message":"Timed out after 5000ms","screenshotPath":"makeademo-validation-failure.png"}',
              stdout: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_action_timeout"}',
                '[makeademo:action] {"elapsedMs":12,"event":"started","label":"locator.click(#save)","sceneId":"scene_action_timeout","timeoutMs":5000}',
                '[makeademo:action] {"elapsedMs":5013,"event":"failed","label":"locator.click(#save)","message":"Timed out after 5000ms","sceneId":"scene_action_timeout","timeoutMs":5000}',
                '[makeademo:scene] {"elapsedMs":5014,"event":"failed","message":"Timed out after 5000ms","sceneId":"scene_action_timeout"}',
              ].join("\n"),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async setOutboundNetworkAccess() {},
        async uploadFiles() {},
      },
    };

    const result = await validator.validateScene({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async ({ page, baseUrl, expect }) => {",
        "  await page.goto(baseUrl);",
        "  await expect(page.locator('body')).toBeVisible();",
        "});",
        "await scene('scene_action_timeout', async ({ page, expect }) => {",
        "  await expect(page.locator('body')).toBeVisible();",
        "  await page.locator('#save').click();",
        "});",
      ].join("\n"),
      preparationWorkspace,
      scene: {
        expectedVisibleOutcome: "The save result is visible.",
        humanReadableDescription: "Click save.",
        id: "scene_action_timeout",
      },
      sectionId: "section_action_timeout",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected dry-run scene validation to fail.");
    }
    const { screenshotArtifactId } = result;

    expect(result).toMatchObject({
      failedAction: "locator.click(#save)",
      failureReason:
        "Scene scene_action_timeout failed during Capture Path Validation while running locator.click(#save).",
      screenshotArtifactId: expect.stringContaining(
        "/workspace/.makeademo/capture-path-validation-runs/",
      ),
      status: "failed",
      stderrPath: expect.stringContaining("scene_action_timeout.stderr.log"),
      stdoutPath: expect.stringContaining("scene_action_timeout.stdout.log"),
    });
    expect(screenshotArtifactId).toContain("makeademo-validation-failure.png");
  }, 20_000);

  it("reports blocked runtime network from prepared-workspace dry-runs", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "workspace_123",
      workspace: {
        async execute() {
          throw new Error("outer workspace execution must not validate scenes");
        },
        async executeSubmittedCode(command) {
          if (command.includes("bun '/workspace/.makeademo/")) {
            return {
              exitCode: 0,
              stderr:
                '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime"}',
              stdout: "",
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async setOutboundNetworkAccess() {},
        async uploadFiles() {},
      },
    };

    const result = await validator.validateScene({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async () => {});",
        "await scene('scene_network', async () => {});",
      ].join("\n"),
      preparationWorkspace,
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Try analytics.",
        id: "scene_network",
      },
      sectionId: "section_network",
    });

    expect(result).toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "analytics.example.com",
          phase: "runtime",
        },
      ],
      failureReason:
        "Capture Path Validation blocked runtime network access from the generated Demo Script.",
      status: "failed",
    });
  });

  it("bounds prepared-workspace dry-runs with a command timeout", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const executedCommands: string[] = [];
    const preparationWorkspace: PreparationWorkspaceHandle = {
      async release() {},
      id: "workspace_123",
      workspace: {
        async execute() {
          throw new Error("outer workspace execution must not validate scenes");
        },
        async executeSubmittedCode(command) {
          executedCommands.push(command);
          if (command.includes("timeout -s TERM 120 bun")) {
            return { exitCode: 124, stderr: "timed out", stdout: "" };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async setOutboundNetworkAccess() {},
        async uploadFiles() {},
      },
    };

    const result = await validator.validateScene({
      baseUrl: "https://preview.example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async () => {});",
        "await scene('scene_timeout', async () => {});",
      ].join("\n"),
      preparationWorkspace,
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Hang.",
        id: "scene_timeout",
      },
      sectionId: "section_timeout",
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(executedCommands.join("\n")).toContain("timeout -s TERM 120 bun");
  });
});
