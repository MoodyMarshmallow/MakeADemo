import { describe, expect, it } from "vitest";

import { readRailwayPocConfiguration } from "./railway-sandbox-poc-safety";

describe("Railway Sandbox POC safety gate", () => {
  it("fails when live execution is enabled without both dedicated inputs", () => {
    expect(() =>
      readRailwayPocConfiguration({ RUN_RAILWAY_SANDBOX_POC: "1" }),
    ).toThrow(
      "RUN_RAILWAY_SANDBOX_POC=1 requires MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN and MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID.",
    );
  });

  it("does not require Railway credentials when the POC is not opted in", () => {
    expect(readRailwayPocConfiguration({})).toBeUndefined();
  });

  it("returns only the explicitly supplied dedicated inputs", () => {
    expect(
      readRailwayPocConfiguration({
        RUN_RAILWAY_SANDBOX_POC: "1",
        MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN: " project-token ",
        MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID: " environment-id ",
        RAILWAY_API_TOKEN: "ambient-token",
      }),
    ).toEqual({
      projectToken: "project-token",
      environmentId: "environment-id",
    });
  });
});
