import { describe, expect, it } from "vitest";

import {
  benchmarkRepos,
  buildBenchmarkPipelineArgs,
  selectBenchmarkRepos,
} from "./benchmark-suite";

describe("benchmarkRepos", () => {
  it("defines ten pinned whole-pipeline runs with their demo features", () => {
    expect(benchmarkRepos).toHaveLength(10);
    expect(benchmarkRepos.map((repo) => repo.id)).toEqual([
      "midday",
      "calcom",
      "directus",
      "mattermost",
      "ghost",
      "ghostfolio",
      "outline",
      "twenty",
      "excalidraw",
      "cyberchef",
    ]);
    expect(
      benchmarkRepos.every(
        (repo) =>
          /^[0-9a-f]{40}$/.test(repo.commitSha) &&
          repo.categories.includes("production") &&
          repo.features.length > 0 &&
          repo.expectedLevel === "L6",
      ),
    ).toBe(true);
  });

  it("builds the whole-pipeline command from the hardcoded repo parameters", () => {
    const repo = benchmarkRepos[0];
    if (repo === undefined) throw new Error("Expected benchmark repo");

    expect(
      buildBenchmarkPipelineArgs({
        outputRoot: ".makeademo-benchmark-runs/run-1",
        repo,
      }),
    ).toEqual([
      "src/server/pipeline/00-orchestration/full-pipeline-cli.mts",
      "--output-root",
      ".makeademo-benchmark-runs/run-1",
      "--repo",
      "https://github.com/midday-ai/midday",
      "--commit",
      "e27b7040efdea2b3d1cca2553a4def7aaf11a053",
      "--provider",
      "openai",
      "--feature",
      "Open the financial overview and explain the cash flow, revenue, and expense metrics",
      "--feature",
      "Browse and filter transactions, then inspect one transaction and its categorization",
      "--feature",
      "Create an invoice for a customer and preview its line items and payment details",
    ]);
  });

  it("selects requested repos in benchmark importance order", () => {
    expect(
      selectBenchmarkRepos({
        repoIds: ["excalidraw", "midday"],
        repos: benchmarkRepos,
      }).map((repo) => repo.id),
    ).toEqual(["midday", "excalidraw"]);
  });

  it("selects the complete suite when no repo ids are requested", () => {
    expect(
      selectBenchmarkRepos({ repoIds: [], repos: benchmarkRepos }),
    ).toEqual(benchmarkRepos);
  });

  it("rejects unknown repo ids before running the benchmark", () => {
    expect(() =>
      selectBenchmarkRepos({
        repoIds: ["midday", "unknown-app"],
        repos: benchmarkRepos,
      }),
    ).toThrowError(
      "Unknown benchmark repo id: unknown-app. Available repo ids: midday, calcom, directus, mattermost, ghost, ghostfolio, outline, twenty, excalidraw, cyberchef",
    );
  });
});
