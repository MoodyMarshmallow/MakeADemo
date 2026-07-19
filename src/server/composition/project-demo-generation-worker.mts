import { createDaytonaFreshCaptureStatePreparer } from "../pipeline/00-orchestration/fresh-capture-state";
import { runFullPipelineJob } from "../pipeline/00-orchestration/full-pipeline-runner";
import { readRepoSecurityInput } from "../pipeline/00-orchestration/pre-capture-repo-security";
import { processNextProjectDemoGenerationJob } from "../pipeline/00-orchestration/project-demo-generation-queue";
import { createProjectDemoGenerationWorkerLogger } from "../pipeline/00-orchestration/project-demo-generation-worker-logging";
import { compositeVideoFromScript } from "../pipeline/07-compositing/composite-video";
import { finalVideoEmailsEnabled } from "../pipeline/final-output/final-video-email-feature";
import { ensureOpenCodeProviderDaytonaSecret } from "../shared/integrations/daytona/daytona-opencode-provider-secrets";
import { createResendFinalVideoEmailNotifierFromEnv } from "../shared/integrations/email/resend-final-video-email-notifier";
import { createR2UploadPresignerFromEnv } from "../shared/integrations/storage/r2-client";
import { R2FinalVideoStorage } from "../shared/integrations/storage/r2-final-video-storage";
import { createNeonDemoRequestFinalVideoStore } from "../shared/persistence/neon-demo-request-final-video-store";
import { createNeonProjectDemoGenerationQueueStore } from "../shared/persistence/neon-project-demo-generation-queue-store";
import { createProductionAgentHarness } from "./production-agent-harness";
import { resolveProductionAgentModelConfigFromEnv } from "./production-agent-model-config";

const pollIntervalMs = Number.parseInt(
  process.env.DEMO_QUEUE_POLL_INTERVAL_MS ?? "5000",
  10,
);
const runOnce = process.env.DEMO_QUEUE_WORKER_ONCE === "1";
const daytonaApiKey = readRequiredEnv("DAYTONA_API_KEY");
const daytonaSnapshot = readOptionalEnv("MAKEADEMO_DAYTONA_SNAPSHOT");
const daytonaSubmittedCodeSnapshot = readOptionalEnv(
  "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT",
);
const agentModel = resolveProductionAgentModelConfigFromEnv();
const shouldSendFinalVideoEmail = finalVideoEmailsEnabled(process.env);
const publicAppBaseUrl = shouldSendFinalVideoEmail
  ? readRequiredEnv("PUBLIC_APP_BASE_URL")
  : undefined;
const queueStore = createNeonProjectDemoGenerationQueueStore();
const demoRequestStore = createNeonDemoRequestFinalVideoStore();
const r2 = createR2UploadPresignerFromEnv();
const finalVideoStorage = new R2FinalVideoStorage(r2);
const finalVideoEmailNotifier = shouldSendFinalVideoEmail
  ? createResendFinalVideoEmailNotifierFromEnv()
  : undefined;
const workerLogger = createProjectDemoGenerationWorkerLogger();
const providerSecretName = await ensureOpenCodeProviderDaytonaSecret({
  daytonaApiKey,
  logger: workerLogger.child({ component: "opencode-provider-secrets" }),
  providerID: agentModel.providerID,
});
const productionAgentHarness = createProductionAgentHarness({
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  ...(daytonaSubmittedCodeSnapshot === undefined
    ? {}
    : { daytonaSubmittedCodeSnapshot }),
  agentModel,
  logger: workerLogger.child({ component: "agent-harness" }),
  providerSecretName,
});

await workerLogger.workerStarted();

do {
  const result = await processNextProjectDemoGenerationJob(queueStore, {
    async runFullPipeline(job) {
      const repoSecurity = await readRepoSecurityInput(
        productionAgentHarness.repoSecurityProvider,
        job.repoUrl,
        {
          logger: workerLogger.child({ component: "repo-security-screen" }),
        },
      );

      const pipelineResult = await runFullPipelineJob(
        {
          demoBrief: job.demoBrief,
          normalizedSupportingDocuments: job.normalizedSupportingDocuments,
          repoSecurity,
          repoUrl: job.repoUrl,
          workspaceId: job.workspaceId,
        },
        productionAgentHarness.preCaptureDependencies,
        {
          async compositeVideo(input) {
            return compositeVideoFromScript({
              ...input,
              demoRequestId: job.demoRequestId,
              demoRequestStore,
              ...(finalVideoEmailNotifier === undefined
                ? {}
                : { finalVideoEmailNotifier }),
              finalVideoStorage,
              ...(publicAppBaseUrl === undefined ? {} : { publicAppBaseUrl }),
            });
          },
          onProgress: (event) => workerLogger.pipelineProgress(event),
          prepareFreshCaptureState: createDaytonaFreshCaptureStatePreparer(),
          reviewDraftComposite: productionAgentHarness.reviewDraftComposite,
        },
      );

      if (!pipelineResult.finalVideo.finalVideo) {
        throw new Error("Full pipeline did not store a final video.");
      }

      return { generatedDemoUrl: pipelineResult.finalVideo.finalVideo.r2Url };
    },
  });

  if (result.status !== "idle") {
    await workerLogger.jobProcessed(result);
  }

  if (!runOnce && result.status === "idle") {
    await sleep(pollIntervalMs);
  }
} while (!runOnce);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
