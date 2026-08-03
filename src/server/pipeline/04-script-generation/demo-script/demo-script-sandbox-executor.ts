import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import { executeMakeADemoCapture } from "../../03-repo-preparation/makeademo-capture-execution";
import { uploadSubmittedCodeWorkspaceFiles } from "../../03-repo-preparation/preparation-workspace-upload";
import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";
import { executeSubmittedCode } from "../../03-repo-preparation/submitted-code-execution";
import type { RuntimeNetworkPolicy } from "../../05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";
import {
  type CaptureSdkBlockedNetworkEvent,
  parseCaptureSdkBlockedNetworkEvents,
} from "./capture-sdk-event.schema";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "./capture-sdk-harness";
import { prepareStylizedPlaywrightScript } from "./stylized-playwright-script";

const trustedCapturePlaywrightBridge =
  "/opt/makeademo/capture-runtime/playwright.mjs";

export type DemoScriptSandboxExecutionInput = {
  baseUrl: string;
  demoPlaywrightScript: string;
  headed?: boolean;
  mode: "recording" | "validation";
  pauseAfterSceneMs?: number;
  remoteRunDirectory: string;
  runtimeNetworkPolicy?: RuntimeNetworkPolicy;
  scriptFilename: string;
  timeoutMs: number;
  videoDirectory?: string;
  workspace: PreparationWorkspace;
};

export type DemoScriptSandboxExecutionResult = {
  blockedNetworkAttempts: CaptureSdkBlockedNetworkEvent[];
  exitCode: number;
  runDirectory: string;
  scriptPath: string;
  stderr: string;
  stderrPath: string;
  stdout: string;
  stdoutPath: string;
  timedOut: boolean;
};

/** Raised when a Demo Script fails the MakeADemo-owned Capture SDK types. */
export class DemoScriptTypeValidationError extends Error {
  readonly failureKind = "demo-script-type-validation-failed" as const;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DemoScriptTypeValidationError";
  }
}

/**
 * Stages and executes one typed Demo Script inside submitted-code isolation.
 * Callers retain ownership of interpreting the raw process evidence for their
 * Capture Path Validation or Footage Capture outcome.
 */
export async function executeDemoScriptInSandbox(
  input: DemoScriptSandboxExecutionInput,
): Promise<DemoScriptSandboxExecutionResult> {
  if (/\bchromium\s*\.\s*launch\s*\(/.test(input.demoPlaywrightScript)) {
    throw new DemoScriptTypeValidationError(
      new Error(
        "Demo Scripts must not launch their own Playwright browser. Use Capture SDK setup() and scene() callbacks; MakeADemo owns the trusted browser harness.",
      ),
    );
  }

  const localRunDirectory = await mkdtemp(
    join(tmpdir(), "makeademo-demo-script-execution-"),
  );
  const compiledScriptFilename = input.scriptFilename.replace(/\.ts$/, ".mjs");
  const localScriptPath = join(localRunDirectory, compiledScriptFilename);
  const remoteScriptPath = `${input.remoteRunDirectory}/${compiledScriptFilename}`;
  const artifactName = input.scriptFilename.replace(/\.ts$/, "");
  const remoteStdoutPath = `${input.remoteRunDirectory}/${artifactName}.stdout.log`;
  const remoteStderrPath = `${input.remoteRunDirectory}/${artifactName}.stderr.log`;

  try {
    await writeGeneratedCaptureSdkHarness(localRunDirectory, {
      ...(input.runtimeNetworkPolicy === undefined
        ? {}
        : { runtimeNetworkPolicy: input.runtimeNetworkPolicy }),
    });
    try {
      await validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: input.demoPlaywrightScript,
        directory: localRunDirectory,
      });
    } catch (error) {
      throw new DemoScriptTypeValidationError(error);
    }
    const preparedScript = prepareStylizedPlaywrightScript(
      input.demoPlaywrightScript,
      {
        baseUrl: input.baseUrl,
        headed: input.headed ?? false,
        mode: input.mode,
        pauseAfterSceneMs: input.pauseAfterSceneMs ?? 0,
        playwrightModuleSpecifier: trustedCapturePlaywrightBridge,
        ...(input.runtimeNetworkPolicy === undefined
          ? {}
          : { runtimeNetworkPolicy: input.runtimeNetworkPolicy }),
        ...(input.videoDirectory === undefined
          ? {}
          : { videoDirectory: input.videoDirectory }),
      },
    );
    await writeFile(localScriptPath, compileDemoScript(preparedScript));

    await executeSubmittedCode(
      input.workspace,
      `mkdir -p ${shellQuote(input.remoteRunDirectory)}`,
    );
    await uploadSubmittedCodeWorkspaceFiles({
      files: [
        "makeademo-capture-sdk.mjs",
        "makeademo-capture-sdk.d.ts",
        "makeademo-capture-sdk.instructions.md",
        "demo-script.contract.ts",
      ]
        .map((filename) => ({
          destinationPath: `${input.remoteRunDirectory}/${filename}`,
          sourcePath: join(localRunDirectory, filename),
        }))
        .concat({
          destinationPath: remoteScriptPath,
          sourcePath: localScriptPath,
        }),
      workspace: input.workspace,
    });

    const result = await executeMakeADemoCapture(input.workspace, {
      runDirectory: input.remoteRunDirectory,
      scriptPath: remoteScriptPath,
      stderrPath: remoteStderrPath,
      stdoutPath: remoteStdoutPath,
      timeoutMs: input.timeoutMs,
    });

    return {
      blockedNetworkAttempts: parseCaptureSdkBlockedNetworkEvents(
        result.stderr,
      ),
      exitCode: result.exitCode,
      runDirectory: input.remoteRunDirectory,
      scriptPath: remoteScriptPath,
      stderr: result.stderr,
      stderrPath: remoteStderrPath,
      stdout: result.stdout,
      stdoutPath: remoteStdoutPath,
      timedOut: result.exitCode === 124,
    };
  } finally {
    await rm(localRunDirectory, { force: true, recursive: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function compileDemoScript(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "demo-script.ts",
  }).outputText;
}
