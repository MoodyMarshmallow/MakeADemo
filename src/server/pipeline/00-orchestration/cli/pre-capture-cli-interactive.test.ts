import { describe, expect, it } from "vitest";

import { collectPreCaptureCliOptions } from "./pre-capture-cli-interactive";

describe("collectPreCaptureCliOptions", () => {
  it("collects Pre-Capture options through deterministic prompts", async () => {
    const answers = [
      "https://github.com/example/app",
      "validation dashboard, script package",
      "./brief.md, ./setup-notes.txt",
    ];

    const options = await collectPreCaptureCliOptions({
      prompt: async () => answers.shift() ?? "",
      write: () => {},
    });

    expect(options).toEqual({
      docs: ["./brief.md", "./setup-notes.txt"],
      features: ["validation dashboard", "script package"],
      repoUrl: "https://github.com/example/app",
      workspaceId: expect.stringMatching(/^workspace-example-app-\d+$/),
    });
    expect(answers).toEqual([]);
  });

  it("re-prompts with guidance when an answer is invalid", async () => {
    const answers = [
      "not github",
      "https://github.com/example/app",
      "",
      "validation dashboard",
      "",
    ];
    const messages: string[] = [];

    const options = await collectPreCaptureCliOptions({
      prompt: async () => answers.shift() ?? "",
      write: (message) => messages.push(message),
    });

    expect(options.repoUrl).toBe("https://github.com/example/app");
    expect(options.features).toEqual(["validation dashboard"]);
    expect(messages).toContain(
      "Invalid repo URL. Use a GitHub HTTPS URL like https://github.com/owner/repo.",
    );
    expect(messages).toContain(
      "Invalid features. Provide at least one feature, separated by commas.",
    );
  });
});
