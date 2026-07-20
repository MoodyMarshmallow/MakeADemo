import { exec } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { PlaywrightBrowserValidator } from "./playwright-browser-validator";

const execAsync = promisify(exec);

describe("PlaywrightBrowserValidator", () => {
  it("returns screenshot proof for reachable non-blank pages", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () => fakePage({ bodyText: "Demo app loaded" }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toEqual({
      interactable: true,
      logs: ["Loaded http://localhost:3000", "Captured screenshot proof."],
      screenshotArtifactId: "artifact_screenshot",
    });
  });

  it("marks blank pages as not interactable", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () => fakePage({ bodyText: "   " }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toMatchObject({
      interactable: false,
      screenshotArtifactId: "artifact_screenshot",
    });
  });

  it("marks unreachable pages as not interactable instead of throwing", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "",
          gotoError: new Error("net::ERR_CONNECTION_REFUSED"),
        }),
    });

    await expect(
      validator.validate({ url: "http://127.0.0.1:4173/" }),
    ).resolves.toMatchObject({
      interactable: false,
      logs: [
        "Failed to load http://127.0.0.1:4173/: net::ERR_CONNECTION_REFUSED",
      ],
      screenshotArtifactId: "",
    });
  });

  it("reports browser requests that leave the local runtime boundary", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "Demo app loaded",
          requestedUrls: [
            "http://localhost:3000/assets/app.js",
            "https://api.realworld.io/articles",
          ],
        }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toEqual({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.realworld.io",
          phase: "runtime",
          url: "https://api.realworld.io/articles",
        },
      ],
      failureKind: "runtime-network-blocked",
      interactable: false,
      logs: ["Blocked forbidden browser request to api.realworld.io"],
      screenshotArtifactId: "",
    });
  });

  it("aborts forbidden browser requests during page navigation", async () => {
    const abortedUrls: string[] = [];
    const continuedUrls: string[] = [];
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "Demo app loaded",
          onAbort: (url) => abortedUrls.push(url),
          onContinue: (url) => continuedUrls.push(url),
          requestedUrls: [
            "http://localhost:3000/assets/app.js",
            "https://fonts.googleapis.com/css?family=Inter",
            "https://code.ionicframework.com/ionicons/2.0.1/css/ionicons.min.css",
          ],
        }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toEqual({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "fonts.googleapis.com",
          phase: "runtime",
          url: "https://fonts.googleapis.com/css?family=%5Bredacted%5D",
        },
        {
          direction: "outbound",
          host: "code.ionicframework.com",
          phase: "runtime",
          url: "https://code.ionicframework.com/ionicons/2.0.1/css/ionicons.min.css",
        },
      ],
      failureKind: "runtime-network-blocked",
      interactable: false,
      logs: [
        "Blocked forbidden browser request to fonts.googleapis.com",
        "Blocked forbidden browser request to code.ionicframework.com",
      ],
      screenshotArtifactId: "",
    });
    expect(continuedUrls).toEqual(["http://localhost:3000/assets/app.js"]);
    expect(abortedUrls).toEqual([
      "https://fonts.googleapis.com/css?family=Inter",
      "https://code.ionicframework.com/ionicons/2.0.1/css/ionicons.min.css",
    ]);
  });

  it("redacts credentials and query values from blocked browser request URLs", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "Demo app loaded",
          requestedUrls: [
            "https://user:secret@cdn.example.com/assets/theme.css?api_key=shh&token=hidden&key=plain&AWSAccessKeyId=aws&Key-Pair-Id=pair&code=oauth&state=csrf&family=Inter#fragment",
          ],
        }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "cdn.example.com",
          phase: "runtime",
          url: "https://cdn.example.com/assets/theme.css?api_key=%5Bredacted%5D&token=%5Bredacted%5D&key=%5Bredacted%5D&AWSAccessKeyId=%5Bredacted%5D&Key-Pair-Id=%5Bredacted%5D&code=%5Bredacted%5D&state=%5Bredacted%5D&family=%5Bredacted%5D",
        },
      ],
    });
  });

  it("returns blocked network evidence when navigation fails after blocked requests", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "",
          gotoError: new Error("net::ERR_BLOCKED_BY_CLIENT"),
          requestedUrls: [
            "https://api.example.com/user?access_key=secret&code=oauth-code",
          ],
        }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toEqual({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.example.com",
          phase: "runtime",
          url: "https://api.example.com/user?access_key=%5Bredacted%5D&code=%5Bredacted%5D",
        },
      ],
      failureKind: "runtime-network-blocked",
      interactable: false,
      logs: ["Blocked forbidden browser request to api.example.com"],
      screenshotArtifactId: "",
    });
  });

  it("fails browser validation when page operations stop completing", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "Demo app loaded",
          screenshotNeverCompletes: true,
        }),
      validationTimeoutMs: 50,
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toEqual({
      failureKind: "browser-validation-timeout",
      interactable: false,
      logs: [
        "Browser validation timed out after 50ms for http://localhost:3000",
      ],
      screenshotArtifactId: "",
    });
  });

  it("runs browser validation inside the submitted-code container when a preparation workspace is provided", async () => {
    const submittedCommands: string[] = [];
    const validator = new PlaywrightBrowserValidator();

    const result = await validator.validate({
      preparationWorkspace: {
        async release() {},
        id: "workspace_123",
        workspace: {
          async execute() {
            throw new Error(
              "outer workspace execution must not validate browser",
            );
          },
          async executeSubmittedCode(command) {
            submittedCommands.push(command);
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                interactable: true,
                logs: ["Loaded http://localhost:3000"],
                screenshotArtifactId: "screenshot:inner",
              }),
            };
          },
          async getPreviewUrl() {
            return "https://preview.example.test";
          },
          async setOutboundNetworkAccess() {},
          async setSubmittedCodeNetworkAccess() {},
          async uploadFiles() {},
        },
      },
      url: "http://localhost:3000",
    });

    expect(result).toEqual({
      interactable: true,
      logs: [
        "Loaded http://localhost:3000",
        "Validation screenshot is unavailable to the repair workspace.",
      ],
      screenshotArtifactId: "",
    });
    expect(submittedCommands.join("\n")).toContain("chromium.launch");
    expect(submittedCommands.join("\n")).toContain("npm root -g");
    expect(submittedCommands.join("\n")).not.toContain(
      "/usr/local/lib/node_modules",
    );
    expect(submittedCommands.join("\n")).not.toContain('import("playwright")');
    expect(submittedCommands.join("\n")).toContain('page.route("**/*"');
    expect(submittedCommands.join("\n")).toContain(
      'route.abort("blockedbyclient")',
    );
    expect(submittedCommands.join("\n")).toContain("blockedNetworkAttempts");
    expect(submittedCommands.join("\n")).toContain("http://localhost:3000");
  });

  it("executes submitted-code browser validation with a valid heredoc terminator", async () => {
    const workspacePath = await createFakeSubmittedCodeWorkspace();
    const validator = new PlaywrightBrowserValidator();

    try {
      await expect(
        validator.validate({
          preparationWorkspace: {
            async release() {},
            id: "workspace_123",
            workspace: {
              async execute() {
                throw new Error(
                  "outer workspace execution must not validate browser",
                );
              },
              async executeSubmittedCode(command) {
                try {
                  const result = await execAsync(command, {
                    cwd: workspacePath,
                    env: {
                      ...process.env,
                      PATH: `${join(workspacePath, "bin")}:${process.env.PATH ?? ""}`,
                    },
                  });
                  return {
                    exitCode: 0,
                    stderr: result.stderr,
                    stdout: result.stdout,
                  };
                } catch (error) {
                  const failed = error as {
                    code?: number;
                    stderr?: string;
                    stdout?: string;
                  };
                  return {
                    exitCode: failed.code ?? 1,
                    stderr: failed.stderr ?? String(error),
                    stdout: failed.stdout ?? "",
                  };
                }
              },
              async getPreviewUrl() {
                return "https://preview.example.test";
              },
              async setOutboundNetworkAccess() {},
              async setSubmittedCodeNetworkAccess() {},
              async uploadFiles() {},
            },
          },
          url: "http://localhost:3000",
        }),
      ).resolves.toEqual({
        interactable: true,
        logs: [
          "Loaded http://localhost:3000",
          "Captured screenshot proof.",
          "Demo app loaded",
          "Validation screenshot is unavailable to the repair workspace.",
        ],
        screenshotArtifactId: "",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("returns submitted-code blocked network evidence when navigation fails after blocked requests", async () => {
    const workspacePath = await createFakeSubmittedCodeWorkspace({
      gotoErrorMessage: "net::ERR_BLOCKED_BY_CLIENT",
      routedUrls: [
        "https://oauth.example.com/callback?code=oauth-code&state=csrf",
      ],
    });
    const validator = new PlaywrightBrowserValidator();

    try {
      await expect(
        validator.validate({
          preparationWorkspace: {
            async release() {},
            id: "workspace_123",
            workspace: {
              async execute() {
                throw new Error(
                  "outer workspace execution must not validate browser",
                );
              },
              async executeSubmittedCode(command) {
                try {
                  const result = await execAsync(command, {
                    cwd: workspacePath,
                    env: {
                      ...process.env,
                      PATH: `${join(workspacePath, "bin")}:${process.env.PATH ?? ""}`,
                    },
                  });
                  return {
                    exitCode: 0,
                    stderr: result.stderr,
                    stdout: result.stdout,
                  };
                } catch (error) {
                  const failed = error as {
                    code?: number;
                    stderr?: string;
                    stdout?: string;
                  };
                  return {
                    exitCode: failed.code ?? 1,
                    stderr: failed.stderr ?? String(error),
                    stdout: failed.stdout ?? "",
                  };
                }
              },
              async getPreviewUrl() {
                return "https://preview.example.test";
              },
              async setOutboundNetworkAccess() {},
              async setSubmittedCodeNetworkAccess() {},
              async uploadFiles() {},
            },
          },
          url: "http://localhost:3000",
        }),
      ).resolves.toEqual({
        blockedNetworkAttempts: [
          {
            direction: "outbound",
            host: "oauth.example.com",
            phase: "runtime",
            url: "https://oauth.example.com/callback?code=%5Bredacted%5D&state=%5Bredacted%5D",
          },
        ],
        failureKind: "runtime-network-blocked",
        interactable: false,
        logs: ["Blocked forbidden browser request to oauth.example.com"],
        screenshotArtifactId: "",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("discovers validator-owned Playwright from non-/usr/local global npm installs inside submitted code", async () => {
    const validator = new PlaywrightBrowserValidator();

    const result = await validator.validate({
      preparationWorkspace: {
        async release() {},
        id: "workspace_123",
        workspace: {
          async execute() {
            throw new Error(
              "outer workspace execution must not validate browser",
            );
          },
          async executeSubmittedCode(command) {
            if (!command.includes("npm root -g")) {
              return {
                exitCode: 1,
                stderr:
                  "Error: Cannot find module 'playwright' from /home/node/.nvm/versions/node/v22/lib/node_modules",
                stdout: "",
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                interactable: true,
                logs: ["Loaded http://localhost:3000"],
                screenshotArtifactId: "screenshot:global-npm-root",
              }),
            };
          },
          async getPreviewUrl() {
            return "https://preview.example.test";
          },
          async setOutboundNetworkAccess() {},
          async setSubmittedCodeNetworkAccess() {},
          async uploadFiles() {},
        },
      },
      url: "http://localhost:3000",
    });

    expect(result).toEqual({
      interactable: true,
      logs: [
        "Loaded http://localhost:3000",
        "Validation screenshot is unavailable to the repair workspace.",
      ],
      screenshotArtifactId: "",
    });
  });

  it("reports missing sandbox Playwright as a MakeADemo validator dependency failure", async () => {
    const validator = new PlaywrightBrowserValidator();

    const result = await validator.validate({
      preparationWorkspace: {
        async release() {},
        id: "workspace_123",
        workspace: {
          async execute() {
            throw new Error(
              "outer workspace execution must not validate browser",
            );
          },
          async executeSubmittedCode() {
            return {
              exitCode: 1,
              stderr:
                "Error: Cannot find module 'playwright'\nRequire stack:\n- /workspace/app/[stdin]",
              stdout: "",
            };
          },
          async getPreviewUrl() {
            return "https://preview.example.test";
          },
          async setOutboundNetworkAccess() {},
          async setSubmittedCodeNetworkAccess() {},
          async uploadFiles() {},
        },
      },
      url: "http://localhost:3000",
    });

    expect(result).toMatchObject({
      interactable: false,
      logs: expect.arrayContaining([
        "MakeADemo validator dependency failure: Playwright is not available inside the submitted-code sandbox.",
      ]),
      screenshotArtifactId: "",
    });
  });

  it("returns sandbox screenshot metadata without returning inline screenshot bytes", async () => {
    const validator = new PlaywrightBrowserValidator();
    const result = await validator.validate({
      preparationWorkspace: fakeWorkspace(
        JSON.stringify({
          interactable: false,
          logs: ["Vite Error: token=secret"],
          screenshotArtifactId: "screenshot:very-secret-base64",
        }),
      ),
      url: "http://localhost:3000",
    });

    expect(result).toMatchObject({
      failureKind: "browser-not-interactable",
      screenshotArtifactId: "",
    });
    expect(JSON.stringify(result)).not.toContain("very-secret-base64");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("copies submitted validation screenshots into the primary repair workspace", async () => {
    const downloaded: Array<{
      destinationPath: string;
      sourcePath: string;
    }> = [];
    const uploaded: Array<{ destinationPath: string; sourcePath: string }> = [];
    let uploadedBytes: Buffer | undefined;
    const validator = new PlaywrightBrowserValidator();
    const base = fakeWorkspace(
      JSON.stringify({
        interactable: false,
        logs: ["Vite Error"],
        screenshot: {
          mimeType: "image/png",
          path: "/workspace/.makeademo/validation-screenshot.png",
          sizeBytes: 4,
        },
        screenshotArtifactId: "",
      }),
    );
    const receiverSensitiveWorkspace = {
      ...base.workspace,
      submittedScreenshotBytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      async downloadSubmittedCodeFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        downloaded.push(...files);
        for (const file of files) {
          await writeFile(file.destinationPath, this.submittedScreenshotBytes);
        }
      },
      async uploadFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        uploaded.push(...files);
        const file = files[0];
        if (file === undefined) {
          throw new Error("expected uploaded screenshot");
        }
        uploadedBytes = await readFile(file.sourcePath);
      },
    };
    const result = await validator.validate({
      preparationWorkspace: {
        ...base,
        workspace: receiverSensitiveWorkspace,
      },
      url: "http://localhost:3000",
    });

    expect(result.screenshot).toEqual({
      mimeType: "image/png",
      path: "/workspace/.makeademo/demo-runtime-preflight/browser.png",
      sizeBytes: receiverSensitiveWorkspace.submittedScreenshotBytes.length,
    });
    expect(downloaded).toEqual([
      {
        destinationPath: expect.stringMatching(/browser\.png$/),
        sourcePath: "/workspace/.makeademo/validation-screenshot.png",
      },
    ]);
    const firstDownloaded = downloaded[0];
    if (firstDownloaded === undefined) {
      throw new Error("expected downloaded screenshot");
    }
    expect(uploaded).toEqual([
      {
        destinationPath:
          "/workspace/.makeademo/demo-runtime-preflight/browser.png",
        sourcePath: firstDownloaded.destinationPath,
      },
    ]);
    expect(uploadedBytes).toEqual(
      receiverSensitiveWorkspace.submittedScreenshotBytes,
    );
  });

  it("rejects submitted validation screenshots that are not bounded PNG files", async () => {
    const uploaded: Array<{ destinationPath: string; sourcePath: string }> = [];
    const base = fakeWorkspace(
      JSON.stringify({
        interactable: false,
        logs: ["Vite Error"],
        screenshot: {
          mimeType: "image/png",
          path: "/workspace/.makeademo/validation-screenshot.png",
          sizeBytes: 4,
        },
        screenshotArtifactId: "",
      }),
    );
    const receiverSensitiveWorkspace = {
      ...base.workspace,
      async downloadSubmittedCodeFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        for (const file of files) {
          await writeFile(file.destinationPath, Buffer.from("not a png"));
        }
      },
      async uploadFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        uploaded.push(...files);
      },
    };

    const result = await new PlaywrightBrowserValidator().validate({
      preparationWorkspace: {
        ...base,
        workspace: receiverSensitiveWorkspace,
      },
      url: "http://localhost:3000",
    });

    expect(result.screenshot).toBeUndefined();
    expect(result.logs).toContain(
      "Validation screenshot from submitted-code sandbox is invalid.",
    );
    expect(uploaded).toHaveLength(0);
  });

  it("rejects submitted validation screenshots larger than the transfer bound", async () => {
    const uploaded: Array<{ destinationPath: string; sourcePath: string }> = [];
    const base = fakeWorkspace(
      JSON.stringify({
        interactable: false,
        logs: ["Vite Error"],
        screenshot: {
          mimeType: "image/png",
          path: "/workspace/.makeademo/validation-screenshot.png",
        },
        screenshotArtifactId: "",
      }),
    );
    const oversizedPng = Buffer.alloc(10 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
      oversizedPng,
    );
    const receiverSensitiveWorkspace = {
      ...base.workspace,
      async downloadSubmittedCodeFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        for (const file of files) {
          await writeFile(file.destinationPath, oversizedPng);
        }
      },
      async uploadFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        uploaded.push(...files);
      },
    };

    const result = await new PlaywrightBrowserValidator().validate({
      preparationWorkspace: {
        ...base,
        workspace: receiverSensitiveWorkspace,
      },
      url: "http://localhost:3000",
    });

    expect(result.screenshot).toBeUndefined();
    expect(result.logs).toContain(
      "Validation screenshot from submitted-code sandbox is invalid.",
    );
    expect(uploaded).toHaveLength(0);
  });

  it("reports submitted-code download failures separately from repair uploads", async () => {
    const uploaded: Array<{ destinationPath: string; sourcePath: string }> = [];
    const base = fakeWorkspace(
      JSON.stringify({
        interactable: false,
        logs: ["Vite Error"],
        screenshot: {
          mimeType: "image/png",
          path: "/workspace/.makeademo/validation-screenshot.png",
        },
        screenshotArtifactId: "",
      }),
    );
    const receiverSensitiveWorkspace = {
      ...base.workspace,
      async downloadSubmittedCodeFiles() {
        throw new Error("submitted sandbox unavailable");
      },
      async uploadFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        uploaded.push(...files);
      },
    };

    const result = await new PlaywrightBrowserValidator().validate({
      preparationWorkspace: {
        ...base,
        workspace: receiverSensitiveWorkspace,
      },
      url: "http://localhost:3000",
    });

    expect(result.logs).toContain(
      "Validation screenshot download from submitted-code sandbox failed.",
    );
    expect(result.logs).not.toContain(
      "Validation screenshot upload to the repair workspace failed.",
    );
    expect(uploaded).toHaveLength(0);
  });

  it("keeps an interactable result successful when screenshot transfer fails", async () => {
    const base = fakeWorkspace(
      JSON.stringify({
        interactable: true,
        logs: ["Loaded http://localhost:3000"],
        screenshot: {
          mimeType: "image/png",
          path: "/workspace/.makeademo/validation-screenshot.png",
        },
        screenshotArtifactId: "",
      }),
    );
    const receiverSensitiveWorkspace = {
      ...base.workspace,
      async downloadSubmittedCodeFiles() {
        throw new Error("submitted sandbox unavailable");
      },
    };

    const result = await new PlaywrightBrowserValidator().validate({
      preparationWorkspace: {
        ...base,
        workspace: receiverSensitiveWorkspace,
      },
      url: "http://localhost:3000",
    });

    expect(result.interactable).toBe(true);
    expect(result.failureKind).toBeUndefined();
    expect(result.logs).toContain(
      "Validation screenshot download from submitted-code sandbox failed.",
    );
  });

  it("reports primary repair workspace upload failures separately", async () => {
    const base = fakeWorkspace(
      JSON.stringify({
        interactable: false,
        logs: ["Vite Error"],
        screenshot: {
          mimeType: "image/png",
          path: "/workspace/.makeademo/validation-screenshot.png",
        },
        screenshotArtifactId: "",
      }),
    );
    const receiverSensitiveWorkspace = {
      ...base.workspace,
      async downloadSubmittedCodeFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        for (const file of files) {
          await writeFile(
            file.destinationPath,
            Buffer.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x76, 0x61, 0x6c,
              0x69, 0x64,
            ]),
          );
        }
      },
      async uploadFiles() {
        throw new Error("repair workspace unavailable");
      },
    };

    const result = await new PlaywrightBrowserValidator().validate({
      preparationWorkspace: {
        ...base,
        workspace: receiverSensitiveWorkspace,
      },
      url: "http://localhost:3000",
    });

    expect(result.logs).toContain(
      "Validation screenshot upload to the repair workspace failed.",
    );
    expect(result.logs).not.toContain(
      "Validation screenshot download from submitted-code sandbox failed.",
    );
  });

  it("preserves submitted-code browser network-blocking evidence", async () => {
    const validator = new PlaywrightBrowserValidator();

    await expect(
      validator.validate({
        preparationWorkspace: {
          async release() {},
          id: "workspace_123",
          workspace: {
            async execute() {
              throw new Error(
                "outer workspace execution must not validate browser",
              );
            },
            async executeSubmittedCode() {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  blockedNetworkAttempts: [
                    {
                      direction: "outbound",
                      host: "api.example.com",
                      phase: "runtime",
                    },
                  ],
                  interactable: false,
                  logs: [
                    "Blocked forbidden browser request to api.example.com",
                  ],
                  screenshotArtifactId: "",
                }),
              };
            },
            async getPreviewUrl() {
              return "https://preview.example.test";
            },
            async setOutboundNetworkAccess() {},
            async setSubmittedCodeNetworkAccess() {},
            async uploadFiles() {},
          },
        },
        url: "http://localhost:3000",
      }),
    ).resolves.toEqual({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.example.com",
          phase: "runtime",
        },
      ],
      failureKind: "runtime-network-blocked",
      interactable: false,
      logs: ["Blocked forbidden browser request to api.example.com"],
      screenshotArtifactId: "",
    });
  });

  it("redacts submitted-code blocked request URLs before returning browser validation evidence", async () => {
    const validator = new PlaywrightBrowserValidator();

    await expect(
      validator.validate({
        preparationWorkspace: {
          async release() {},
          id: "workspace_123",
          workspace: {
            async execute() {
              throw new Error(
                "outer workspace execution must not validate browser",
              );
            },
            async executeSubmittedCode() {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  blockedNetworkAttempts: [
                    {
                      direction: "outbound",
                      host: "oauth.example.com",
                      phase: "runtime",
                      url: "https://oauth.example.com/callback?key=plain&AWSAccessKeyId=aws&Key-Pair-Id=pair&code=oauth-code&state=csrf&redirect_uri=http://localhost:3000/callback",
                    },
                  ],
                  interactable: false,
                  logs: [
                    "Blocked forbidden browser request to oauth.example.com",
                  ],
                  screenshotArtifactId: "",
                }),
              };
            },
            async getPreviewUrl() {
              return "https://preview.example.test";
            },
            async setOutboundNetworkAccess() {},
            async setSubmittedCodeNetworkAccess() {},
            async uploadFiles() {},
          },
        },
        url: "http://localhost:3000",
      }),
    ).resolves.toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "oauth.example.com",
          phase: "runtime",
          url: "https://oauth.example.com/callback?key=%5Bredacted%5D&AWSAccessKeyId=%5Bredacted%5D&Key-Pair-Id=%5Bredacted%5D&code=%5Bredacted%5D&state=%5Bredacted%5D&redirect_uri=%5Bredacted%5D",
        },
      ],
    });
  });
});

