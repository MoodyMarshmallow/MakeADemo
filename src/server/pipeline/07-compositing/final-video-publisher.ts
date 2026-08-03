import { readFile, unlink, writeFile } from "node:fs/promises";

import { throwIfPipelineDeadlineReached } from "../00-orchestration/job/pipeline-cancellation";
import type { FinalVideoEmailNotifier } from "../final-output/final-video-email-notifier.interface";
import type { CompositedVideoManifest } from "./composite-video";
import type {
  FinalVideoPublicationWarning,
  FinalVideoPublisher,
} from "./final-video-publisher.interface";
import type {
  DemoRequestFinalVideoStore,
  FinalVideoStorage,
} from "./final-video-storage.interface";

export type FinalVideoPublisherOptions = {
  demoRequestId: string;
  demoRequestStore: DemoRequestFinalVideoStore;
  finalVideoEmailNotifier?: FinalVideoEmailNotifier;
  finalVideoStorage: FinalVideoStorage;
  publicAppBaseUrl?: string;
  retainLocalOutput?: boolean;
};

/** Creates the final-output publisher used after Draft Composite review. */
export function createFinalVideoPublisher(
  options: FinalVideoPublisherOptions,
): FinalVideoPublisher {
  if (options.finalVideoEmailNotifier && !options.publicAppBaseUrl) {
    throw new Error(
      "publicAppBaseUrl is required to email final Compositing output",
    );
  }
  let emailDeliveryAccepted = false;

  return {
    async publishFinalVideo({
      deadlineAt,
      draftComposite,
      onPublicationCommitted,
      signal,
    }) {
      throwIfPipelineDeadlineReached(signal, deadlineAt);
      const outputVideoPath = draftComposite.outputVideoPath;
      if (outputVideoPath === undefined) {
        throw new Error(
          "Final publication requires a retained local Draft Composite",
        );
      }

      const finalVideo = await options.finalVideoStorage.storeFinalVideo({
        body: await readFile(outputVideoPath),
        contentType: "video/mp4",
        demoRequestId: options.demoRequestId,
        fileName: "final-video.mp4",
        scriptId: draftComposite.scriptId,
      });
      throwIfPipelineDeadlineReached(signal, deadlineAt);
      const linkedDemoRequest = await options.demoRequestStore.linkFinalVideo({
        demoRequestId: options.demoRequestId,
        generatedDemoUrl: finalVideo.r2Url,
      });
      onPublicationCommitted?.();
      const warnings: FinalVideoPublicationWarning[] = [];

      if (
        options.finalVideoEmailNotifier &&
        options.publicAppBaseUrl &&
        !linkedDemoRequest.finalVideoEmailSentAt
      ) {
        if (!emailDeliveryAccepted) {
          try {
            await options.finalVideoEmailNotifier.sendFinalVideoReadyEmail({
              demoRequestId: options.demoRequestId,
              title: draftComposite.title,
              to: linkedDemoRequest.makerEmail,
              videoUrl: createFinalVideoAppUrl({
                demoRequestId: options.demoRequestId,
                publicAppBaseUrl: options.publicAppBaseUrl,
              }),
            });
            emailDeliveryAccepted = true;
          } catch (error) {
            warnings.push({
              code: "email-delivery-failed",
              message: readErrorMessage(error),
            });
          }
        }
        if (emailDeliveryAccepted) {
          try {
            await options.demoRequestStore.markFinalVideoEmailSent({
              demoRequestId: options.demoRequestId,
              sentAt: new Date().toISOString(),
            });
          } catch (error) {
            warnings.push({
              code: "email-sent-marker-failed",
              message: readErrorMessage(error),
            });
          }
        }
      }

      const published = createPublishedManifest({
        draftComposite,
        finalVideo,
        retainLocalOutput: options.retainLocalOutput ?? false,
      });
      try {
        await writeFile(
          published.manifestPath,
          `${JSON.stringify(published, null, 2)}\n`,
        );
      } catch (error) {
        warnings.push({
          code: "published-manifest-write-failed",
          message: readErrorMessage(error),
        });
      }
      if (!options.retainLocalOutput) {
        try {
          await unlink(outputVideoPath);
        } catch (error) {
          warnings.push({
            code: "local-output-cleanup-failed",
            message: readErrorMessage(error),
          });
        }
      }
      return { finalVideo: published, warnings };
    },
  };
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createPublishedManifest(input: {
  draftComposite: CompositedVideoManifest;
  finalVideo: NonNullable<CompositedVideoManifest["finalVideo"]>;
  retainLocalOutput: boolean;
}): CompositedVideoManifest {
  const { outputVideoPath, ...manifestWithoutLocalOutput } =
    input.draftComposite;
  return {
    ...(input.retainLocalOutput
      ? input.draftComposite
      : manifestWithoutLocalOutput),
    finalVideo: input.finalVideo,
    viewUrl: input.finalVideo.r2Url,
  };
}

function createFinalVideoAppUrl(input: {
  demoRequestId: string;
  publicAppBaseUrl: string;
}) {
  const baseUrl = input.publicAppBaseUrl.replace(/\/+$/g, "");
  return `${baseUrl}/api/demo-requests/${encodeURIComponent(
    input.demoRequestId,
  )}/video`;
}
