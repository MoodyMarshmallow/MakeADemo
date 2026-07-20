import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import { SubmittedCodeWorkspaceSyncError } from "../../03-repo-preparation/submitted-code-execution";
import type { BrowserValidator } from "./browser-validator.interface";
import { runDemoRuntimePreflight } from "./demo-runtime-preflight";
import type { SandboxRunner } from "./sandbox-runner.interface";

describe("runDemoRuntimePreflight", () => {
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

    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://127.0.0.1:3000",
        }),
        preparationWorkspace: workspaceHandle([]),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toEqual({
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test",
      localUrl: "http://127.0.0.1:3000",
      logs: ["installed", "started demo", "loaded app"],
      previewUrl: "https://preview.example.test",
      screenshotArtifactId: "artifact_screenshot",
      status: "succeeded",
      warnings: [],
    });
    expect(browserUrls).toEqual(["http://127.0.0.1:3000"]);
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

    await runDemoRuntimePreflight(
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
          event: "demo-runtime-preflight.browser-validation.started",
          stage: "demo-runtime-preflight",
          workspaceId: "workspace_123",
        }),
        expect.objectContaining({
          browserUrl: "https://preview.example.test",
          event: "demo-runtime-preflight.browser-validation.succeeded",
          screenshotArtifactId: "artifact_screenshot",
          stage: "demo-runtime-preflight",
          workspaceId: "workspace_123",
        }),
      ]),
    );
  });

  it("does not block Demo Runtime Preflight when workspace log writes hang", async () => {
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
      runDemoRuntimePreflight(
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

    const result = await runDemoRuntimePreflight(
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

    const result = await runDemoRuntimePreflight(
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

    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([]),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe(
      "Runtime network communication across the sandbox boundary is not allowed. Blocked runtime network attempts: api.example.com.",
    );
    expect(result.blockedNetworkAttempts).toHaveLength(1);
    expect(result.warnings).toEqual([]);
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

    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([]),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toEqual({
      blockedNetworkAttempts: [],
      failureKind: "sandbox-execution-failed",
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

    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([]),
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

  it("preserves bounded redacted sandbox evidence with its failure kind", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          failureKind: "demo-process-exited",
          failureReason: "Vite failed with token=secret",
          logs: ["server failed token=secret"],
          repoFiles: ["package.json"],
          runtimeExitCode: 1,
          serverLog: "Vite error: bearer abc.def.ghi",
        };
      },
    };

    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([]),
      },
      {
        browserValidator: {
          async validate() {
            throw new Error("must not validate");
          },
        },
        sandboxRunner,
      },
    );

    expect(result).toMatchObject({
      failureKind: "demo-process-exited",
      failureReason: "Vite failed with token=[redacted]",
      evidence: { serverLog: { text: "Vite error: bearer [redacted]" } },
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("abc.def.ghi");
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
      runDemoRuntimePreflight(
        {
          preparationManifest: manifest({
            demoCommand: "npm run demo",
            url: "http://localhost:5173",
          }),
          preparationWorkspace: workspaceHandle([]),
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

    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([]),
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

    const result = await runDemoRuntimePreflight(
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
          event: "demo-runtime-preflight.browser-validation.failed",
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

    const result = await runDemoRuntimePreflight(
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

    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([]),
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

  it("returns Ghost-style server and browser evidence with accessible screenshot metadata", async () => {
    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([]),
      },
      {
        browserValidator: {
          async validate() {
            return {
              failureKind: "browser-not-interactable",
              interactable: false,
              logs: ["Vite Error: token=secret"],
              screenshot: {
                mimeType: "image/png",
                path: "/workspace/.makeademo/validation-screenshot.png",
              },
              screenshotArtifactId: "",
            };
          },
        },
        sandboxRunner: {
          async runValidation() {
            return {
              blockedNetworkAttempts: [],
              browserUrl: "https://preview.example.test",
              logs: [],
              repoFiles: ["package-lock.json", "package.json"],
              runtimeExitCode: 0,
              serverLog: "Vite failed token=secret",
            };
          },
        },
      },
    );

    expect(result).toMatchObject({
      evidence: {
        browser: { text: "Vite Error: token=[redacted]" },
        serverLog: { text: "Vite failed token=[redacted]" },
      },
      screenshot: { path: "/workspace/.makeademo/validation-screenshot.png" },
      status: "failed",
    });
  });

  it("redacts and bounds lower-priority toolchain metadata warnings", async () => {
    const secret = "token=supersecret";
    const result = await runDemoRuntimePreflight(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
        preparationWorkspace: workspaceHandle([], {
          candidates: [
            {
              files: {
                ".nvmrc": `${secret}${"x".repeat(2_000)}`,
                "package.json": JSON.stringify({
                  engines: { node: "22" },
                  packageManager: "pnpm@11.13.0",
                }),
                "pnpm-lock.yaml": "",
              },
              projectRoot: ".",
            },
          ],
        }),
      },
      {
        browserValidator: {
          async validate() {
            return { interactable: true, logs: [], screenshotArtifactId: "" };
          },
        },
        sandboxRunner: {
          async runValidation() {
            return {
              blockedNetworkAttempts: [],
              logs: [],
              repoFiles: [],
              runtimeExitCode: 0,
            };
          },
        },
      },
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain(secret);
    expect(result.warnings[0]).toContain("token=***");
    expect(result.warnings[0]?.length).toBeLessThanOrEqual(1_000);
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
  toolchainMetadata: unknown = supportedToolchainMetadata,
): PreparationWorkspaceHandle {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async execute(command) {
        if (command === "makeademo-inspect-submitted-code-toolchain") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(toolchainMetadata),
          };
        }
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
      async execute(command) {
        if (command === "makeademo-inspect-submitted-code-toolchain") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(supportedToolchainMetadata),
          };
        }
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

const supportedToolchainMetadata = {
  candidates: [
    {
      files: {
        "package.json": JSON.stringify({
          engines: { node: "22" },
          packageManager: "pnpm@11.13.0",
        }),
        "pnpm-lock.yaml": "",
      },
      projectRoot: ".",
    },
  ],
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
