import { describe, expect, it } from "vitest";

import { parseBenchmarkCommandArgs } from "./benchmark-command";

describe("parseBenchmarkCommandArgs", () => {
  it("accepts repository ids", () => {
    expect(parseBenchmarkCommandArgs(["midday"])).toEqual({
      repoIds: ["midday"],
    });
  });

  it("selects the executable Prepared Application Identity evaluation mode", () => {
    expect(
      parseBenchmarkCommandArgs(["--identity-evaluation", "midday"]),
    ).toEqual({
      identityEvaluation: true,
      repoIds: ["midday"],
    });
  });

  it("parses a positive integer concurrency limit before the runner starts", () => {
    expect(
      parseBenchmarkCommandArgs(["midday", "--concurrency", "5", "excalidraw"]),
    ).toMatchObject({
      concurrency: 5,
      repoIds: ["midday", "excalidraw"],
    });
  });

  it.each([
    {
      args: ["--concurrency"],
      message: "Missing value for --concurrency. Expected a positive integer.",
    },
    {
      args: ["--concurrency", "2.5"],
      message:
        'Invalid --concurrency value "2.5". Expected a positive integer.',
    },
    {
      args: ["--concurrency", "0"],
      message: 'Invalid --concurrency value "0". Expected a positive integer.',
    },
    {
      args: ["--concurrency", "9007199254740992"],
      message:
        'Invalid --concurrency value "9007199254740992". Expected a positive integer.',
    },
    {
      args: ["--concurrency", "--", "midday"],
      message: "Missing value for --concurrency. Expected a positive integer.",
    },
  ])("rejects $args", ({ args, message }) => {
    expect(() => parseBenchmarkCommandArgs(args)).toThrow(message);
  });

  it("rejects duplicate concurrency flags", () => {
    expect(() =>
      parseBenchmarkCommandArgs([
        "--concurrency",
        "2",
        "midday",
        "--concurrency",
        "5",
      ]),
    ).toThrow("Duplicate --concurrency flag. Specify it at most once.");
  });
});
