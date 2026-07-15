import { describe, expect, it } from "vitest";

import {
  buildBenchmarkPipelineArgs,
  readBenchmarkManifest,
} from "./benchmark-manifest";

describe("readBenchmarkManifest", () => {
  it("reads benchmark defaults and repo entries with repo-specific overrides", () => {
    const manifest = readBenchmarkManifest({
      defaults: {
        provider: "openai",
        repetitions: 2,
      },
      repos: [
        {
          categories: ["realworld", "frontend"],
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          expectedLevel: "L2",
          features: ["Show the article feed"],
          id: "conduit",
          repoUrl: "https://github.com/TonyMckes/conduit-realworld-example-app",
        },
      ],
      version: 1,
    });

    expect(manifest.repos[0]).toMatchObject({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      effectiveProvider: "openai",
      effectiveRepetitions: 2,
      id: "conduit",
    });
  });

  it("rejects pipeline modes because every benchmark runs the whole pipeline", () => {
    expect(() =>
      readBenchmarkManifest({
        defaults: { mode: "partial" },
        repos: [],
        version: 1,
      }),
    ).toThrow("defaults.mode is not supported");
  });

  it("requires an immutable commit SHA for every benchmark repository", () => {
    expect(() =>
      readBenchmarkManifest({
        repos: [
          {
            categories: ["frontend"],
            expectedLevel: "L5",
            features: ["Show the app"],
            id: "floating-repo",
            repoUrl: "https://github.com/example/app",
          },
        ],
        version: 1,
      }),
    ).toThrow("repos[0].commitSha must be a full 40-character Git SHA");
  });

  it("rejects duplicate repo ids because results use ids as stable keys", () => {
    expect(() =>
      readBenchmarkManifest({
        repos: [
          {
            categories: [],
            commitSha: "0123456789abcdef0123456789abcdef01234567",
            expectedLevel: "L1",
            features: ["Show the app"],
            id: "same",
            repoUrl: "https://github.com/example/one",
          },
          {
            categories: [],
            commitSha: "89abcdef0123456789abcdef0123456789abcdef",
            expectedLevel: "L1",
            features: ["Show the app"],
            id: "same",
            repoUrl: "https://github.com/example/two",
          },
        ],
        version: 1,
      }),
    ).toThrow("Duplicate benchmark repo id: same");
  });

  it("accepts L6 as independently verified demo output", () => {
    const manifest = readBenchmarkManifest({
      repos: [
        {
          categories: [],
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          expectedLevel: "L6",
          features: ["Show the app"],
          id: "externally-verified",
          repoUrl: "https://github.com/example/app",
        },
      ],
      version: 1,
    });

    expect(manifest.repos[0]?.expectedLevel).toBe("L6");
  });

  it("rejects unknown benchmark levels", () => {
    expect(() =>
      readBenchmarkManifest({
        repos: [
          {
            categories: [],
            commitSha: "0123456789abcdef0123456789abcdef01234567",
            expectedLevel: "quality",
            features: ["Show the app"],
            id: "quality-scored",
            repoUrl: "https://github.com/example/app",
          },
        ],
        version: 1,
      }),
    ).toThrow(
      "repos[0].expectedLevel must be one of L0, L1, L2, L3, L4, L5, or L6",
    );
  });
});

describe("buildBenchmarkPipelineArgs", () => {
  it("builds full-pipeline CLI args from a repo benchmark entry", () => {
    const manifest = readBenchmarkManifest({
      defaults: { provider: "openai" },
      repos: [
        {
          categories: ["fullstack"],
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          daytonaSnapshot: "snapshot-id",
          docs: ["docs/setup.md"],
          expectedLevel: "L5",
          features: ["Show scheduling"],
          id: "calendar",
          repoUrl: "https://github.com/example/calendar",
          workspaceId: "workspace-calendar",
        },
      ],
      version: 1,
    });
    const repo = manifest.repos.at(0);
    if (repo === undefined) {
      throw new Error("Expected benchmark repo fixture");
    }

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
      "https://github.com/example/calendar",
      "--commit",
      "0123456789abcdef0123456789abcdef01234567",
      "--provider",
      "openai",
      "--feature",
      "Show scheduling",
      "--doc",
      "docs/setup.md",
    ]);
  });
});
