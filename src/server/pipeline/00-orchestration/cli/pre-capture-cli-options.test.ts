import { describe, expect, it } from "vitest";

import { parsePreCaptureCliArgs } from "./pre-capture-cli-options";

describe("parsePreCaptureCliArgs", () => {
  it("rejects abbreviated commit SHAs", () => {
    expect(() =>
      parsePreCaptureCliArgs([
        "--repo",
        "https://github.com/example/app",
        "--commit",
        "abc123",
        "--feature",
        "validation dashboard",
      ]),
    ).toThrowError("--commit must be a full 40-character Git SHA");
  });

  it("rejects the legacy local workspace root option", () => {
    expect(() =>
      parsePreCaptureCliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
        "--workspace-root",
        "/tmp/makeademo-workspaces",
      ]),
    ).toThrowError("Unknown option: --workspace-root");
  });

  it("rejects the legacy Repo Preparation runtime selector", () => {
    expect(() =>
      parsePreCaptureCliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
        "--repo-preparation-runtime",
        "docker",
      ]),
    ).toThrowError("Unknown option: --repo-preparation-runtime");
  });

  it("rejects Daytona snapshot flags because snapshots come from environment variables", () => {
    expect(() =>
      parsePreCaptureCliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
        "--daytona-snapshot",
        "makeademo-agent-snapshot",
      ]),
    ).toThrowError("Unknown option: --daytona-snapshot");

    expect(() =>
      parsePreCaptureCliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
        "--daytona-submitted-code-snapshot",
        "makeademo-submitted-code-browser",
      ]),
    ).toThrowError("Unknown option: --daytona-submitted-code-snapshot");
  });

  it("requires a repo and at least one feature", () => {
    expect(() => parsePreCaptureCliArgs([])).toThrowError("--repo is required");

    expect(() =>
      parsePreCaptureCliArgs(["--repo", "https://github.com/example/app"]),
    ).toThrowError("at least one --feature is required");
  });
});
