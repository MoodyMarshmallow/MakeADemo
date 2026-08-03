import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../shared/logging/pipeline-event-logger";
import { assertDemoScriptCaptureSdkContract } from "../04-script-generation/demo-script/capture-sdk-contract";
import {
  readCaptureSdkSceneEvents,
  reduceCaptureSdkSceneEvents,
} from "../04-script-generation/demo-script/capture-sdk-event.schema";
import {
  type SceneDescription,
  parseDemoScript,
} from "../04-script-generation/demo-script/demo-script.schema";
import type {
  CapturePathValidationFailureKind,
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "./capture-path-validator.interface";
import type { DemoRuntimePreflightInput } from "./demo-runtime-preflight/demo-runtime-preflight";
import type { DemoRuntimePreflightResult } from "./demo-runtime-preflight/validation-result";

const capturePathDiagnosticsLogPath = "/workspace/.makeademo/sandbox-log.jsonl";
const defaultDiagnosticsWriteTimeoutMs = 5_000;
const defaultDiagnosticsLogger = createPipelineEventLogger({
  base: { component: "capture-path-validation" },
  sinks: [
    {
      write(line) {
        process.stderr.write(line);
      },
    },
  ],
});

export type CapturePathSceneValidationInput = {
  baseUrl: string;
  demoPlaywrightScript: string;
  preparationWorkspace: CapturePathValidationInput["preparationWorkspace"];
  scene: SceneDescription;
  sectionId: string;
};

export type CapturePathSceneValidationResult =
  | {
      logs: string[];
      runDirectory?: string;
      scriptPath?: string;
      status: "succeeded";
      stderrPath?: string;
      stdoutPath?: string;
    }
  | {
      blockedNetworkAttempts?: CapturePathValidationResult["blockedNetworkAttempts"];
      errorMessage?: string;
      failureKind?: CapturePathValidationFailureKind;
      failedAction?: string;
      failureReason: string;
      logs: string[];
      runDirectory?: string;
      screenshotArtifactId?: string;
      scriptPath?: string;
      status: "failed";
      stderrPath?: string;
      stdoutPath?: string;
    };

/**
 * Dry-runs one Scene Description without recording final Scene footage.
 * Implementations must execute generated Browser Actions quickly, report failed
 * actions where possible, and must not apply recording-only cursor or typing effects.
 */
export interface CapturePathSceneValidator {
  validateScene(
    input: CapturePathSceneValidationInput,
  ): Promise<CapturePathSceneValidationResult>;
}

export type CapturePathValidationDependencies = {
  diagnosticsLogger?: Pick<PipelineEventLogger, "warn">;
  diagnosticsWriteTimeoutMs?: number;
  sceneValidator: CapturePathSceneValidator;
  sceneValidationTimeoutMs?: number;
  runRuntimePreflight(
    input: DemoRuntimePreflightInput,
  ): Promise<DemoRuntimePreflightResult>;
};

const defaultDemoScriptProviderDeadlineMs = 125_000;
const defaultSceneValidationStagingAndEvidenceHeadroomMs = 25_000;
const defaultSceneValidationTimeoutMs =
  defaultDemoScriptProviderDeadlineMs +
  defaultSceneValidationStagingAndEvidenceHeadroomMs;

export async function validateCapturePath(
  input: CapturePathValidationInput,
  dependencies: CapturePathValidationDependencies,
): Promise<CapturePathValidationResult> {
  await writeCapturePathDiagnostics(input, dependencies, {
    event: "capture-path-validation.run.started",
  });

  let demoScript: ReturnType<typeof parseDemoScript>;
  let firstScene: SceneDescription;
  try {
    demoScript = parseDemoScript(input.demoScript);
    assertDemoScriptCaptureSdkContract(demoScript);
    const declaredFirstScene = demoScript.scenes[0];
    if (declaredFirstScene === undefined) {
      throw new Error("Demo Script must declare at least one Scene.");
    }
    firstScene = declaredFirstScene;
  } catch (error) {
    return await capturePathDemoScriptFailure({
      browserUrl: input.preparationManifest.url,
      dependencies,
      error,
      input,
      logs: [],
    });
  }

  await writeCapturePathDiagnostics(input, dependencies, {
    event: "capture-path-validation.runtime-preflight.started",
  });
  const runtimePreflight = await dependencies.runRuntimePreflight({
    preparationManifest: input.preparationManifest,
    preparationWorkspace: input.preparationWorkspace,
  });

  if (runtimePreflight.status === "failed") {
    const failureLogExcerpt = createLogExcerpt(runtimePreflight.logs);
    await writeCapturePathDiagnostics(input, dependencies, {
      blockedNetworkAttemptCount:
        runtimePreflight.blockedNetworkAttempts.length,
      event: "capture-path-validation.runtime-preflight.failed",
      failureLogExcerpt,
      failureReason: runtimePreflight.failureReason,
      logs: runtimePreflight.logs,
      warningCount: runtimePreflight.warnings.length,
    });
    return {
      ...runtimePreflight,
      diagnosticsLogPath: capturePathDiagnosticsLogPath,
    };
  }

  await writeCapturePathDiagnostics(input, dependencies, {
    blockedNetworkAttemptCount: runtimePreflight.blockedNetworkAttempts.length,
    browserUrl: runtimePreflight.browserUrl,
    event: "capture-path-validation.runtime-preflight.succeeded",
    logs: runtimePreflight.logs,
    warningCount: runtimePreflight.warnings.length,
  });

  const logs = [...runtimePreflight.logs];
  const browserUrl =
    runtimePreflight.browserUrl ?? input.preparationManifest.url;
  const sceneBaseUrl = input.preparationManifest.url;
  await writeCapturePathDiagnostics(input, dependencies, {
    event: "capture-path-validation.demo-script.started",
    scenes: demoScript.scenes.map((scene) => ({
      expectedVisibleOutcome: scene.expectedVisibleOutcome,
      sceneDescription: scene.humanReadableDescription,
      sceneId: scene.id,
    })),
  });
  let sceneResult: CapturePathSceneValidationResult;
  try {
    sceneResult = await withTimeout(
      dependencies.sceneValidator.validateScene({
        baseUrl: sceneBaseUrl,
        demoPlaywrightScript: demoScript.demoPlaywrightScript,
        preparationWorkspace: input.preparationWorkspace,
        scene: firstScene,
        sectionId: "demo-script",
      }),
      dependencies.sceneValidationTimeoutMs ?? defaultSceneValidationTimeoutMs,
      `Demo Script dry-run timed out after ${
        dependencies.sceneValidationTimeoutMs ?? defaultSceneValidationTimeoutMs
      }ms.`,
    );
  } catch (error) {
    if (!(error instanceof CapturePathValidationTimeoutError)) {
      throw error;
    }

    sceneResult = {
      failureReason: error.message,
      logs: [error.message],
      status: "failed",
    };
  }
  logs.push(...sceneResult.logs);

  if (sceneResult.status === "failed") {
    return await capturePathSceneFailure({
      browserUrl,
      dependencies,
      input,
      logs,
      runtimePreflight,
      sceneId: readFailedSceneId(sceneResult.logs) ?? firstScene.id,
      sceneResult,
    });
  }

  const markerValidation = validateSceneMarkers(
    sceneResult.logs,
    demoScript.scenes.map((scene) => scene.id),
  );
  if (markerValidation.status === "failed") {
    return await capturePathSceneFailure({
      browserUrl,
      dependencies,
      input,
      logs,
      runtimePreflight,
      sceneId: markerValidation.sceneId ?? firstScene.id,
      sceneResult: {
        ...sceneResult,
        failureReason: markerValidation.reason,
        status: "failed",
      },
    });
  }

  for (const scene of demoScript.scenes) {
    await writeCapturePathDiagnostics(input, dependencies, {
      event: "capture-path-validation.scene.succeeded",
      logs: sceneResult.logs,
      runDirectory: sceneResult.runDirectory,
      sceneId: scene.id,
      scriptPath: sceneResult.scriptPath,
      sectionId: "demo-script",
      stderrPath: sceneResult.stderrPath,
      stdoutPath: sceneResult.stdoutPath,
    });
  }

  await writeCapturePathDiagnostics(input, dependencies, {
    event: "capture-path-validation.run.succeeded",
    sceneCount: demoScript.scenes.length,
  });
  return {
    blockedNetworkAttempts: [],
    browserUrl,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    logs,
    ...(runtimePreflight.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: runtimePreflight.screenshotArtifactId }),
    status: "succeeded",
    warnings: runtimePreflight.warnings,
  };
}

