import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyCompletedBenchmarkDemo } from "./benchmark-demo-verification";
import type { BenchmarkDemoVerifier } from "./benchmark-demo-verifier.interface";
import { readBenchmarkManifest } from "./benchmark-manifest";

describe("verifyCompletedBenchmarkDemo", () => {
  it("compares final-video evidence with the pinned submitted application", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-completed-benchmark-"),
    );
    const compositeManifestPath = join(
      runDirectory,
      "composite",
      "composite-manifest.json",
    );
    const finalVideoPath = join(runDirectory, "composite", "final-video.mp4");
    const contactSheetPath = join(
      runDirectory,
      "composite",
      "review-evidence",
      "contact-sheet.jpg",
    );
    await mkdir(dirname(contactSheetPath), { recursive: true });
    await Promise.all([
      writeFile(compositeManifestPath, "{}"),
      writeFile(finalVideoPath, "video"),
      writeFile(contactSheetPath, "image"),
    ]);
    const repo = readBenchmarkManifest({
      repos: [
        {
          categories: ["notes"],
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          expectedLevel: "L6",
          features: ["Create and edit a note"],
          id: "notes-app",
          repoUrl: "https://github.com/example/notes-app",
        },
      ],
      version: 1,
    }).repos[0];
    if (repo === undefined) throw new Error("Expected benchmark repo fixture");

    const verifier: BenchmarkDemoVerifier = async (input) => ({
      artifactPath: join(input.outputDirectory, "codex-verdict.json"),
      comparisons: input.evidenceImagePaths.includes(contactSheetPath)
        ? ["Video frame matches the pinned note editor."]
        : [],
      mismatches: [],
      reason:
        input.finalVideoPath === finalVideoPath &&
        input.commitSha === repo.commitSha &&
        input.evidenceImagePaths.includes(contactSheetPath)
          ? "Video depicts the pinned application."
          : "Required comparison evidence was missing.",
      status:
        input.finalVideoPath === finalVideoPath &&
        input.commitSha === repo.commitSha &&
        input.evidenceImagePaths.includes(contactSheetPath)
          ? "verified"
          : "inconclusive",
      verifier: "external-codex",
    });

    await expect(
      verifyCompletedBenchmarkDemo({
        compositeManifestPath,
        finalVideoPath,
        repo,
        runDirectory,
        verifier,
      }),
    ).resolves.toMatchObject({
      reason: "Video depicts the pinned application.",
      status: "verified",
    });
  });
});
