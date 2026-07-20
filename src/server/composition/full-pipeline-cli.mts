import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { formatFullPipelineFailure } from "../pipeline/00-orchestration/cli/full-pipeline-failure-output";
import { collectPreCaptureCliOptions } from "../pipeline/00-orchestration/cli/pre-capture-cli-interactive";
import { runFullPipelineJob } from "../pipeline/00-orchestration/job/full-pipeline-runner";
import {
  PipelineCancellationError,
  throwIfPipelineDeadlineReached,
} from "../pipeline/00-orchestration/job/pipeline-cancellation";
import { readDemoBrief } from "../pipeline/01-context-gathering/intake/project-intake";
import {
  type NormalizedSupportingDocument,
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../pipeline/01-context-gathering/supporting-documents";
import type { RepoSecurityInput } from "../pipeline/02-repo-security-screen/repo-security-screen";
import { readRepoSecurityInput } from "../pipeline/02-repo-security-screen/repository-loading/repo-security-input";
import {
  createFilePipelineLogSink,
  createPipelineEventLogger,
  createPrettyPipelineLogSink,
} from "../shared/logging/pipeline-event-logger";
import { createAgentOutputRouter } from "./agent-output";
import {
  finalizeFullPipelineCli,
  runFullPipelineCliOperation,
} from "./full-pipeline-cli-lifecycle";
import {
  type ProductionAgentCliOptions,
  parseProductionAgentCliArgs,
} from "./production-agent-cli-options";
import { resolveProductionAgentModelConfig } from "./production-agent-model-config";
import { createProductionPipeline } from "./production-pipeline";

const { outputRoot, pipelineDeadlineAt, preCaptureArgs } = readFullPipelineArgs(
  process.argv.slice(2),
);
const { pipeline: options, agentModel } = await readOptions(preCaptureArgs);
const daytonaApiKey = process.env.DAYTONA_API_KEY;
const daytonaSnapshot = readOptionalEnv("MAKEADEMO_DAYTONA_SNAPSHOT");
const daytonaSubmittedCodeSnapshot = readOptionalEnv(
  "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT",
);
const fullPipelineOutputRoot = outputRoot ?? ".makeademo-full-pipeline-runs";
const runId = createRunId();
const runDirectory = join(fullPipelineOutputRoot, runId);
const pipelineLogPath = join(runDirectory, "pipeline-log.jsonl");
const sandboxLogPath = join(runDirectory, "sandbox-log.jsonl");
const localPipelineLogSink = createFilePipelineLogSink(pipelineLogPath);
const localSandboxLogSink = createFilePipelineLogSink(sandboxLogPath);
const cliLogSink = createPrettyPipelineLogSink({
  write: (text) => process.stdout.write(text),
});
const cancellationController = new AbortController();
const deadlineTimer =
  pipelineDeadlineAt === undefined
    ? undefined
    : setTimeout(
        () =>
          cancellationController.abort(
            new PipelineCancellationError("deadline-exceeded"),
          ),
        Math.max(0, pipelineDeadlineAt - Date.now()),
      );
let receivedSignal: NodeJS.Signals | undefined;
const handleSignal = (signal: NodeJS.Signals) => {
  receivedSignal = signal;
  cancellationController.abort(new PipelineCancellationError("signal"));
};
process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);

if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for full pipeline runs.");
}

