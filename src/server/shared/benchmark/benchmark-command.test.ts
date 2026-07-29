import { describe, expect, it } from "vitest";

import { parseBenchmarkCommandArgs } from "./benchmark-command";

describe("parseBenchmarkCommandArgs", () => {
  it("defaults to Daytona and accepts the sandbox provider anywhere among repo ids", () => {
    expect(
      parseBenchmarkCommandArgs([
        "midday",
        "--sandbox-provider",
        "railway",
        "excalidraw",
      ]),
    ).toEqual({
      repoIds: ["midday", "excalidraw"],
      sandboxProvider: "railway",
    });
    expect(parseBenchmarkCommandArgs(["midday"])).toEqual({
      repoIds: ["midday"],
      sandboxProvider: "daytona",
    });
  });

  it("rejects a missing sandbox provider value before the runner starts", () => {
    expect(() =>
      parseBenchmarkCommandArgs(["midday", "--sandbox-provider"]),
    ).toThrow(
      "Missing value for --sandbox-provider. Expected daytona or railway.",
    );
  });

  it("rejects duplicate sandbox provider flags", () => {
    expect(() =>
      parseBenchmarkCommandArgs([
        "--sandbox-provider",
        "daytona",
        "midday",
        "--sandbox-provider",
        "railway",
      ]),
    ).toThrow("Duplicate --sandbox-provider flag. Specify it at most once.");
  });

  it("rejects unsupported sandbox providers", () => {
    expect(() =>
      parseBenchmarkCommandArgs(["--sandbox-provider", "local", "midday"]),
    ).toThrow(
      'Unsupported sandbox provider "local". Expected daytona or railway.',
    );
  });

  it("rejects a flag-like missing value instead of treating it as a repo id", () => {
    expect(() =>
      parseBenchmarkCommandArgs(["--sandbox-provider", "--", "midday"]),
    ).toThrow(
      "Missing value for --sandbox-provider. Expected daytona or railway.",
    );
  });
});
