import { describe, expect, it } from "vitest";

import { readFullPipelineSandboxConfig } from "./full-pipeline-sandbox-config";

describe("full Pipeline sandbox configuration", () => {
  it("treats explicit Railway selection as the opt-in without requiring Daytona", () => {
    expect(
      readFullPipelineSandboxConfig({
        environment: {
          MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID: "environment_dedicated",
          MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: "project-dedicated",
        },
        provider: "railway",
      }),
    ).toEqual({
      environmentId: "environment_dedicated",
      projectToken: "project-dedicated",
      provider: "railway",
    });
  });

  it("uses only dedicated Railway sandbox credentials", () => {
    expect(
      readFullPipelineSandboxConfig({
        environment: {
          MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID: "environment_dedicated",
          MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: "project-dedicated",
          RAILWAY_ENVIRONMENT_ID: "environment-ambient",
          RAILWAY_TOKEN: "token-ambient",
        },
        provider: "railway",
      }),
    ).toEqual({
      environmentId: "environment_dedicated",
      projectToken: "project-dedicated",
      provider: "railway",
    });
  });

  it("requires each dedicated Railway credential without requiring Daytona", () => {
    expect(() =>
      readFullPipelineSandboxConfig({
        environment: {
          MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID: "environment_dedicated",
        },
        provider: "railway",
      }),
    ).toThrow("MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN");
  });

  it("keeps Daytona as the default provider", () => {
    expect(
      readFullPipelineSandboxConfig({
        environment: { DAYTONA_API_KEY: "daytona-key" },
        provider: "daytona",
      }),
    ).toEqual({ apiKey: "daytona-key", provider: "daytona" });
  });
});
