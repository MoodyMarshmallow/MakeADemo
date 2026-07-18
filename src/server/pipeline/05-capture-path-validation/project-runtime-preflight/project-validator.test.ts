import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import { SubmittedCodeWorkspaceSyncError } from "../../03-repo-preparation/submitted-code-execution";
import type { BrowserValidator } from "./browser-validator.interface";
import { validateProject } from "./project-validator";
import type { SandboxRunner } from "./sandbox-runner.interface";

describe("validateProject", () => {
  it("returns validation artifacts when the prepared repo satisfies the Demo Run Contract", async () => {
    const browserUrls: string[] = [];
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          browserUrl: "https://preview.example.test",
          blockedNetworkAttempts: [],
          logs: ["installed", "started demo"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate(input) {
        browserUrls.push(input.url);
        return {
          interactable: true,
          logs: ["loaded app"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://127.0.0.1:3000",
        }),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toEqual({
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test",
      logs: ["installed", "started demo", "loaded app"],
      screenshotArtifactId: "artifact_screenshot",
      status: "succeeded",
      warnings: [],
    });
    expect(browserUrls).toEqual(["https://preview.example.test"]);
  });

  it("writes browser validation progress to sandbox logs", async () => {
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          browserUrl: "https://preview.example.test",
          blockedNetworkAttempts: [],
          logs: ["installed", "started demo"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return {
          interactable: true,
          logs: ["loaded app"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://127.0.0.1:3000",
        }),
        preparationWorkspace: workspaceHandle(sandboxLogs),
      },
      { browserValidator, sandboxRunner },
    );

    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          browserUrl: "https://preview.example.test",
          event: "project-validation.browser-validation.started",
          stage: "project-validation",
          workspaceId: "workspace_123",
        }),
        expect.objectContaining({
          browserUrl: "https://preview.example.test",
          event: "project-validation.browser-validation.succeeded",
          screenshotArtifactId: "artifact_screenshot",
          stage: "project-validation",
          workspaceId: "workspace_123",
        }),
      ]),
    );
  });

  it("does not block Project Validation when workspace log writes hang", async () => {
    const browserUrls: string[] = [];
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          browserUrl: "https://preview.example.test",
          blockedNetworkAttempts: [],
          logs: ["installed", "started demo"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate(input) {
        browserUrls.push(input.url);
        return {
          interactable: true,
          logs: ["loaded app"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await Promise.race([
      validateProject(
        {
          preparationManifest: manifest({
            demoCommand: "npm run demo",
            url: "http://127.0.0.1:3000",
          }),
          preparationWorkspace: hangingLogWorkspaceHandle(),
        },
        { browserValidator, sandboxRunner },
      ),
      delay(10).then(() => "timed-out" as const),
    ]);

    expect(result).toMatchObject({ status: "succeeded" });
    expect(browserUrls).toEqual(["http://127.0.0.1:3000"]);
  });

  it("passes the retained preparation workspace to browser validation", async () => {
    const preparationWorkspace = workspaceHandle([]);
    let browserWorkspaceId = "";
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          browserUrl: "http://localhost:3000",
          blockedNetworkAttempts: [],
          logs: ["started demo"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate(input) {
        browserWorkspaceId = input.preparationWorkspace?.id ?? "";
        return {
          interactable: true,
          logs: ["loaded app inside submitted-code container"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:3000",
        }),
        preparationWorkspace,
      },
      { browserValidator, sandboxRunner },
    );

    expect(result.status).toBe("succeeded");
    expect(browserWorkspaceId).toBe("workspace_123");
  });

  it("validates the manifest local URL inside a preparation workspace while preserving the preview URL", async () => {
    const browserUrls: string[] = [];
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          browserUrl: "https://preview.example.test/",
          blockedNetworkAttempts: [],
          logs: ["started demo"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate(input) {
        browserUrls.push(input.url);
        return {
          interactable: true,
          logs: ["loaded app inside submitted-code container"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:4173/",
        }),
        preparationWorkspace: workspaceHandle([]),
      },
      { browserValidator, sandboxRunner },
    );

    expect(browserUrls).toEqual(["http://localhost:4173/"]);
    expect(result).toMatchObject({
      browserUrl: "https://preview.example.test/",
      status: "succeeded",
    });
  });

  it("fails validation when runtime network attempts cross the sandbox boundary", async () => {
    let cleanedUp = false;
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [
            {
              direction: "outbound",
              host: "api.example.com",
              phase: "runtime",
            },
          ],
          logs: ["started demo"],
          cleanup: async () => {
            cleanedUp = true;
          },
          repoFiles: ["package.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        throw new Error(
          "browser validation should not run after network failure",
        );
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe(
      "Runtime network communication across the sandbox boundary is not allowed. Blocked runtime network attempts: api.example.com.",
    );
    expect(result.blockedNetworkAttempts).toHaveLength(1);
    expect(result.warnings).toEqual([
      "No lockfile found; npm install may be less deterministic.",
    ]);
    expect(cleanedUp).toBe(true);
  });

  it("returns a failed validation result when sandbox validation throws", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        throw new Error("Daytona command did not finish within 600000ms.");
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        throw new Error(
          "browser validation should not run after sandbox failure",
        );
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toEqual({
      blockedNetworkAttempts: [],
      failureReason: "Daytona command did not finish within 600000ms.",
      logs: ["Daytona command did not finish within 600000ms."],
      status: "failed",
      warnings: [],
    });
  });

  it("classifies submitted-code workspace sync failures in validation metadata", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        throw new SubmittedCodeWorkspaceSyncError(
          new Error("restore archive failed"),
        );
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        throw new Error(
          "browser validation should not run after sandbox failure",
        );
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toMatchObject({
      failureKind: "submitted-code-workspace-sync-failed",
      failureReason: "restore archive failed",
      logs: ["restore archive failed"],
      status: "failed",
    });
  });

  it("preserves browser validation errors when cleanup also fails", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          cleanup: async () => {
            throw new Error("cleanup failed");
          },
          logs: ["started demo"],
          repoFiles: ["package.json", "package-lock.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        throw new Error("browser failed");
      },
    };

    await expect(
      validateProject(
        {
          preparationManifest: manifest({
            demoCommand: "npm run demo",
            url: "http://localhost:5173",
          }),
        },
        { browserValidator, sandboxRunner },
      ),
    ).rejects.toThrow("browser failed");
  });

  it("returns a failed validation result when browser validation times out", async () => {
    let cleanedUp = false;
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          browserUrl: "https://preview.example.test",
          cleanup: async () => {
            cleanedUp = true;
          },
          logs: ["started demo"],
          repoFiles: ["package.json", "package-lock.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return await new Promise<never>(() => {});
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
      },
      { browserValidationTimeoutMs: 1, browserValidator, sandboxRunner },
    );

    expect(result).toMatchObject({
      failureReason: "Browser validation timed out after 1ms.",
      logs: ["started demo", "Browser validation timed out after 1ms."],
      status: "failed",
    });
    expect(cleanedUp).toBe(true);
  });

  it("fails validation when browser runtime requests leave the local boundary", async () => {
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          logs: ["started demo"],
          repoFiles: ["package.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return {
          blockedNetworkAttempts: [
            {
              direction: "outbound",
              host: "api.realworld.io",
              phase: "runtime",
              url: "https://api.realworld.io/articles",
            },
          ],
          interactable: true,
          logs: ["loaded app", "blocked https://api.realworld.io/articles"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle(sandboxLogs),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.realworld.io",
          phase: "runtime",
          url: "https://api.realworld.io/articles",
        },
      ],
      failureReason:
        "Runtime network communication across the sandbox boundary is not allowed. Blocked runtime network attempts: https://api.realworld.io/articles.",
      status: "failed",
    });
    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockedNetworkAttemptCount: 1,
          blockedNetworkAttempts: [
            {
              direction: "outbound",
              host: "api.realworld.io",
              phase: "runtime",
              url: "https://api.realworld.io/articles",
            },
          ],
          event: "project-validation.browser-validation.failed",
          failureReason:
            "Runtime network communication across the sandbox boundary is not allowed. Blocked runtime network attempts: https://api.realworld.io/articles.",
        }),
      ]),
    );
  });

  it("redacts blocked network URLs before validation diagnostics are formatted or logged", async () => {
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [
            {
              direction: "outbound",
              host: "api.example.com",
              phase: "runtime",
              url: "https://api.example.com/data?access_key=secret&state=csrf&page=1",
            },
          ],
          logs: ["started demo"],
          repoFiles: ["package.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        throw new Error(
          "browser validation should not run after network failure",
        );
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle(sandboxLogs),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.example.com",
          phase: "runtime",
          url: "https://api.example.com/data?access_key=%5Bredacted%5D&state=%5Bredacted%5D&page=%5Bredacted%5D",
        },
      ],
      failureReason:
        "Runtime network communication across the sandbox boundary is not allowed. Blocked runtime network attempts: https://api.example.com/data?access_key=%5Bredacted%5D&state=%5Bredacted%5D&page=%5Bredacted%5D.",
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("csrf");
  });

  it("preserves MakeADemo validator dependency failures from browser validation", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          browserUrl: "https://preview.example.test",
          logs: ["started demo"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return {
          interactable: false,
          logs: [
            "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.",
            "Cannot find module 'playwright'",
          ],
          screenshotArtifactId: "",
        };
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toMatchObject({
      failureReason:
        "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.",
      logs: [
        "started demo",
        "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.",
        "Cannot find module 'playwright'",
      ],
      status: "failed",
    });
  });
});

function manifest(overrides: { demoCommand: string; url: string }) {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: overrides.demoCommand,
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: overrides.url,
    workspaceId: "workspace_123",
  };
}

function workspaceHandle(
  sandboxLogs: Array<Record<string, unknown>>,
): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async setOutboundNetworkAccess() {},
      async setSubmittedCodeNetworkAccess() {},
      async uploadFiles() {},
      async writeSandboxLog(entry) {
        sandboxLogs.push(entry);
      },
    },
  };
}

function hangingLogWorkspaceHandle(): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async setOutboundNetworkAccess() {},
      async setSubmittedCodeNetworkAccess() {},
      async uploadFiles() {},
      async writeSandboxLog() {
        await new Promise(() => {});
      },
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
