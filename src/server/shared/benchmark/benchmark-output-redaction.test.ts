import { describe, expect, it } from "vitest";

import { redactBenchmarkOutput } from "./benchmark-output-redaction";

describe("redactBenchmarkOutput", () => {
  it("removes authorization values and standalone bearer credentials", () => {
    const output = [
      '{"headers":{"Authorization":"Bearer daytona-secret"}}',
      "request failed with Bearer fallback-secret",
      "ordinary pipeline output",
    ].join("\n");

    const redacted = redactBenchmarkOutput(output);

    expect(redacted).toContain('"Authorization":"[REDACTED]"');
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("ordinary pipeline output");
    expect(redacted).not.toContain("daytona-secret");
    expect(redacted).not.toContain("fallback-secret");
  });
});
