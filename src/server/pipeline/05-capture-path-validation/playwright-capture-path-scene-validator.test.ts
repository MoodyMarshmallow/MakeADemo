import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { CapturePathSceneValidationInput } from "./capture-path-validator";
import { DefaultCapturePathSceneValidator } from "./playwright-capture-path-scene-validator";

type SandboxExecutionResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

describe("DefaultCapturePathSceneValidator", () => {
  it("maps SDK type errors to a structured validation failure", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const result = await validator.validateScene(
      validationInput(
        "scene_type_error",
        preparedWorkspaceReturning(successfulScene("scene_type_error")),
        [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await setup(async ({ missingThing }) => {",
          "  await missingThing();",
          "});",
          "await scene('scene_type_error', async () => {});",
        ].join("\n"),
      ),
    );

    expect(result).toMatchObject({
      failureReason: "Demo Script failed Capture SDK TypeScript validation.",
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("missingThing");
    expect(result.stdoutPath).toBeUndefined();
    expect(result.stderrPath).toBeUndefined();
  }, 20_000);

  it("maps successful dry-run evidence to sandbox artifact paths", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const result = await validator.validateScene(
      validationInput(
        "scene_workspace",
        preparedWorkspaceReturning(successfulScene("scene_workspace")),
      ),
    );

    expect(result).toMatchObject({
      logs: [expect.stringContaining('"sceneId":"scene_workspace"')],
      runDirectory: expect.stringContaining(
        "/workspace/.makeademo/capture-path-validation-runs/",
      ),
      scriptPath: expect.stringContaining("scene_workspace.mjs"),
      status: "succeeded",
      stderrPath: expect.stringContaining("scene_workspace.stderr.log"),
      stdoutPath: expect.stringContaining("scene_workspace.stdout.log"),
    });
  }, 20_000);

  it("maps missing sandbox Playwright to a validator dependency failure", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const result = await validator.validateScene(
      validationInput(
        "scene_missing_playwright",
        preparedWorkspaceReturning({
          exitCode: 1,
          stderr:
            "Error: Cannot find module '@playwright/test'\nRequire stack:\n- /workspace/.makeademo/capture-path-validation-runs/run/scene/demo-script.ts",
          stdout: "",
        }),
      ),
    );

    expect(result).toMatchObject({
      failureKind: "validator-dependency-failed",
      failureReason:
        "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.",
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("Cannot find module");
  }, 20_000);

  it("maps the active SDK action and screenshot from failed dry-run evidence", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const result = await validator.validateScene(
      validationInput(
        "scene_action_timeout",
        preparedWorkspaceReturning({
          exitCode: 1,
          stderr:
            '[makeademo:validation] script failed {"message":"Timed out after 5000ms","screenshotPath":"makeademo-validation-failure.png"}',
          stdout: [
            '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_action_timeout"}',
            '[makeademo:action] {"elapsedMs":12,"event":"started","label":"locator.click(#save)","sceneId":"scene_action_timeout","timeoutMs":5000}',
            '[makeademo:action] {"elapsedMs":5013,"event":"failed","label":"locator.click(#save)","message":"Timed out after 5000ms","sceneId":"scene_action_timeout","timeoutMs":5000}',
          ].join("\n"),
        }),
      ),
    );

    expect(result).toMatchObject({
      errorMessage: "Timed out after 5000ms",
      failedAction: "locator.click(#save)",
      failureReason:
        "Scene scene_action_timeout failed during Capture Path Validation while running locator.click(#save).",
      screenshotArtifactId: expect.stringMatching(
        /capture-path-validation-runs\/.+\/scene_action_timeout\/makeademo-validation-failure\.png$/,
      ),
      status: "failed",
      stderrPath: expect.stringContaining("scene_action_timeout.stderr.log"),
      stdoutPath: expect.stringContaining("scene_action_timeout.stdout.log"),
    });
  }, 20_000);

  it("maps blocked runtime network evidence to a validation failure", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const result = await validator.validateScene(
      validationInput(
        "scene_network",
        preparedWorkspaceReturning({
          exitCode: 0,
          stderr:
            '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime"}',
          stdout: "",
        }),
      ),
    );

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

  it("does not reject public runtime evidence under the unrestricted policy", async () => {
    const validator = new DefaultCapturePathSceneValidator({
      runtimeNetworkPolicy: "unrestricted-public",
    });
    const result = await validator.validateScene(
      validationInput(
        "scene_network",
        preparedWorkspaceReturning({
          exitCode: 0,
          stderr:
            '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime"}',
          stdout: "",
        }),
      ),
    );

    expect(result).toMatchObject({ status: "succeeded" });
  });

  it("maps an exit-124 timeout to bounded dry-run failure evidence", async () => {
    const validator = new DefaultCapturePathSceneValidator();
    const result = await validator.validateScene(
      validationInput(
        "scene_timeout",
        preparedWorkspaceReturning({
          exitCode: 124,
          stderr: "timed out",
          stdout: "",
        }),
      ),
    );

    expect(result).toMatchObject({
      failureReason: "Demo Script dry-run timed out after 120000ms.",
      logs: ["timed out"],
      runDirectory: expect.stringContaining(
        "/workspace/.makeademo/capture-path-validation-runs/",
      ),
      scriptPath: expect.stringContaining("scene_timeout.mjs"),
      status: "failed",
      stderrPath: expect.stringContaining("scene_timeout.stderr.log"),
      stdoutPath: expect.stringContaining("scene_timeout.stdout.log"),
    });
  });
});

function validationInput(
  sceneId: string,
  preparationWorkspace: PreparationWorkspaceHandle,
  demoPlaywrightScript = validDemoScript(sceneId),
): CapturePathSceneValidationInput {
  return {
    baseUrl: "https://preview.example.test/",
    demoPlaywrightScript,
    preparationWorkspace,
    scene: {
      expectedVisibleOutcome: "The expected page state is visible.",
      humanReadableDescription: "Show the expected page state.",
      id: sceneId,
    },
    sectionId: "demo-script",
  };
}

function validDemoScript(sceneId: string) {
  return [
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async () => {});",
    `await scene('${sceneId}', async () => {});`,
  ].join("\n");
}

function successfulScene(sceneId: string): SandboxExecutionResult {
  return {
    exitCode: 0,
    stderr: "",
    stdout: [
      `[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"${sceneId}"}`,
      `[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"${sceneId}"}`,
    ].join("\n"),
  };
}

function preparedWorkspaceReturning(
  runResult: SandboxExecutionResult,
): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async execute() {
        throw new Error("outer workspace execution must not validate scenes");
      },
      async executeSubmittedCode(command) {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeMakeADemoCapture() {
        return runResult;
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async uploadFiles() {},
    },
  };
}