async function capturePathDemoScriptFailure(input: {
  browserUrl: string;
  dependencies: CapturePathValidationDependencies;
  error: unknown;
  input: CapturePathValidationInput;
  logs: string[];
  runtimePreflight?: DemoRuntimePreflightResult & { warnings: string[] };
}): Promise<CapturePathValidationResult> {
  const failureReason = readErrorMessage(input.error);
  const failedSceneId = readFailedContractSceneId(failureReason);
  const logs = [...input.logs, failureReason];
  const failureLogExcerpt = createLogExcerpt(logs);
  const blockedNetworkAttempts =
    input.runtimePreflight?.blockedNetworkAttempts ?? [];
  const warnings = input.runtimePreflight?.warnings ?? [];
  await writeCapturePathDiagnostics(input.input, input.dependencies, {
    blockedNetworkAttemptCount: blockedNetworkAttempts.length,
    event: "capture-path-validation.demo-script.failed",
    failedSceneId,
    failureLogExcerpt,
    failureReason,
    logs,
    warningCount: warnings.length,
  });

  return {
    blockedNetworkAttempts,
    browserUrl: input.browserUrl,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    ...(failedSceneId === undefined ? {} : { failedSceneId }),
    failureReason,
    logs,
    ...(input.runtimePreflight?.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: input.runtimePreflight.screenshotArtifactId }),
    status: "failed",
    warnings,
  };
}

