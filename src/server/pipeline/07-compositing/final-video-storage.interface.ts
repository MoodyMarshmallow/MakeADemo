export type FinalVideoUploadInput = {
  body: Uint8Array;
  contentType: "video/mp4";
  demoRequestId: string;
  fileName: "final-video.mp4";
  scriptId: string;
};

export type StoredFinalVideo = {
  key: string;
  r2Url: string;
};

/**
 * Stores the final Compositing video in durable video storage.
 * Implementations must idempotently replace bytes under one stable Demo
 * Request-scoped key and return its canonical private URL.
 */
export interface FinalVideoStorage {
  storeFinalVideo(input: FinalVideoUploadInput): Promise<StoredFinalVideo>;
}

export type LinkFinalVideoInput = {
  demoRequestId: string;
  generatedDemoUrl: string;
};

export type LinkedFinalVideoDemoRequest = {
  finalVideoEmailSentAt: string | null;
  makerEmail: string;
};

export type MarkFinalVideoEmailSentInput = {
  demoRequestId: string;
  sentAt: string;
};

/**
 * Links a generated final video to its Demo Request in durable persistence.
 * Implementations must update only the identified Demo Request, return the
 * maker email for final-output notification, and must not create a new request
 * when the id is missing.
 */
export interface DemoRequestFinalVideoStore {
  linkFinalVideo(
    input: LinkFinalVideoInput,
  ): Promise<LinkedFinalVideoDemoRequest>;
  markFinalVideoEmailSent(input: MarkFinalVideoEmailSentInput): Promise<void>;
}
