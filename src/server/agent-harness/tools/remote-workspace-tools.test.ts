import { describe, expect, it, vi } from "vitest";

import { createRemoteCodingToolDefinitions } from "./remote-workspace-tools";

describe("Pi remote workspace tools", () => {
  it("delegates coding tool file operations to the workspace seam", async () => {
    const execute = vi.fn(async (command: string) => ({
      exitCode: 0,
      stderr: "",
      stdout: command.startsWith("realpath")
        ? "/workspace/src/index.ts\n"
        : command.startsWith("base64")
          ? Buffer.from("remote contents").toString("base64")
          : "",
    }));
    const tools = createRemoteCodingToolDefinitions({
      cwd: "/workspace",
      workspace: { execute },
    });
    const read = tools.find((tool) => tool.name === "read");
    if (read === undefined) throw new Error("Expected remote read tool.");

    const result = await read.execute(
      "read-call",
      { path: "src/index.ts" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content[0]).toEqual({
      text: "remote contents",
      type: "text",
    });
    expect(execute).toHaveBeenCalledWith(
      "base64 < '/workspace/src/index.ts'",
      expect.objectContaining({ env: {} }),
    );
  });

  it("runs shell commands in the remote cwd without forwarding backend env", async () => {
    const execute = vi.fn(async (command: string) => ({
      exitCode: 0,
      stderr: "",
      stdout: command.startsWith("realpath") ? "/workspace\n" : "ok",
    }));
    const bash = createRemoteCodingToolDefinitions({
      cwd: "/workspace",
      workspace: { execute },
    }).find((tool) => tool.name === "bash");
    if (bash === undefined) throw new Error("Expected remote bash tool.");

    await bash.execute(
      "bash-call",
      { command: "pwd", timeout: 1_000 },
      undefined,
      undefined,
      {} as never,
    );

    expect(execute).toHaveBeenCalledWith(
      "cd '/workspace' && pwd",
      expect.objectContaining({ env: {}, timeoutMs: 1_000 }),
    );
  });

  it("rejects tool paths outside the workspace root", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
    const tools = createRemoteCodingToolDefinitions({
      cwd: "/workspace",
      workspace: { execute },
    });
    const read = tools.find((tool) => tool.name === "read");
    if (read === undefined) throw new Error("Expected remote read tool.");

    await expect(
      read.execute(
        "bad-path",
        { path: "/etc/passwd" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("inside the Daytona workspace");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a workspace symlink that resolves outside the remote root", async () => {
    const execute = vi.fn(async (command: string) => ({
      exitCode: 0,
      stderr: "",
      stdout: command.startsWith("realpath") ? "/etc/passwd\n" : "",
    }));
    const read = createRemoteCodingToolDefinitions({
      cwd: "/workspace",
      workspace: { execute },
    }).find((tool) => tool.name === "read");
    if (read === undefined) throw new Error("Expected remote read tool.");

    await expect(
      read.execute(
        "symlink-escape",
        { path: "linked-secret" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("symlinks");
    expect(execute).not.toHaveBeenCalledWith(
      expect.stringContaining("base64 <"),
      expect.anything(),
    );
  });

  it("detects common image types without requiring a remote file binary", async () => {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2cWQAAAAASUVORK5CYII=",
      "base64",
    );
    const execute = vi.fn(async (command: string) => ({
      exitCode: 0,
      stderr: "",
      stdout: command.startsWith("realpath")
        ? "/workspace/public/logo.png\n"
        : command.startsWith("base64")
          ? image.toString("base64")
          : "",
    }));
    const read = createRemoteCodingToolDefinitions({
      cwd: "/workspace",
      workspace: { execute },
    }).find((tool) => tool.name === "read");
    if (read === undefined) throw new Error("Expected remote read tool.");

    const result = await read.execute(
      "image-read",
      { path: "public/logo.png" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("image/png");
    }
    expect(execute).not.toHaveBeenCalledWith(
      expect.stringContaining("file --brief"),
      expect.anything(),
    );
  });

  it("does not dispatch a remote command after its signal is aborted", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
    const cancelActiveCommands = vi.fn();
    const bash = createRemoteCodingToolDefinitions({
      cwd: "/workspace",
      workspace: { cancelActiveCommands, execute },
    }).find((tool) => tool.name === "bash");
    if (bash === undefined) throw new Error("Expected remote bash tool.");
    const controller = new AbortController();
    controller.abort();

    await expect(
      bash.execute(
        "aborted",
        { command: "pwd" },
        controller.signal,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    expect(cancelActiveCommands).not.toHaveBeenCalled();
  });
});