async function capturePathSceneFailure(input: {
  browserUrl: string;
  dependencies: CapturePathValidationDependencies;
  input: CapturePathValidationInput;
  logs: string[];
  runtimePreflight: DemoRuntimePreflightResult & { warnings: string[] };
  sceneId: string;
  sceneResult: Extract<CapturePathSceneValidationResult, { status: "failed" }>;
}): Promise<CapturePathValidationResult> {
  const failureLogExcerpt = createLogExcerpt(input.sceneResult.logs);
  await writeCapturePathDiagnostics(input.input, input.dependencies, {
    blockedNetworkAttemptCount:
      input.sceneResult.blockedNetworkAttempts?.length ?? 0,
    event: "capture-path-validation.scene.failed",
    failedAction: input.sceneResult.failedAction,
    errorMessage: input.sceneResult.errorMessage,
    failureLogExcerpt,
    failureReason: input.sceneResult.failureReason,
    logs: input.sceneResult.logs,
    runDirectory: input.sceneResult.runDirectory,
    sceneId: input.sceneId,
    scriptPath: input.sceneResult.scriptPath,
    screenshotArtifactId: input.sceneResult.screenshotArtifactId,
    sectionId: "demo-script",
    stderrPath: input.sceneResult.stderrPath,
    stdoutPath: input.sceneResult.stdoutPath,
  });

  return {
    blockedNetworkAttempts: input.sceneResult.blockedNetworkAttempts ?? [],
    browserUrl: input.browserUrl,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    failedSceneId: input.sceneId,
    failureReason: input.sceneResult.failureReason,
    logs: input.logs,
    ...(input.sceneResult.failedAction === undefined
      ? {}
      : { failedAction: input.sceneResult.failedAction }),
    ...(input.sceneResult.failureKind === undefined
      ? {}
      : { failureKind: input.sceneResult.failureKind }),
    ...(input.sceneResult.errorMessage === undefined
      ? {}
      : { errorMessage: input.sceneResult.errorMessage }),
    ...(input.sceneResult.runDirectory === undefined
      ? {}
      : { runDirectory: input.sceneResult.runDirectory }),
    ...(input.sceneResult.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: input.sceneResult.screenshotArtifactId }),
    ...(input.sceneResult.scriptPath === undefined
      ? {}
      : { scriptPath: input.sceneResult.scriptPath }),
    ...(input.sceneResult.stderrPath === undefined
      ? {}
      : { stderrPath: input.sceneResult.stderrPath }),
    ...(input.sceneResult.stdoutPath === undefined
      ? {}
      : { stdoutPath: input.sceneResult.stdoutPath }),
    status: "failed",
    warnings: input.runtimePreflight.warnings,
  };
}

