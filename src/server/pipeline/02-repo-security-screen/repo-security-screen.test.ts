import { describe, expect, it } from "vitest";

import { screenRepoSecurity } from "./repo-security-screen";

describe("screenRepoSecurity", () => {
  it("rejects repos with obvious static safety failures", () => {
    const result = screenRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { demo: "rm -rf /" } }),
        },
        { path: ".env", text: "API_KEY=secret" },
      ],
      repoStats: { fileCount: 10, sizeBytes: 100_000 },
    });

    expect(result.status).toBe("rejected");
    expect(result.rejections).toContain(
      "package script demo contains a destructive command",
    );
    expect(result.rejections).not.toContain(
      "repo contains committed secret file .env",
    );
  });

  it("allows dotenv files at common paths while still rejecting private keys", () => {
    const result = screenRepoSecurity({
      files: [
        { path: "package.json", text: JSON.stringify({}) },
        { path: ".env", text: "API_KEY=DOTENV_CANARY_ORIGINAL" },
        { path: ".env.test", text: "API_KEY=test" },
        { path: ".env.development", text: "API_KEY=development" },
        { path: ".env.production", text: "API_KEY=production" },
        { path: ".env.test.local.template", text: "API_KEY=template" },
        { path: "apps/web/.env.production", text: "API_KEY=nested" },
        { path: "config/id_ed25519", text: "private-key" },
      ],
      repoStats: { fileCount: 10, sizeBytes: 100_000 },
    });

    expect(result.status).toBe("rejected");
    expect(result.rejections).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("repo contains committed secret file .env"),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("DOTENV_CANARY_ORIGINAL");
    expect(result.rejections).toContain(
      "repo contains committed secret file config/id_ed25519",
    );
  });

  it("warns for large repos and non-fatal preparation risks", () => {
    const result = screenRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: { "@clerk/clerk-react": "latest" },
            scripts: { postinstall: "node setup.js" },
          }),
        },
      ],
      repoStats: { fileCount: 25_000, sizeBytes: 600_000_000 },
    });

    expect(result.status).toBe("passed");
    expect(result.warnings).toContain(
      "repo size or file count may degrade agent exploration quality",
    );
    expect(result.warnings).toContain(
      "repo has no lockfile; dependency installation may be less deterministic",
    );
    expect(result.warnings).toContain(
      "package script postinstall may run setup code during dependency installation",
    );
    expect(result.warnings).toContain(
      "auth package @clerk/clerk-react may require local demo bypass or mocks",
    );
  });
});
