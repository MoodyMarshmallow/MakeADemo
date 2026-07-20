import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { uploadSubmittedCodeWorkspaceFiles } from "../../03-repo-preparation/preparation-workspace-upload";
import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";
import { executeSubmittedCode } from "../../03-repo-preparation/submitted-code-execution";
import {
  type CaptureSdkBlockedNetworkEvent,
  parseCaptureSdkBlockedNetworkEvents,
} from "./capture-sdk-event.schema";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "./capture-sdk-harness";
import { prepareStylizedPlaywrightScript } from "./stylized-playwright-script";

const submittedCodeEvidenceGraceMs = 5_000;

export type DemoScriptSandboxExecutionInput = {
  baseUrl: string;
  demoPlaywrightScript: string;
  headed?: boolean;
  mode: "recording" | "validation";
  pauseAfterSceneMs?: number;
  remoteRunDirectory: string;
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
  const localRunDirectory = await mkdtemp(
    join(tmpdir(), "makeademo-demo-script-execution-"),
  );
  const localScriptPath = join(localRunDirectory, input.scriptFilename);
  const remoteScriptPath = `${input.remoteRunDirectory}/${input.scriptFilename}`;
  const artifactName = input.scriptFilename.replace(/\.ts$/, "");
  const remoteStdoutPath = `${input.remoteRunDirectory}/${artifactName}.stdout.log`;
  const remoteStderrPath = `${input.remoteRunDirectory}/${artifactName}.stderr.log`;

  try {
    await writeGeneratedCaptureSdkHarness(localRunDirectory);
    try {
      await validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: input.demoPlaywrightScript,
        directory: localRunDirectory,
      });
    } catch (error) {
      throw new DemoScriptTypeValidationError(error);
    }
    await writeFile(
      localScriptPath,
      prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
        baseUrl: input.baseUrl,
        headed: input.headed ?? false,
        mode: input.mode,
        pauseAfterSceneMs: input.pauseAfterSceneMs ?? 0,
        ...(input.videoDirectory === undefined
          ? {}
          : { videoDirectory: input.videoDirectory }),
      }),
    );

    await executeSubmittedCode(
      input.workspace,
      `mkdir -p ${shellQuote(input.remoteRunDirectory)}`,
    );
    await uploadSubmittedCodeWorkspaceFiles({
      files: [
        "makeademo-capture-sdk.js",
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

    const result = await executeSubmittedCode(
      input.workspace,
      [
        `cd ${shellQuote(input.remoteRunDirectory)}`,
        createExposeGlobalPlaywrightCommand(),
        `timeout -s TERM ${Math.ceil(input.timeoutMs / 1000)} bun ${shellQuote(remoteScriptPath)} > ${shellQuote(remoteStdoutPath)} 2> ${shellQuote(remoteStderrPath)}`,
        "code=$?",
        `cat ${shellQuote(remoteStdoutPath)}`,
        `cat ${shellQuote(remoteStderrPath)} >&2`,
        "exit $code",
      ].join("; "),
      { timeoutMs: input.timeoutMs + submittedCodeEvidenceGraceMs },
    );

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

function createExposeGlobalPlaywrightCommand() {
  return [
    "global_node_modules=$(npm root -g 2>/dev/null || true)",
    'if [ -n "$global_node_modules" ]; then mkdir -p node_modules; fi',
    'if [ -e "$global_node_modules/@playwright" ]; then ln -sfn "$global_node_modules/@playwright" node_modules/@playwright; fi',
    'if [ -e "$global_node_modules/playwright" ]; then ln -sfn "$global_node_modules/playwright" node_modules/playwright; fi',
    'if [ -e "$global_node_modules/playwright-core" ]; then ln -sfn "$global_node_modules/playwright-core" node_modules/playwright-core; fi',
  ].join("; ");
}
