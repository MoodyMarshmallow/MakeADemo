import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const submittedCodeEvidenceGraceMs = 5_000;
const trustedPlaywrightModuleRoot =
  "/opt/makeademo/playwright-runtime/node_modules";

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
  const localRunDirectory = await mkdtemp(
    join(tmpdir(), "makeademo-demo-script-execution-"),
  );
  const localScriptPath = join(localRunDirectory, input.scriptFilename);
  const remoteScriptPath = `${input.remoteRunDirectory}/${input.scriptFilename}`;
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
    await writeFile(
      localScriptPath,
      prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
        baseUrl: input.baseUrl,
        headed: input.headed ?? false,
        mode: input.mode,
        pauseAfterSceneMs: input.pauseAfterSceneMs ?? 0,
        ...(input.runtimeNetworkPolicy === undefined
          ? {}
          : { runtimeNetworkPolicy: input.runtimeNetworkPolicy }),
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
        createExposeTrustedPlaywrightCommand(),
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

function createExposeTrustedPlaywrightCommand() {
  const commands = [
    'trusted_playwright_modules="${MAKEADEMO_PLAYWRIGHT_MODULE_ROOT:?}"',
    `test "$trusted_playwright_modules" = ${shellQuote(trustedPlaywrightModuleRoot)}`,
    'test -d "$trusted_playwright_modules/@playwright/test"',
    'test -d "$trusted_playwright_modules/playwright"',
    'test -d "$trusted_playwright_modules/playwright-core"',
    "mkdir -p node_modules",
    "rm -rf node_modules/@playwright node_modules/playwright node_modules/playwright-core",
    'ln -s "$trusted_playwright_modules/@playwright" node_modules/@playwright',
    'ln -s "$trusted_playwright_modules/playwright" node_modules/playwright',
    'ln -s "$trusted_playwright_modules/playwright-core" node_modules/playwright-core',
  ];
  return `${commands.join(" && ")} || exit $?`;
}
