import { processNextProjectDemoGenerationJob } from "../pipeline/00-orchestration/queue/project-demo-generation-queue";
import { createProjectDemoGenerationWorkerLogger } from "../pipeline/00-orchestration/queue/project-demo-generation-worker-logging";
import { compositeVideoFromScript } from "../pipeline/07-compositing/composite-video";
import { finalVideoEmailsEnabled } from "../pipeline/final-output/final-video-email-feature";
import { createResendFinalVideoEmailNotifierFromEnv } from "../shared/integrations/email/resend-final-video-email-notifier";
import { createR2UploadPresignerFromEnv } from "../shared/integrations/storage/r2-client";
import { R2FinalVideoStorage } from "../shared/integrations/storage/r2-final-video-storage";
import { createNeonDemoRequestFinalVideoStore } from "../shared/persistence/neon-demo-request-final-video-store";
import { createNeonProjectDemoGenerationQueueStore } from "../shared/persistence/neon-project-demo-generation-queue-store";
import { resolveProductionAgentModelConfigFromEnv } from "./production-agent-model-config";
import { createProductionPipeline } from "./production-pipeline";

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
await workerLogger.workerStarted();

do {
  const result = await processNextProjectDemoGenerationJob(queueStore, {
    async runFullPipeline(job) {
      const productionPipeline = createProductionPipeline({
        agentModel,
        logger: workerLogger.child({ component: "agent-harness" }),
        repoSecurityLogger: workerLogger.child({
          component: "repo-security-screen",
        }),
        sandbox: {
          apiKey: daytonaApiKey,
          provider: "daytona",
          ...(daytonaSnapshot === undefined
            ? {}
            : { snapshot: daytonaSnapshot }),
          ...(daytonaSubmittedCodeSnapshot === undefined
            ? {}
            : { submittedCodeSnapshot: daytonaSubmittedCodeSnapshot }),
        },
      });
      try {
        const pipelineResult = await productionPipeline.run({
          demoBrief: job.demoBrief,
          normalizedSupportingDocuments: job.normalizedSupportingDocuments,
          repoUrl: job.repoUrl,
          workspaceId: job.workspaceId,
          runOptions: {
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
          },
        });

        if (!pipelineResult.finalVideo.finalVideo) {
          throw new Error("Full pipeline did not store a final video.");
        }

        return {
          generatedDemoUrl: pipelineResult.finalVideo.finalVideo.r2Url,
        };
      } finally {
        await productionPipeline.dispose();
      }
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