function validateSceneMarkers(logs: string[], sceneIds: string[]) {
  const parsed = readCaptureSdkSceneEvents(logs);
  const malformed = parsed.find((marker) => marker.status === "malformed");
  if (malformed?.status === "malformed") {
    return {
      reason: `Capture Path emitted malformed Scene marker: ${malformed.line}`,
      status: "failed" as const,
    };
  }

  const result = reduceCaptureSdkSceneEvents(
    parsed
      .filter((marker) => marker.status === "valid")
      .map((marker) => marker.event),
    sceneIds,
  );
  if (result.status === "succeeded") {
    return result;
  }

  switch (result.code) {
    case "undeclared":
      return {
        reason: `Capture Path emitted undeclared Scene marker ${result.sceneId}.`,
        sceneId: result.sceneId,
        status: "failed" as const,
      };
    case "nested":
      return {
        reason: "Capture Path emitted nested Scene markers.",
        status: "failed" as const,
      };
    case "duplicate":
      return {
        reason: `Capture Path emitted duplicate Scene marker ${result.sceneId}.`,
        sceneId: result.sceneId,
        status: "failed" as const,
      };
    case "not-started":
      return {
        reason: `Capture Path emitted ${result.event?.event ?? "end"} marker before start for Scene ${result.sceneId}.`,
        sceneId: result.sceneId,
        status: "failed" as const,
      };
    case "failed":
      return {
        reason: `Scene ${result.sceneId} failed during Capture Path Validation.${
          result.message === undefined ? "" : ` ${result.message}`
        }`,
        sceneId: result.sceneId,
        status: "failed" as const,
      };
    case "unclosed":
      return {
        reason:
          "Capture Path emitted Scene start marker without an end marker.",
        ...(result.sceneId === undefined ? {} : { sceneId: result.sceneId }),
        status: "failed" as const,
      };
    case "missing":
      return {
        reason: `Scene ${result.sceneId} did not emit complete Capture Path markers.`,
        sceneId: result.sceneId,
        status: "failed" as const,
      };
  }
}

function readFailedSceneId(logs: string[]) {
  for (const marker of readCaptureSdkSceneEvents(logs)) {
    if (marker.status === "valid" && marker.event.event === "failed") {
      return marker.event.sceneId;
    }
  }

  return undefined;
}

async function writeCapturePathDiagnostics(
  input: CapturePathValidationInput,
  dependencies: CapturePathValidationDependencies,
  entry: Record<string, unknown>,
) {
  const write = input.preparationWorkspace?.workspace.writeSandboxLog?.({
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    diagnosticsSource: "capture-path-validation",
    ...removeUndefinedValues(entry),
    repoUrl: input.preparationManifest.repoUrl,
    scriptId: input.demoScript.scriptId,
    stage: "capture-path-validation",
    workspaceId: input.preparationManifest.workspaceId,
  });
  if (write === undefined) {
    return;
  }

  const failedEvent = typeof entry.event === "string" ? entry.event : undefined;
  try {
    await withTimeout(
      write,
      dependencies.diagnosticsWriteTimeoutMs ??
        defaultDiagnosticsWriteTimeoutMs,
      `Capture Path Validation diagnostics log write timed out after ${
        dependencies.diagnosticsWriteTimeoutMs ??
        defaultDiagnosticsWriteTimeoutMs
      }ms.`,
    );
  } catch (error) {
    await writeFallbackDiagnosticsWarning(
      input,
      dependencies,
      error,
      failedEvent,
    );
  }
}

async function writeFallbackDiagnosticsWarning(
  input: CapturePathValidationInput,
  dependencies: CapturePathValidationDependencies,
  error: unknown,
  failedEvent: string | undefined,
) {
  const timeoutMs =
    dependencies.diagnosticsWriteTimeoutMs ?? defaultDiagnosticsWriteTimeoutMs;

  try {
    await withTimeout(
      Promise.resolve(
        (dependencies.diagnosticsLogger ?? defaultDiagnosticsLogger).warn(
          {
            diagnosticsLogPath: capturePathDiagnosticsLogPath,
            diagnosticsSource: "capture-path-validation",
            error: readErrorMessage(error),
            event: "capture-path-validation.diagnostics-log-write-failed",
            ...(failedEvent === undefined ? {} : { failedEvent }),
            repoUrl: input.preparationManifest.repoUrl,
            scriptId: input.demoScript.scriptId,
            stage: "capture-path-validation",
            workspaceId: input.preparationManifest.workspaceId,
          },
          "Capture Path Validation diagnostics log write failed.",
        ),
      ),
      timeoutMs,
      `Capture Path Validation fallback diagnostics warning timed out after ${timeoutMs}ms.`,
    );
  } catch {
    // Preserve Capture Path Validation progress if the fallback logger fails or hangs.
  }
}

function removeUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function createLogExcerpt(logs: string[]) {
  return logs.join("\n").slice(0, 4_000);
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readFailedContractSceneId(failureReason: string) {
  return /^Scene ([^ ]+) /.exec(failureReason)?.[1];
}

class CapturePathValidationTimeoutError extends Error {}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new CapturePathValidationTimeoutError(message)),
        timeoutMs,
      );
    }),
  ]);
}
