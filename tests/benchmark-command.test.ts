import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("benchmark package command", () => {
  it("runs the hardcoded benchmark suite without command-line arguments", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.benchmark).toBe(
      "bun scripts/run-benchmark.mts",
    );
  });
});
