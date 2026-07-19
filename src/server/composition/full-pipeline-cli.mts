import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { createDaytonaFreshCaptureStatePreparer } from "../pipeline/00-orchestration/fresh-capture-state";
import { formatFullPipelineFailure } from "../pipeline/00-orchestration/full-pipeline-failure-output";
import { runFullPipelineJob } from "../pipeline/00-orchestration/full-pipeline-runner";
import { collectPreCaptureCliOptions } from "../pipeline/00-orchestration/pre-capture-cli-interactive";
import { readRepoSecurityInput } from "../pipeline/00-orchestration/pre-capture-repo-security";
import { readDemoBrief } from "../pipeline/01-context-gathering/intake/project-intake";
import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../pipeline/01-context-gathering/supporting-documents";
import { ensureOpenCodeProviderDaytonaSecret } from "../shared/integrations/daytona/daytona-opencode-provider-secrets";
import {
  createFilePipelineLogSink,
  createPipelineEventLogger,
  createPrettyPipelineLogSink,
} from "../shared/logging/pipeline-event-logger";
import { createAgentOutputRouter } from "./agent-output";
import {
  type ProductionAgentCliOptions,
  parseProductionAgentCliArgs,
} from "./production-agent-cli-options";
import { createProductionAgentHarness } from "./production-agent-harness";
import { resolveProductionAgentModelConfig } from "./production-agent-model-config";

const { outputRoot, preCaptureArgs } = readFullPipelineArgs(
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

if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for full pipeline runs.");
}

const cliLogger = createPipelineEventLogger({
  base: { component: "full-pipeline-cli" },
  sinks: [cliLogSink, localPipelineLogSink],
});
const normalizedSupportingDocuments = await Promise.all(
  options.docs.map(async (docPath) => {
    const contents = await readFile(docPath, "utf8");
    const stats = await stat(docPath);
    const source = readSupportingDocumentUpload({
      artifactId: `local-doc:${docPath}`,
      fileName: basename(docPath),
      mimeType: inferTextMimeType(docPath),
      sizeBytes: stats.size,
    });

    return normalizeSupportingDocument({ contents, source });
  }),
);
const agentOutputRouter = createAgentOutputRouter({
  runDirectory,
  writeDiagnostic: (chunk) => process.stderr.write(chunk),
  writeStandard: (text) => process.stdout.write(text),
});
const providerSecretName = await ensureOpenCodeProviderDaytonaSecret({
  daytonaApiKey,
  logger: cliLogger.child({ component: "opencode-provider-secrets" }),
  providerID: agentModel.providerID,
});
const productionAgentHarness = createProductionAgentHarness({
  agentModel,
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  ...(daytonaSubmittedCodeSnapshot === undefined
    ? {}
    : { daytonaSubmittedCodeSnapshot }),
  logger: cliLogger.child({ component: "agent-harness" }),
  onRepoPreparationDiagnostic: agentOutputRouter.repoPreparation.onDiagnostic,
  onRepoPreparationStandard: agentOutputRouter.repoPreparation.onStandard,
  providerSecretName,
  sandboxLogSinks: [cliLogSink, localSandboxLogSink],
  onAgentDiagnostic: agentOutputRouter.agentTasks.onDiagnostic,
  onAgentStandard: agentOutputRouter.agentTasks.onStandard,
});
const repoSecurity = await readRepoSecurityInput(
  productionAgentHarness.repoSecurityProvider,
  options.repoUrl,
  {
    ...(options.commitSha === undefined
      ? {}
      : { commitSha: options.commitSha }),
    logger: cliLogger.child({ component: "repo-security-screen" }),
  },
);

const result = await runFullPipelineJob(
  {
    ...(options.commitSha === undefined
      ? {}
      : { commitSha: options.commitSha }),
    demoBrief: readDemoBrief({ keyProductFeatures: options.features }),
    normalizedSupportingDocuments,
    repoSecurity,
    repoUrl: options.repoUrl,
    workspaceId: options.workspaceId,
  },
  productionAgentHarness.preCaptureDependencies,
  {
    logSinks: [cliLogSink],
    outputRoot: fullPipelineOutputRoot,
    prepareFreshCaptureState: createDaytonaFreshCaptureStatePreparer(),
    agentAuditLogPath: agentOutputRouter.primaryAuditLogPath,
    reviewDraftComposite: productionAgentHarness.reviewDraftComposite,
    runId,
    sandboxLogPath,
    scriptGenerationAuditLogPath:
      agentOutputRouter.scriptGenerationAuditLogPath,
  },
)
  .catch((error: unknown) => {
    const formattedFailure = formatFullPipelineFailure(error);
    if (formattedFailure === undefined) {
      throw error;
    }

    process.stderr.write(`\n${formattedFailure}`);
    process.exitCode = 1;
    return undefined;
  })
  .finally(async () => {
    await Promise.all([agentOutputRouter.close()]);
  });

if (result !== undefined) {
  process.stdout.write("\nFull pipeline complete.\n");
  process.stdout.write(
    `Final video: ${result.finalVideo.outputVideoPath ?? result.finalVideo.viewUrl}\n`,
  );
  process.stdout.write(`Generated script: ${result.scriptPath}\n`);
  process.stdout.write(
    `Capture manifest: ${result.captureManifest.manifestPath}\n`,
  );
  process.stdout.write(
    `Composite manifest: ${result.finalVideo.manifestPath}\n`,
  );
  process.stdout.write(`Log: ${result.logPath}\n`);
  if (result.sandboxLogPath !== undefined) {
    process.stdout.write(`Sandbox log: ${result.sandboxLogPath}\n`);
  }
  process.stdout.write(
    `Agent audit log: ${agentOutputRouter.primaryAuditLogPath}\n`,
  );
  process.stdout.write(
    `Script Generation audit log: ${agentOutputRouter.scriptGenerationAuditLogPath}\n`,
  );
  process.stdout.write(`Result JSON: ${result.resultPath}\n`);
}

function readFullPipelineArgs(args: string[]) {
  const preCaptureArgs: string[] = [];
  let outputRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === "--output-root") {
      outputRoot = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    preCaptureArgs.push(arg);
  }

  return outputRoot === undefined
    ? { preCaptureArgs }
    : { outputRoot, preCaptureArgs };
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

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}
