import { join } from "node:path";

import { readCaptureSdkBrowserActionEvents } from "../04-script-generation/demo-script/capture-sdk-event.schema";
import {
  DemoScriptTypeValidationError,
  executeDemoScriptInSandbox,
} from "../04-script-generation/demo-script/demo-script-sandbox-executor";
import type {
  CapturePathSceneValidationInput,
  CapturePathSceneValidationResult,
  CapturePathSceneValidator,
} from "./capture-path-validator";

const missingSandboxPlaywrightFailureReason =
  "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.";
const capturePathDemoScriptTimeoutMs = 120_000;

export class DefaultCapturePathSceneValidator
  implements CapturePathSceneValidator
{
  async validateScene(
    input: CapturePathSceneValidationInput,
  ): Promise<CapturePathSceneValidationResult> {
    const runDirectory = `/workspace/.makeademo/capture-path-validation-runs/${createRunId()}/${input.scene.id}`;
    let result: Awaited<ReturnType<typeof executeDemoScriptInSandbox>>;
    try {
      result = await executeDemoScriptInSandbox({
        baseUrl: input.baseUrl,
        demoPlaywrightScript: input.demoPlaywrightScript,
        headed: false,
        mode: "validation",
        pauseAfterSceneMs: 0,
        remoteRunDirectory: runDirectory,
        scriptFilename: `${input.scene.id}.ts`,
        timeoutMs: capturePathDemoScriptTimeoutMs,
        workspace: input.preparationWorkspace.workspace,
      });
    } catch (error) {
      if (error instanceof DemoScriptTypeValidationError) {
        return {
          failureReason:
            "Demo Script failed Capture SDK TypeScript validation.",
          logs: [error.message],
          runDirectory,
          status: "failed",
        };
      }
      throw error;
    }

    const logs = [result.stdout, result.stderr].filter(
      (output) => output.length > 0,
    );
    const blockedNetworkAttempts = result.blockedNetworkAttempts;
    if (blockedNetworkAttempts.length > 0) {
      return {
        blockedNetworkAttempts,
        failureReason:
          "Capture Path Validation blocked runtime network access from the generated Demo Script.",
        logs,
        runDirectory,
        scriptPath: result.scriptPath,
        stderrPath: result.stderrPath,
        status: "failed",
        stdoutPath: result.stdoutPath,
      };
    }

    if (result.exitCode !== 0) {
      if (result.timedOut) {
        return {
          failureReason: `Demo Script dry-run timed out after ${capturePathDemoScriptTimeoutMs}ms.`,
          logs,
          runDirectory,
          scriptPath: result.scriptPath,
          stderrPath: result.stderrPath,
          status: "failed",
          stdoutPath: result.stdoutPath,
        };
      }
      if (isMissingSandboxPlaywrightError(logs)) {
        return {
          failureReason: missingSandboxPlaywrightFailureReason,
          logs,
          runDirectory,
          scriptPath: result.scriptPath,
          stderrPath: result.stderrPath,
          status: "failed",
          stdoutPath: result.stdoutPath,
        };
      }

      const failedAction = readFailedAction(logs);
      const errorMessage = readValidationFailureMessage(logs);
      const screenshotArtifactId = readValidationFailureScreenshotPath(
        logs,
        runDirectory,
      );
      return {
        ...(errorMessage === undefined ? {} : { errorMessage }),
        ...(failedAction === undefined ? {} : { failedAction }),
        failureReason: createSceneFailureReason(input.scene.id, failedAction),
        logs,
        runDirectory,
        ...(screenshotArtifactId === undefined ? {} : { screenshotArtifactId }),
        scriptPath: result.scriptPath,
        stderrPath: result.stderrPath,
        status: "failed",
        stdoutPath: result.stdoutPath,
      };
    }

    return {
      logs,
      runDirectory,
      scriptPath: result.scriptPath,
      status: "succeeded",
      stderrPath: result.stderrPath,
      stdoutPath: result.stdoutPath,
    };
  }
}

function createSceneFailureReason(sceneId: string, failedAction?: string) {
  return `Scene ${sceneId} failed during Capture Path Validation${
    failedAction === undefined ? "" : ` while running ${failedAction}`
  }.`;
}

function readFailedAction(logs: string[]) {
  let openAction: string | undefined;
  let failedAction: string | undefined;

  for (const marker of readActionMarkers(logs)) {
    if (marker.status !== "valid") {
      continue;
    }

    if (marker.event.event === "started") {
      openAction = marker.event.label;
      continue;
    }

    if (
      marker.event.event === "succeeded" &&
      openAction === marker.event.label
    ) {
      openAction = undefined;
      continue;
    }

    if (marker.event.event === "failed") {
      failedAction = marker.event.label;
      openAction = undefined;
    }
  }

  return failedAction ?? openAction;
}

function readActionMarkers(logs: string[]) {
  return readCaptureSdkBrowserActionEvents(logs);
}

function readValidationFailureScreenshotPath(
  logs: string[],
  runDirectory: string,
) {
  const failure = readValidationFailure(logs);
  if (
    failure !== undefined &&
    typeof failure.screenshotPath === "string" &&
    failure.screenshotPath.trim().length > 0
  ) {
    return failure.screenshotPath.startsWith("/")
      ? failure.screenshotPath
      : join(runDirectory, failure.screenshotPath);
  }

  return undefined;
}

function readValidationFailureMessage(logs: string[]) {
  const failure = readValidationFailure(logs);
  return typeof failure?.message === "string" && failure.message.length > 0
    ? failure.message
    : undefined;
}

function readValidationFailure(logs: string[]) {
  for (const line of logs.join("\n").split("\n")) {
    const marker = line.trim();
    if (!marker.startsWith("[makeademo:validation] script failed ")) {
      continue;
    }

    try {
      const failure = JSON.parse(
        marker.slice("[makeademo:validation] script failed ".length),
      );
      if (typeof failure === "object" && failure !== null) {
        return failure as Record<string, unknown>;
      }
    } catch {}
  }

  return undefined;
}

function isMissingSandboxPlaywrightError(logs: string[]) {
  return /Cannot find module ['"](?:playwright|@playwright\/test)['"]/.test(
    logs.join("\n"),
  );
}

function createRunId() {
  return `capture-path-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}
