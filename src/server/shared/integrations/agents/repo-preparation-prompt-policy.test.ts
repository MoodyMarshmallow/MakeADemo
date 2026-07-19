import { describe, expect, it } from "vitest";

import { createValidationFeedbackPrompt } from "./repo-preparation-prompt-policy";

describe("createValidationFeedbackPrompt", () => {
  it("projects bounded redacted validation evidence without inline screenshot bytes", () => {
    const prompt = createValidationFeedbackPrompt({
      manifest: undefined,
      manifestPath: "/workspace/.makeademo/preparation-manifest.json",
      remainingBudgetMs: 60_000,
      validation: {
        blockedNetworkAttempts: [
          {
            direction: "outbound",
            host: "api.example.test",
            phase: "runtime",
            url: "https://api.example.test/?token=%5Bredacted%5D",
          },
        ],
        evidence: {
          browser: { text: `Vite error token=secret\n${"x".repeat(40_000)}` },
        },
        failureKind: "browser-not-interactable",
        failureReason: "token=secret",
        localUrl: "http://localhost:3000",
        logs: ["screenshot:very-secret-base64", "token=secret"],
        previewUrl: "https://preview.example.test",
        screenshot: {
          mimeType: "image/png",
          path: "/workspace/.makeademo/validation-screenshot.png",
          sizeBytes: 12,
        },
        status: "failed",
        warnings: ["warn"],
      },
    });

    expect(prompt.length).toBeLessThanOrEqual(32 * 1024);
    expect(prompt).toContain("browser-not-interactable");
    expect(prompt).toContain("http://localhost:3000");
    expect(prompt).toContain("validation-screenshot.png");
    expect(prompt).not.toContain("very-secret-base64");
    expect(prompt).not.toContain("token=secret");
  });

  it("keeps the verdict and repair action when logs contain screenshots and exceed the prompt budget", () => {
    const prompt = createValidationFeedbackPrompt({
      manifest: undefined,
      manifestPath: "/workspace/manifest.json",
      remainingBudgetMs: 30_000,
      validation: {
        blockedNetworkAttempts: [],
        failureKind: "browser-not-interactable",
        failureReason: "Vite runtime error",
        logs: [
          `screenshot:${"A".repeat(20_000)}`,
          ...Array.from(
            { length: 10 },
            (_, index) => `log-${index}:${"x".repeat(8_000)}`,
          ),
        ],
        status: "failed",
        warnings: [],
      },
    });

    expect(prompt.length).toBeLessThanOrEqual(32 * 1024);
    expect(prompt).toContain("browser-not-interactable");
    expect(prompt).toContain("Vite runtime error");
    expect(prompt).toContain("makeademo_validate_preparation");
    expect(prompt).not.toContain("screenshot:");
    expect(prompt).not.toContain("A".repeat(100));
  });

  it("serializes a parseable redacted repair projection", () => {
    const prompt = createValidationFeedbackPrompt({
      manifest: undefined,
      manifestPath: "/workspace/manifest.json",
      remainingBudgetMs: 30_000,
      validation: {
        blockedNetworkAttempts: [
          {
            direction: "outbound",
            host: "api.example.test",
            phase: "runtime",
            url: "https://user:secret@api.example.test/path?token=hidden",
          },
        ],
        failureKind: "runtime-network-blocked",
        failureReason: '{"token":"secret"}',
        logs: ['{"authorization":"Bearer abc.def.ghi"}'],
        status: "failed",
        warnings: ["password=secret"],
      },
    });
    const match =
      /## Preparation Preflight Result\n```json\n([\s\S]*?)\n```/.exec(prompt);

    expect(match?.[1]).toBeDefined();
    expect(JSON.parse(match?.[1] ?? "{}")).toMatchObject({
      failureKind: "runtime-network-blocked",
    });
    expect(prompt).not.toContain("secret");
    expect(prompt).not.toContain("hidden");
    expect(prompt).not.toContain("abc.def.ghi");
  });

  it("bounds every repair section while retaining the verdict and guidance", () => {
    const prompt = createValidationFeedbackPrompt({
      manifest: { setupSummary: "x".repeat(80_000) } as never,
      manifestPath: "/workspace/manifest.json",
      remainingBudgetMs: 30_000,
      validation: {
        blockedNetworkAttempts: Array.from({ length: 1_000 }, () => ({
          direction: "outbound" as const,
          host: "api.example.test",
          phase: "runtime" as const,
          url: "https://user:secret@api.example.test/?token=hidden",
        })),
        evidence: {
          browser: { text: "browser ".repeat(20_000) },
          serverLog: { text: "server ".repeat(20_000) },
        },
        failureKind: "browser-not-interactable",
        failureReason: "Vite failed",
        logs: ["log ".repeat(20_000)],
        status: "failed",
        warnings: Array.from({ length: 1_000 }, () => "warning ".repeat(100)),
      },
    });
    const match =
      /## Preparation Preflight Result\n```json\n([\s\S]*?)\n```/.exec(prompt);

    expect(prompt.length).toBeLessThanOrEqual(32 * 1024);
    expect(JSON.parse(match?.[1] ?? "{}")).toMatchObject({
      failureKind: "browser-not-interactable",
      failureReason: "Vite failed",
    });
    expect(prompt).toContain("makeademo_validate_preparation");
  });
});