const cliLogger = createPipelineEventLogger({
  base: { component: "full-pipeline-cli" },
  sinks: [cliLogSink, localPipelineLogSink],
});
const agentOutputRouter = createAgentOutputRouter({
  runDirectory,
  writeDiagnostic: (chunk) => process.stderr.write(chunk),
  writeStandard: (text) => process.stdout.write(text),
});
const productionPipeline = createProductionPipeline({
  agentModel,
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  ...(daytonaSubmittedCodeSnapshot === undefined
    ? {}
    : { daytonaSubmittedCodeSnapshot }),
  logger: cliLogger.child({ component: "agent-harness" }),
  onRepoPreparationDiagnostic: agentOutputRouter.repoPreparation.onDiagnostic,
  onRepoPreparationEvent: agentOutputRouter.repoPreparation.onEvent,
  onRepoPreparationStandard: agentOutputRouter.repoPreparation.onStandard,
  repoSecurityLogger: cliLogger.child({ component: "repo-security-screen" }),
  sandboxLogSinks: [cliLogSink, localSandboxLogSink],
  onAgentDiagnostic: agentOutputRouter.agentTasks.onDiagnostic,
  onAgentEvent: agentOutputRouter.agentTasks.onEvent,
  onAgentStandard: agentOutputRouter.agentTasks.onStandard,
});

let result: Awaited<ReturnType<typeof runFullPipelineJob>> | undefined;
let terminalFailureOutput: string | undefined;
let unexpectedError: unknown;
try {
  result = await runFullPipelineCliOperation({
    materializeCancellation: () =>
      executeFullPipeline({
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [],
          repoStats: { fileCount: 0, sizeBytes: 0 },
        },
      }),
    prepare: async () => {
      throwIfPipelineDeadlineReached(
        cancellationController.signal,
        pipelineDeadlineAt,
      );
      const normalizedSupportingDocuments = await Promise.all(
        options.docs.map(async (docPath) => {
          throwIfPipelineDeadlineReached(
            cancellationController.signal,
            pipelineDeadlineAt,
          );
          const contents = await readFile(docPath, "utf8");
          throwIfPipelineDeadlineReached(
            cancellationController.signal,
            pipelineDeadlineAt,
          );
          const stats = await stat(docPath);
          throwIfPipelineDeadlineReached(
            cancellationController.signal,
            pipelineDeadlineAt,
          );
          const source = readSupportingDocumentUpload({
            artifactId: `local-doc:${docPath}`,
            fileName: basename(docPath),
            mimeType: inferTextMimeType(docPath),
            sizeBytes: stats.size,
          });

          return normalizeSupportingDocument({ contents, source });
        }),
      );
      throwIfPipelineDeadlineReached(
        cancellationController.signal,
        pipelineDeadlineAt,
      );
      const repoSecurity = await readRepoSecurityInput(
        productionPipeline.repoSecurityInputLoader,
        options.repoUrl,
        {
          ...(options.commitSha === undefined
            ? {}
            : { commitSha: options.commitSha }),
          ...(pipelineDeadlineAt === undefined
            ? {}
            : { deadlineAt: pipelineDeadlineAt }),
          signal: cancellationController.signal,
        },
      );
      throwIfPipelineDeadlineReached(
        cancellationController.signal,
        pipelineDeadlineAt,
      );
      return { normalizedSupportingDocuments, repoSecurity };
    },
    run: executeFullPipeline,
  });
} catch (error) {
  const formattedFailure = formatFullPipelineFailure(error);
  if (formattedFailure === undefined) {
    unexpectedError = error;
  } else {
    terminalFailureOutput = `\n${formattedFailure}`;
    process.exitCode =
      receivedSignal === "SIGINT"
        ? 130
        : receivedSignal === "SIGTERM"
          ? 143
          : 1;
  }
}

await finalizeFullPipelineCli({
  cleanup: async () => {
    await Promise.all([
      agentOutputRouter.close(),
      productionPipeline.disposeAgentSessions(),
    ]);
  },
  removeSignalHandlers: () => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  },
  ...(terminalFailureOutput === undefined && result === undefined
    ? {}
    : {
        terminalOutput:
          terminalFailureOutput ??
          formatFullPipelineSuccess(result as NonNullable<typeof result>),
      }),
  write: (output) =>
    terminalFailureOutput === undefined
      ? process.stdout.write(output)
      : process.stderr.write(output),
});

if (unexpectedError !== undefined) throw unexpectedError;

