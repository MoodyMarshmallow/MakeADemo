import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  BenchmarkDemoVerification,
  BenchmarkDemoVerifier,
} from "./benchmark-demo-verifier.interface";
import type { BenchmarkRepo } from "./benchmark-manifest";

export type VerifyCompletedBenchmarkDemoInput = {
  compositeManifestPath: string;
  finalVideoPath: string;
  repo: BenchmarkRepo;
  runDirectory: string;
  verifier: BenchmarkDemoVerifier;
};

export async function verifyCompletedBenchmarkDemo(
  input: VerifyCompletedBenchmarkDemoInput,
): Promise<BenchmarkDemoVerification> {
  const reviewEvidenceDirectory = join(
    dirname(input.compositeManifestPath),
    "review-evidence",
  );
  const evidenceImagePaths = await readEvidenceImagePaths(
    reviewEvidenceDirectory,
  );

  return input.verifier({
    commitSha: input.repo.commitSha,
    evidenceImagePaths,
    features: input.repo.features,
    finalVideoPath: input.finalVideoPath,
    outputDirectory: join(input.runDirectory, "external-verification"),
    repoId: input.repo.id,
    repoUrl: input.repo.repoUrl,
  });
}

async function readEvidenceImagePaths(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => /\.(?:jpe?g|png|webp)$/i.test(name))
      .sort()
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}
