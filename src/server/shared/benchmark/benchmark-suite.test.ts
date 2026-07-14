import { describe, expect, it } from "vitest";

import { benchmarkRepos, buildBenchmarkPipelineArgs } from "./benchmark-suite";

describe("benchmarkRepos", () => {
  it("defines ten pinned whole-pipeline runs with their demo features", () => {
    expect(benchmarkRepos).toHaveLength(10);
    expect(benchmarkRepos.map((repo) => repo.id)).toEqual([
      "cypress-realworld-app",
      "epic-stack",
      "cal-diy",
      "directus",
      "ghostfolio",
      "nuxt-movies",
      "svelte-realworld",
      "astro-paper",
      "twenty",
      "excalidraw",
    ]);
    expect(
      benchmarkRepos.every(
        (repo) =>
          /^[0-9a-f]{40}$/.test(repo.commitSha) && repo.features.length > 0,
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
      "https://github.com/cypress-io/cypress-realworld-app",
      "--commit",
      "bdf6169232b919d9618ec29032addbd865f986cd",
      "--provider",
      "openai",
      "--feature",
      "Sign in with a seeded user and show the account balance and transaction feed",
      "--feature",
      "Pay or request money from another user and show the resulting transaction",
      "--feature",
      "Search or filter the personal transaction history",
    ]);
  });
});
