import type { CompositedVideoManifest } from "./composite-video";

type FinalVideoPublicationInput = {
  deadlineAt?: number;
  draftComposite: CompositedVideoManifest;
  onPublicationCommitted?: () => void;
  signal?: AbortSignal;
};

export type FinalVideoPublicationWarning = {
  code:
    | "email-delivery-failed"
    | "email-sent-marker-failed"
    | "local-output-cleanup-failed"
    | "published-manifest-write-failed";
  message: string;
};

type FinalVideoPublicationResult = {
  finalVideo: CompositedVideoManifest;
  warnings: FinalVideoPublicationWarning[];
};

/**
 * Publishes one reviewed Draft Composite as final output.
 * Implementations must publish only the supplied selected checkpoint. The
 * durable Demo Request link is the publication commit point: implementations
 * must report it through `onPublicationCommitted`, reject cancellation before
 * it, and complete post-commit bookkeeping without relabeling publication as a
 * failure. Post-commit bookkeeping failures are returned as warnings.
 */
export interface FinalVideoPublisher {
  publishFinalVideo(
    input: FinalVideoPublicationInput,
  ): Promise<FinalVideoPublicationResult>;
}
