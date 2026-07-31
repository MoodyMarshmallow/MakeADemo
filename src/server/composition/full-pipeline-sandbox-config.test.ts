import { describe, expect, it } from "vitest";

import { readFullPipelineSandboxConfig } from "./full-pipeline-sandbox-config";

describe("full Pipeline sandbox configuration", () => {
  it("requires Daytona credentials", () => {
    expect(
      readFullPipelineSandboxConfig({
        environment: { DAYTONA_API_KEY: "daytona-key" },
      }),
    ).toEqual({ apiKey: "daytona-key" });
  });
});
