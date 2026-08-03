import { describe, expect, it } from "vitest";

import { createPiResourceLoader } from "./pi-resource-loader";

describe("createPiResourceLoader", () => {
  it("uses explicit harness policy without discovering repository resources", async () => {
    const loader = await createPiResourceLoader({
      agentDir: "/tmp/makeademo/pi-resource-test",
      cwd: "/workspace",
    });

    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    expect(loader.getExtensions().extensions[0]?.path).toContain(
      "@upstash/context7-pi",
    );
    expect(loader.getSkills().skills).toEqual([]);
  });

  it("fails closed instead of allowing ambient authenticated Context7", async () => {
    const original = process.env.CONTEXT7_API_KEY;
    process.env.CONTEXT7_API_KEY = "must-not-be-used";
    try {
      await expect(
        createPiResourceLoader({
          agentDir: "/tmp/makeademo/pi-resource-test",
          cwd: "/workspace",
        }),
      ).rejects.toThrow("must be unset");
    } finally {
      if (original === undefined) process.env.CONTEXT7_API_KEY = undefined;
      else process.env.CONTEXT7_API_KEY = original;
    }
  });
});
