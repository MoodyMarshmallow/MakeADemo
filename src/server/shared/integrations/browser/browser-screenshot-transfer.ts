import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";

const browserScreenshotMaximumSizeBytes = 10 * 1024 * 1024;
const browserScreenshotPngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export type BrowserScreenshotTransferFailure =
  | "download"
  | "invalid"
  | "upload";

/** Raised when browser proof cannot cross the submitted-code workspace seam. */
export class BrowserScreenshotTransferError extends Error {
  constructor(readonly failure: BrowserScreenshotTransferFailure) {
    super(
      failure === "download"
        ? "Browser screenshot download from submitted-code sandbox failed."
        : failure === "invalid"
          ? "Browser screenshot from submitted-code sandbox is invalid."
          : "Browser screenshot upload to the repair workspace failed.",
    );
    this.name = "BrowserScreenshotTransferError";
  }
}

/**
 * Copies bounded PNG proof from the submitted-code sandbox into the
 * agent-readable parent workspace. The workspace methods are invoked through
 * their receiver because provider adapters retain state on `this`.
 */
export async function transferBrowserScreenshot(input: {
  destinationPath: string;
  signal?: AbortSignal;
  sourcePath: string;
  timeoutMs?: number;
  workspace: PreparationWorkspace;
}): Promise<{ sha256: string; sizeBytes: number }> {
  if (input.workspace.downloadSubmittedCodeFiles === undefined) {
    throw new BrowserScreenshotTransferError("download");
  }
  let directory: string | undefined;
  try {
    try {
      directory = await mkdtemp(join(tmpdir(), "makeademo-browser-"));
    } catch {
      throw new BrowserScreenshotTransferError("download");
    }
    const localPath = join(directory, "browser.png");
    try {
      await input.workspace.downloadSubmittedCodeFiles(
        [{ destinationPath: localPath, sourcePath: input.sourcePath }],
        {
          maxBytes: browserScreenshotMaximumSizeBytes,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        },
      );
    } catch {
      throw new BrowserScreenshotTransferError("download");
    }
    let sizeBytes: number;
    let bytes: Buffer;
    try {
      sizeBytes = (await stat(localPath)).size;
      bytes = await readFile(localPath);
    } catch {
      throw new BrowserScreenshotTransferError("download");
    }
    if (
      sizeBytes < browserScreenshotPngSignature.length ||
      sizeBytes > browserScreenshotMaximumSizeBytes ||
      bytes.length !== sizeBytes ||
      !bytes
        .subarray(0, browserScreenshotPngSignature.length)
        .equals(browserScreenshotPngSignature)
    ) {
      throw new BrowserScreenshotTransferError("invalid");
    }
    try {
      await input.workspace.uploadFiles(
        [{ destinationPath: input.destinationPath, sourcePath: localPath }],
        {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        },
      );
    } catch (error) {
      throw new BrowserScreenshotTransferError("upload");
    }
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes,
    };
  } finally {
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true }).catch(() => {});
    }
  }
}