function executeFullPipeline(input: {
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  repoSecurity: RepoSecurityInput;
}) {
  return runFullPipelineJob(
    {
      ...(options.commitSha === undefined
        ? {}
        : { commitSha: options.commitSha }),
      demoBrief: readDemoBrief({ keyProductFeatures: options.features }),
      normalizedSupportingDocuments: input.normalizedSupportingDocuments,
      repoSecurity: input.repoSecurity,
      repoUrl: options.repoUrl,
      workspaceId: options.workspaceId,
    },
    productionPipeline.pipelineDependencies,
    {
      logSinks: [cliLogSink],
      outputRoot: fullPipelineOutputRoot,
      prepareFreshCaptureState: productionPipeline.prepareFreshCaptureState,
      agentAuditLogPath: agentOutputRouter.primaryAuditLogPath,
      reviewDraftComposite: productionPipeline.reviewDraftComposite,
      runId,
      sandboxLogPath,
      ...(pipelineDeadlineAt === undefined
        ? {}
        : { deadlineAt: pipelineDeadlineAt }),
      signal: cancellationController.signal,
      scriptGenerationAuditLogPath:
        agentOutputRouter.scriptGenerationAuditLogPath,
    },
  );
}

function formatFullPipelineSuccess(
  pipelineResult: NonNullable<typeof result>,
): string {
  return [
    "",
    "Full pipeline complete.",
    `Final video: ${pipelineResult.finalVideo.outputVideoPath ?? pipelineResult.finalVideo.viewUrl}`,
    `Generated script: ${pipelineResult.scriptPath}`,
    `Capture manifest: ${pipelineResult.captureManifest.manifestPath}`,
    `Composite manifest: ${pipelineResult.finalVideo.manifestPath}`,
    `Log: ${pipelineResult.logPath}`,
    ...(pipelineResult.sandboxLogPath === undefined
      ? []
      : [`Sandbox log: ${pipelineResult.sandboxLogPath}`]),
    `Agent audit log: ${agentOutputRouter.primaryAuditLogPath}`,
    `Script Generation audit log: ${agentOutputRouter.scriptGenerationAuditLogPath}`,
    `Result JSON: ${pipelineResult.resultPath}`,
    "",
  ].join("\n");
}

function readFullPipelineArgs(args: string[]) {
  const preCaptureArgs: string[] = [];
  let pipelineDeadlineAt: number | undefined;
  let outputRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === "--output-root") {
      outputRoot = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--deadline-at") {
      pipelineDeadlineAt = readDeadlineAt(readFlagValue(args, index, arg));
      index += 1;
      continue;
    }

    preCaptureArgs.push(arg);
  }

  return {
    preCaptureArgs,
    ...(outputRoot === undefined ? {} : { outputRoot }),
    ...(pipelineDeadlineAt === undefined ? {} : { pipelineDeadlineAt }),
  };
}

async function readOptions(args: string[]): Promise<ProductionAgentCliOptions> {
  if (args.length > 0) {
    return parseProductionAgentCliArgs(args);
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const pipeline = await collectPreCaptureCliOptions({
      prompt: (question) => readline.question(question),
      write: (message) => process.stdout.write(`${message}\n`),
    });
    return { agentModel: resolveProductionAgentModelConfig(), pipeline };
  } finally {
    readline.close();
  }
}

function inferTextMimeType(path: string): string {
  if (path.endsWith(".md")) {
    return "text/markdown";
  }

  if (path.endsWith(".json")) {
    return "application/json";
  }

  if (path.endsWith(".csv")) {
    return "text/csv";
  }

  return "text/plain";
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} must be followed by a value`);
  }

  return value;
}

function readDeadlineAt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("--deadline-at must be a positive safe integer timestamp.");
  }
  const deadlineAt = Number(value);
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
    throw new Error("--deadline-at must be a positive safe integer timestamp.");
  }
  return deadlineAt;
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}