function fakePage(input: {
  bodyText: string;
  gotoError?: Error;
  onAbort?: (url: string) => void;
  onContinue?: (url: string) => void;
  requestedUrls?: string[];
  screenshotNeverCompletes?: boolean;
}) {
  let routeHandler:
    | ((route: {
        abort: () => Promise<void>;
        continue: () => Promise<void>;
        request: () => { url: () => string };
      }) => Promise<void>)
    | undefined;

  return {
    async close() {},
    async goto() {
      for (const url of input.requestedUrls ?? []) {
        await routeHandler?.({
          async abort() {
            input.onAbort?.(url);
          },
          async continue() {
            input.onContinue?.(url);
          },
          request() {
            return { url: () => url };
          },
        });
      }
      if (input.gotoError !== undefined) {
        throw input.gotoError;
      }
    },
    async requestedUrls() {
      return input.requestedUrls ?? [];
    },
    async screenshot() {
      if (input.screenshotNeverCompletes) {
        await new Promise(() => {});
      }
      return "artifact_screenshot";
    },
    async route(_pattern: string, handler: NonNullable<typeof routeHandler>) {
      routeHandler = handler;
    },
    async textContent() {
      return input.bodyText;
    },
  };
}

function fakeWorkspace(stdout: string) {
  return {
    async release() {},
    id: "workspace_123",
    workspace: {
      async execute() {
        throw new Error("outer workspace execution must not validate browser");
      },
      async executeSubmittedCode() {
        return { exitCode: 0, stderr: "", stdout };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async setOutboundNetworkAccess() {},
      async setSubmittedCodeNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

async function createFakeSubmittedCodeWorkspace(
  options: { gotoErrorMessage?: string; routedUrls?: string[] } = {},
) {
  const workspacePath = await mkdtemp(join(tmpdir(), "makeademo-browser-"));
  await mkdir(join(workspacePath, "bin"), { recursive: true });
  await mkdir(join(workspacePath, "node_modules", "playwright"), {
    recursive: true,
  });
  await writeFile(join(workspacePath, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(
    join(workspacePath, "bin", "npm"),
    '#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n  exit 0\nfi\nexit 1\n',
  );
  await chmod(join(workspacePath, "bin", "npm"), 0o755);
  await writeFile(
    join(workspacePath, "node_modules", "playwright", "package.json"),
    '{"main":"index.js"}\n',
  );
  await writeFile(
    join(workspacePath, "node_modules", "playwright", "index.js"),
    `module.exports = {
  chromium: {
    async launch() {
      return {
        async close() {},
        async newPage() {
          return {
            async goto() {
              ${options.gotoErrorMessage === undefined ? "" : `throw new Error(${JSON.stringify(options.gotoErrorMessage)});`}
            },
            async route(_pattern, handler) {
              for (const url of ${JSON.stringify(options.routedUrls ?? [])}) {
                await handler({
                  async abort() {},
                  async continue() {},
                  request() { return { url: () => url }; },
                });
              }
            },
            async screenshot() {
              return Buffer.from("fake");
            },
            async textContent() {
              return "Demo app loaded";
            },
          };
        },
      };
    },
  },
};
`,
  );

  return workspacePath;
}
