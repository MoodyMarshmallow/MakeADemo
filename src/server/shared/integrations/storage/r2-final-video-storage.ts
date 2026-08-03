import type {
  FinalVideoStorage,
  FinalVideoUploadInput,
  StoredFinalVideo,
} from "../../../pipeline/07-compositing/final-video-storage.interface";
import type { R2UploadStorage } from "./r2-upload-presigner";

export class R2FinalVideoStorage implements FinalVideoStorage {
  private readonly r2: R2UploadStorage;

  constructor(r2: R2UploadStorage) {
    this.r2 = r2;
  }

  async storeFinalVideo(
    input: FinalVideoUploadInput,
  ): Promise<StoredFinalVideo> {
    const key = createFinalVideoKey(input);

    await this.r2.putObject({
      body: input.body,
      bucket: this.r2.bucket,
      contentType: input.contentType,
      key,
    });

    return {
      key,
      r2Url: `r2://${this.r2.bucket}/${key}`,
    };
  }
}

function createFinalVideoKey(input: FinalVideoUploadInput) {
  return `demo-videos/${safePathSegment(input.demoRequestId)}/${input.fileName}`;
}

function safePathSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
}
