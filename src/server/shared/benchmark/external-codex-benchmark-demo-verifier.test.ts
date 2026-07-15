import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyBenchmarkDemoWithCodex } from "./external-codex-benchmark-demo-verifier";

describe("verifyBenchmarkDemoWithCodex", () => {
  it("records an independent Codex verdict that the video depicts the submitted application", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-benchmark-verification-"),
    );

    const result = await verifyBenchmarkDemoWithCodex(
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        evidenceImagePaths: [join(outputDirectory, "contact-sheet.jpg")],
        features: ["Create and edit a note"],
        finalVideoPath: join(outputDirectory, "final-video.mp4"),
        outputDirectory: relative(process.cwd(), outputDirectory),
        repoId: "notes-app",
        repoUrl: "https://github.com/example/notes-app",
      },
      {
        async runCodex({ verdictPath }) {
          await writeFile(
            verdictPath,
            JSON.stringify({
              coherenceVerdict: "coherent",
              comparisons: ["The note editor matches the source UI."],
              mismatches: [],
              overlayRelevanceFindings: [],
              reason: "The recorded interface and flow match the pinned app.",
              verdict: "verified",
              visualArtifactFindings: [],
            }),
          );
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result).toMatchObject({
      reason: "The recorded interface and flow match the pinned app.",
      status: "verified",
      verifier: "external-codex",
    });
    expect(isAbsolute(result.artifactPath)).toBe(true);
    await expect(readFile(result.artifactPath, "utf8")).resolves.toContain(
      '"verdict": "verified"',
    );
  });

  it("does not verify an application-matching video with broken visuals or irrelevant overlays", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-benchmark-verification-"),
    );

    await expect(
      verifyBenchmarkDemoWithCodex(
        {
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          evidenceImagePaths: [join(outputDirectory, "contact-sheet.jpg")],
          features: ["Show the dashboard"],
          finalVideoPath: join(outputDirectory, "final-video.mp4"),
          outputDirectory,
          repoId: "dashboard-app",
          repoUrl: "https://github.com/example/dashboard-app",
        },
        {
          async runCodex({ verdictPath }) {
            await writeFile(
              verdictPath,
              JSON.stringify({
                coherenceVerdict: "incoherent",
                comparisons: ["The dashboard matches the pinned app."],
                mismatches: [],
                overlayRelevanceFindings: [
                  "The billing overlay appears over unrelated settings footage.",
                ],
                reason:
                  "The application matches, but the video is not coherent.",
                verdict: "verified",
                visualArtifactFindings: [
                  "A large black frame interrupts the feature demonstration.",
                ],
              }),
            );
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      ),
    ).resolves.toMatchObject({
      mismatches: [
        "A large black frame interrupts the feature demonstration.",
        "The billing overlay appears over unrelated settings footage.",
      ],
      status: "rejected",
    });
  });

  it("records evaluator failures without awarding external verification", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-benchmark-verification-"),
    );

    await expect(
      verifyBenchmarkDemoWithCodex(
        {
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          evidenceImagePaths: [],
          features: ["Show the app"],
          finalVideoPath: join(outputDirectory, "final-video.mp4"),
          outputDirectory,
          repoId: "app",
          repoUrl: "https://github.com/example/app",
        },
        {
          async runCodex() {
            throw new Error("Codex process timed out");
          },
        },
      ),
    ).resolves.toMatchObject({
      reason: "Codex process timed out",
      status: "error",
      verifier: "external-codex",
    });
  });

  it("does not reuse a verdict artifact from an earlier evaluator run", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-benchmark-verification-"),
    );
    await writeFile(
      join(outputDirectory, "codex-verdict.json"),
      JSON.stringify({
        coherenceVerdict: "coherent",
        comparisons: ["stale"],
        mismatches: [],
        overlayRelevanceFindings: [],
        reason: "Stale verified result.",
        verdict: "verified",
        visualArtifactFindings: [],
      }),
    );

    await expect(
      verifyBenchmarkDemoWithCodex(
        {
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          evidenceImagePaths: [],
          features: ["Show the app"],
          finalVideoPath: join(outputDirectory, "final-video.mp4"),
          outputDirectory,
          repoId: "app",
          repoUrl: "https://github.com/example/app",
        },
        {
          async runCodex() {
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      ),
    ).resolves.toMatchObject({
      status: "error",
    });
  });
});
