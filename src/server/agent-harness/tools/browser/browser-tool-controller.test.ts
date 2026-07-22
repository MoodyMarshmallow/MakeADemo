import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createBrowserToolController } from "./browser-tool-controller";

const execFileAsync = promisify(execFile);

describe("BrowserToolController", () => {
  it("normalizes the pinned CLI 0.1.17 JSON shapes without exposing lifecycle or file metadata", async () => {
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          const action = readCliAction(command);
          if (action.startsWith("eval ")) {
            return pinnedCliResult("http://127.0.0.1:3000");
          }
          if (action.startsWith("open ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                pid: 42,
                result: {
                  filename:
                    "/tmp/makeademo-browser-tools/private/open-snapshot.md",
                },
                session: "private-session",
              }),
            };
          }
          if (action === "snapshot --depth=8") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                snapshot: "button Submit [ref=e4]",
              }),
            };
          }
          if (action === "console" || action === "requests") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({ result: `${action} output` }),
            };
          }
          if (action.startsWith("goto ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                result: {
                  filename:
                    "/tmp/makeademo-browser-tools/private/goto-snapshot.md",
                },
              }),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "{}" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(controller.inspect({ kind: "snapshot" })).resolves.toEqual({
      kind: "snapshot",
      output: "button Submit [ref=e4]",
    });
    await expect(controller.inspect({ kind: "console" })).resolves.toEqual({
      kind: "console",
      output: "console output",
    });
    await expect(controller.inspect({ kind: "requests" })).resolves.toEqual({
      kind: "requests",
      output: "requests output",
    });
    await expect(controller.act({ kind: "click", ref: "e4" })).resolves.toEqual(
      {
        output: "",
      },
    );
    await expect(controller.navigate({ path: "/next" })).resolves.toEqual({
      output: "",
      url: "http://127.0.0.1:3000/next",
    });
  });

  it("surfaces a sanitized nested CLI error even when the process exits zero", async () => {
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          if (command.includes(" eval ")) {
            return pinnedCliResult("http://127.0.0.1:3000");
          }
          if (command.includes(" click ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                result: {
                  error:
                    "GET https://user:secret@example.test/fail?token=secret#fragment",
                  isError: true,
                },
              }),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "{}" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.act({ kind: "click", ref: "e4" }),
    ).rejects.toMatchObject({
      failureKind: "cli-error",
      message: "GET https://example.test/fail?token=%5Bredacted%5D",
    });
  });

  it("rejects an origin result that is not a JSON-encoded string", async () => {
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? JSON.stringify({ result: "http://127.0.0.1:3000" })
              : "{}",
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.inspect({ kind: "snapshot" }),
    ).rejects.toMatchObject({
      failureKind: "invalid-cli-output",
      message: "Browser CLI returned an invalid origin result.",
    });
  });

  it("opens the authorized local URL before the first navigation and retains that session", async () => {
    const commands: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? pinnedCliResultStdout("http://127.0.0.1:3000")
              : JSON.stringify({ result: "ok", session: "private", pid: 42 }),
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await controller.navigate({ path: "/first" });
    await controller.navigate({ path: "/second" });

    expect(readCliActions(commands)).toEqual([
      "open 'http://127.0.0.1:3000/'",
      "eval '() => location.origin'",
      "goto 'http://127.0.0.1:3000/first'",
      "eval '() => location.origin'",
      "goto 'http://127.0.0.1:3000/second'",
      "eval '() => location.origin'",
    ]);
    expect(commands[0]).toContain("PLAYWRIGHT_MCP_CONFIG");
    expect(
      commands
        .slice(1)
        .every((command) => !command.includes("PLAYWRIGHT_MCP_CONFIG")),
    ).toBe(true);
  });

  it("disables Chromium's Linux sandbox for the submitted-code container", async () => {
    const commands: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? pinnedCliResultStdout("http://127.0.0.1:3000")
              : JSON.stringify({ result: "ok", session: "private", pid: 42 }),
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await controller.navigate({ path: "/" });

    expect(commands[0]).toContain('"chromiumSandbox":false');
  });

  it("suppresses redirected page output and closes when the observed origin leaves the demo", async () => {
    const commands: string[] = [];
    let originChecks = 0;
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          if (command.includes(" eval ")) {
            originChecks += 1;
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                result: JSON.stringify(
                  originChecks === 1
                    ? "http://127.0.0.1:3000"
                    : "https://outside.example.test",
                ),
              }),
            };
          }
          if (command.includes(" close")) {
            return { exitCode: 0, stderr: "", stdout: '{"status":"closed"}' };
          }
          return {
            exitCode: 0,
            stderr: "",
            stdout: '{"result":"private redirected page output"}',
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.navigate({ path: "/redirect" }),
    ).rejects.toMatchObject({
      failureKind: "navigation-outside-demo-origin",
      message: "Browser navigation left the authorized demo origin.",
    });
    expect(readCliActions(commands)).toEqual([
      "open 'http://127.0.0.1:3000/'",
      "eval '() => location.origin'",
      "goto 'http://127.0.0.1:3000/redirect'",
      "eval '() => location.origin'",
      "close",
    ]);
  });

  it("parses pinned CLI JSON and exposes only a provider-neutral bounded result", async () => {
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          if (command.includes(" eval ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: pinnedCliResultStdout("http://127.0.0.1:3000"),
            };
          }
          if (command.includes(" snapshot")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: pinnedCliSnapshotStdout(
                "button Submit [ref=e4]\nartifact /tmp/makeademo-browser-tools/private/session.json",
              ),
            };
          }
          return {
            exitCode: 0,
            stderr: "",
            stdout: '{"pid":42,"result":"opened","session":"private"}',
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(controller.inspect({ kind: "snapshot" })).resolves.toEqual({
      kind: "snapshot",
      output: "button Submit [ref=e4]\nartifact [internal-path]",
    });
  });

  it("returns a bounded sanitized CLI failure without raw transport details", async () => {
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          if (command.includes(" eval ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: pinnedCliResultStdout("http://127.0.0.1:3000"),
            };
          }
          if (command.includes(" click ")) {
            return {
              exitCode: 1,
              stderr: "provider internal path /tmp/private",
              stdout:
                '{"isError":true,"error":"GET https://user:pass@example.test/fail?token=secret#fragment"}',
            };
          }
          return { exitCode: 0, stderr: "", stdout: '{"result":"opened"}' };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.act({ kind: "click", ref: "e4" }),
    ).rejects.toMatchObject({
      failureKind: "cli-error",
      message: "GET https://example.test/fail?token=%5Bredacted%5D",
    });
  });

  it("bounds producer output while draining the CLI and removes transport files before provider return", async () => {
    const commands: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? pinnedCliResultStdout("http://127.0.0.1:3000")
              : command.includes(" snapshot")
                ? pinnedCliSnapshotStdout("snapshot")
                : "{}",
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await controller.inspect({ kind: "snapshot" });

    expect(commands).not.toHaveLength(0);
    for (const command of commands) {
      expect(command).toMatch(
        /\) 2>&1 \| \(head -c 16385 > '\/tmp\/makeademo-browser-tools\/.+\/command-[a-z0-9-]+\.json'; cat > \/dev\/null\)/,
      );
      expect(command).not.toMatch(
        /playwright-cli[^;]+ > '\/tmp\/makeademo-browser-tools\/[^']+\/command-/,
      );
      expect(command).toContain("makeademo_cli_status_path=");
      expect(command).toMatch(
        /rm -f '\/tmp\/makeademo-browser-tools\/.+\/command-[a-z0-9-]+\.json'/,
      );
    }
  });

  it("executes the producer cap in POSIX shell and returns only the byte sentinel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-browser-cli-"));
    const cliPath = join(directory, "playwright-cli");
    let largestProviderOutput = 0;
    await writeFile(
      cliPath,
      [
        "#!/bin/sh",
        'case " $* " in',
        `  *" eval "*) printf '%s' '${pinnedCliResultStdout("http://127.0.0.1:3000")}' ;;`,
        '  *" snapshot "*) head -c 20000 /dev/zero | tr "\\000" x ;;',
        "  *) printf '%s' '{}' ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command, options) {
          try {
            const result = await execFileAsync("/bin/sh", ["-c", command], {
              env: {
                ...process.env,
                ...options?.env,
                PATH: `${directory}:${process.env.PATH ?? ""}`,
              },
              maxBuffer: 64 * 1024,
            });
            largestProviderOutput = Math.max(
              largestProviderOutput,
              Buffer.byteLength(result.stdout),
            );
            return {
              exitCode: 0,
              stderr: result.stderr,
              stdout: result.stdout,
            };
          } catch (error) {
            const failure = error as {
              code?: number;
              stderr?: string;
              stdout?: string;
            };
            return {
              exitCode: failure.code ?? 1,
              stderr: failure.stderr ?? "",
              stdout: failure.stdout ?? "",
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
    });

    try {
      await expect(
        controller.inspect({ kind: "snapshot" }),
      ).rejects.toMatchObject({
        failureKind: "output-too-large",
      });
      expect(largestProviderOutput).toBe(16 * 1024 + 1);
    } finally {
      await controller.reset();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects CLI transport output that reaches the configured byte sentinel", async () => {
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode() {
          return { exitCode: 0, stderr: "", stdout: "x".repeat(16 * 1024 + 1) };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.inspect({ kind: "snapshot" }),
    ).rejects.toMatchObject({
      failureKind: "output-too-large",
      message: "Browser CLI output exceeded 16384 bytes.",
    });
  });

  it("cleans up with an independent deadline, falls back to kill-all, and reopens after reset", async () => {
    const actions: string[] = [];
    let closeAttempts = 0;
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command, options) {
          const action = readCliAction(command);
          actions.push(action);
          if (action === "close") {
            closeAttempts += 1;
            expect(options?.timeoutMs).toBeGreaterThan(0);
            return {
              exitCode: 1,
              stderr: "",
              stdout: '{"isError":true,"error":"close failed"}',
            };
          }
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              action === "eval '() => location.origin'"
                ? pinnedCliResultStdout("http://127.0.0.1:3000")
                : action.startsWith("snapshot")
                  ? pinnedCliSnapshotStdout("snapshot")
                  : "{}",
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await controller.inspect({ kind: "snapshot" });
    const aborted = new AbortController();
    aborted.abort(new Error("stage cancelled"));
    controller.updateContext({
      deadlineAt: Date.now() - 1,
      signal: aborted.signal,
      localUrl: "http://127.0.0.1:3000",
    });
    await controller.reset();
    controller.updateContext({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
    });
    await controller.inspect({ kind: "snapshot" });

    expect(closeAttempts).toBe(1);
    expect(actions).toContain("kill-all");
    expect(actions.filter((action) => action.startsWith("open "))).toHaveLength(
      2,
    );
  });

  it("reseals submitted-code network before navigating through its retained CLI session", async () => {
    const events: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000/demo",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command, options) {
          events.push(command);
          expect(options).toMatchObject({
            env: expect.objectContaining({
              NO_UPDATE_NOTIFIER: "1",
              PLAYWRIGHT_CLI_SESSION: expect.stringMatching(/^makeademo-/),
            }),
            timeoutMs: expect.any(Number),
          });
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? pinnedCliResultStdout("http://127.0.0.1:3000")
              : command.includes(" goto ")
                ? "{}"
                : "{}",
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess(enabled) {
          events.push(`network:${enabled}`);
        },
        async uploadFiles() {},
      },
    });

    await expect(
      controller.navigate({ path: "settings?tab=profile" }),
    ).resolves.toEqual({
      output: "",
      url: "http://127.0.0.1:3000/settings?tab=profile",
    });

    expect(events.filter((event) => event === "network:false")).toHaveLength(4);
    expect(
      events.map((event) =>
        event === "network:false" ? event : readCliAction(event),
      ),
    ).toEqual([
      "network:false",
      "open 'http://127.0.0.1:3000/demo'",
      "network:false",
      "eval '() => location.origin'",
      "network:false",
      "goto 'http://127.0.0.1:3000/settings?tab=profile'",
      "network:false",
      "eval '() => location.origin'",
    ]);
  });

  it("normalizes bounded and credential-safe browser inspection from the retained session", async () => {
    const commands: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? pinnedCliResultStdout("http://127.0.0.1:3000")
              : command.includes(" requests")
                ? JSON.stringify({
                    result:
                      "GET https://api.example.test/items?token=secret#private\nconsole ready",
                  })
                : '{"result":"opened"}',
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(controller.inspect({ kind: "requests" })).resolves.toEqual({
      kind: "requests",
      output:
        "GET https://api.example.test/items?token=%5Bredacted%5D\nconsole ready",
    });
    expect(readCliActions(commands)).toEqual([
      "open 'http://127.0.0.1:3000/'",
      "eval '() => location.origin'",
      "eval '() => location.origin'",
      "requests",
      "eval '() => location.origin'",
    ]);
  });

  it("maps only a fixed browser action schema to CLI arguments", async () => {
    const commands: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? pinnedCliResultStdout("http://127.0.0.1:3000")
              : command.includes(" fill ")
                ? "{}"
                : "{}",
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.act({ kind: "fill", ref: "e12", text: "Jane O'Connor" }),
    ).resolves.toEqual({ output: "" });
    expect(readCliActions(commands)).toContain(
      "fill 'e12' 'Jane O'\\''Connor'",
    );
    await expect(
      controller.act({ kind: "eval", ref: "e12" } as never),
    ).rejects.toThrow("Unsupported browser action");
  });

  it("transfers a validated screenshot from submitted code into the agent-readable workspace", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
    ]);
    const uploads: Array<{ bytes: Buffer; destinationPath: string }> = [];
    let downloadOptions: unknown;
    const workspace = {
      marker: "submitted-code-workspace",
      async downloadSubmittedCodeFiles(
        this: { marker: string },
        files: Array<{ destinationPath: string }>,
        options?: unknown,
      ) {
        expect(this.marker).toBe("submitted-code-workspace");
        downloadOptions = options;
        const [file] = files;
        if (file === undefined)
          throw new Error("Expected screenshot download.");
        await writeFile(file.destinationPath, png);
      },
      async execute() {
        throw new Error("The browser controller must use submitted code.");
      },
      async executeSubmittedCode(command: string) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: command.includes(" eval ")
            ? pinnedCliResultStdout("http://127.0.0.1:3000")
            : "{}",
        };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async setOutboundNetworkAccess() {},
      async setSubmittedCodeNetworkAccess() {},
      async uploadFiles(
        files: Array<{ destinationPath: string; sourcePath: string }>,
      ) {
        const [file] = files;
        if (file === undefined) throw new Error("Expected screenshot upload.");
        uploads.push({
          bytes: await readFile(file.sourcePath),
          destinationPath: file.destinationPath,
        });
      },
    };
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace,
    });

    await expect(
      controller.screenshot({ fullPage: true, target: "e4" }),
    ).rejects.toThrow("cannot combine target and fullPage");
    await expect(controller.screenshot({ fullPage: true })).resolves.toEqual({
      path: "/workspace/.makeademo/browser-tools/latest.png",
      sizeBytes: png.length,
    });
    expect(uploads).toEqual([
      {
        bytes: png,
        destinationPath: "/workspace/.makeademo/browser-tools/latest.png",
      },
    ]);
    expect(downloadOptions).toMatchObject({
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: expect.any(Number),
    });
  });

  it("suppresses inspect evidence when the page changes origin during collection", async () => {
    const actions: string[] = [];
    let originChecks = 0;
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          const action = readCliAction(command);
          actions.push(action);
          if (action.startsWith("eval ")) {
            originChecks += 1;
            return pinnedCliResult(
              originChecks < 3
                ? "http://127.0.0.1:3000"
                : "https://outside.example.test",
            );
          }
          if (action === "snapshot --depth=8") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: pinnedCliSnapshotStdout(
                "private outside-origin evidence",
              ),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "{}" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.inspect({ kind: "snapshot" }),
    ).rejects.toMatchObject({
      failureKind: "navigation-outside-demo-origin",
    });
    expect(actions).toEqual([
      "open 'http://127.0.0.1:3000/'",
      "eval '() => location.origin'",
      "eval '() => location.origin'",
      "snapshot --depth=8",
      "eval '() => location.origin'",
      "close",
    ]);
  });

  it("does not transfer a screenshot when the page changes origin during capture", async () => {
    let originChecks = 0;
    let downloads = 0;
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async downloadSubmittedCodeFiles() {
          downloads += 1;
        },
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          if (command.includes(" eval ")) {
            originChecks += 1;
            return pinnedCliResult(
              originChecks < 3
                ? "http://127.0.0.1:3000"
                : "https://outside.example.test",
            );
          }
          return { exitCode: 0, stderr: "", stdout: "{}" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(controller.screenshot()).rejects.toMatchObject({
      failureKind: "navigation-outside-demo-origin",
    });
    expect(downloads).toBe(0);
  });

  it("refreshes its retained stage context and closes the same browser session on reset", async () => {
    const calls: Array<{ command: string; origin: string }> = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command, options) {
          calls.push({
            command,
            origin: options?.env?.PLAYWRIGHT_MCP_ALLOWED_ORIGINS ?? "",
          });
          return {
            exitCode: 0,
            stderr: "",
            stdout: command.includes(" eval ")
              ? pinnedCliResultStdout("http://127.0.0.1:4173")
              : "{}",
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    controller.updateContext({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:4173/app",
    });
    await controller.navigate({ path: "next" });
    await controller.reset();

    expect(readCliActions(calls.map(({ command }) => command))).toEqual([
      "open 'http://127.0.0.1:4173/app'",
      "eval '() => location.origin'",
      "goto 'http://127.0.0.1:4173/next'",
      "eval '() => location.origin'",
      "close",
    ]);
    expect(
      calls
        .filter(({ command }) => command.includes("--json "))
        .every(({ origin }) => origin === "http://127.0.0.1:4173"),
    ).toBe(true);
  });

  it("closes and reopens before using a retained controller at a different authorized origin", async () => {
    const actions: string[] = [];
    let authorizedOrigin = "http://127.0.0.1:3000";
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command, options) {
          const action = readCliAction(command);
          actions.push(action);
          if (action.startsWith("eval ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: pinnedCliResultStdout(authorizedOrigin),
            };
          }
          if (action.startsWith("open ")) {
            authorizedOrigin =
              options?.env?.PLAYWRIGHT_MCP_ALLOWED_ORIGINS ?? authorizedOrigin;
          }
          return {
            exitCode: 0,
            stderr: "",
            stdout: action.startsWith("snapshot")
              ? pinnedCliSnapshotStdout("snapshot")
              : "{}",
          };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await controller.inspect({ kind: "snapshot" });
    controller.updateContext({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:4173/app",
    });
    await controller.inspect({ kind: "snapshot" });

    expect(actions).toEqual([
      "open 'http://127.0.0.1:3000/'",
      "eval '() => location.origin'",
      "eval '() => location.origin'",
      "snapshot --depth=8",
      "eval '() => location.origin'",
      "close",
      "open 'http://127.0.0.1:4173/app'",
      "eval '() => location.origin'",
      "eval '() => location.origin'",
      "snapshot --depth=8",
      "eval '() => location.origin'",
    ]);
  });

  it("cleans up an opened session when the backend origin check itself fails", async () => {
    const actions: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          const action = readCliAction(command);
          actions.push(action);
          return action.startsWith("eval ")
            ? { exitCode: 0, stderr: "", stdout: "not-json" }
            : { exitCode: 0, stderr: "", stdout: '{"result":"ok"}' };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.inspect({ kind: "snapshot" }),
    ).rejects.toMatchObject({
      failureKind: "invalid-cli-output",
      message: "Browser CLI returned invalid JSON.",
    });
    expect(actions).toEqual([
      "open 'http://127.0.0.1:3000/'",
      "eval '() => location.origin'",
      "close",
    ]);
  });

  it("cleans up a maybe-started session and its directory when open output is malformed", async () => {
    const commands: string[] = [];
    const controller = createBrowserToolController({
      deadlineAt: Date.now() + 5_000,
      localUrl: "http://127.0.0.1:3000",
      workspace: {
        async execute() {
          throw new Error("The browser controller must use submitted code.");
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          const action = readCliActionIfPresent(command);
          if (action?.startsWith("open ")) {
            return { exitCode: 0, stderr: "", stdout: "not-json" };
          }
          return { exitCode: 0, stderr: "", stdout: "{}" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test";
        },
        async setOutboundNetworkAccess() {},
        async setSubmittedCodeNetworkAccess() {},
        async uploadFiles() {},
      },
    });

    await expect(
      controller.inspect({ kind: "snapshot" }),
    ).rejects.toMatchObject({
      failureKind: "invalid-cli-output",
    });
    await controller.reset();

    expect(commands.map(readCliActionIfPresent).filter(Boolean)).toEqual([
      "open 'http://127.0.0.1:3000/'",
      "close",
    ]);
    expect(commands).toContainEqual(
      expect.stringMatching(
        /^rm -rf -- '\/tmp\/makeademo-browser-tools\/makeademo-[a-z0-9-]+'$/,
      ),
    );
  });
});

function readCliAction(command: string): string {
  const marker = "--json ";
  const index = command.indexOf(marker);
  if (index < 0) throw new Error(`Missing CLI command: ${command}`);
  return (
    command
      .slice(index + marker.length)
      .split("; makeademo_cli_status=$?")[0]
      ?.split(" > ")[0] ?? ""
  );
}

function readCliActionIfPresent(command: string): string | undefined {
  return command.includes("--json ") ? readCliAction(command) : undefined;
}

function readCliActions(commands: string[]): string[] {
  return commands
    .map(readCliActionIfPresent)
    .filter((action): action is string => action !== undefined);
}

function pinnedCliResult(value: string) {
  return {
    exitCode: 0,
    stderr: "",
    stdout: pinnedCliResultStdout(value),
  };
}

function pinnedCliResultStdout(value: string): string {
  return JSON.stringify({ result: JSON.stringify(value) });
}

function pinnedCliSnapshotStdout(value: string): string {
  return JSON.stringify({ snapshot: value });
}
