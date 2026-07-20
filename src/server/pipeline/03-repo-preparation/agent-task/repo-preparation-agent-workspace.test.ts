import { describe, expect, it, vi } from "vitest";

import type { PreparationWorkspace } from "../preparation-workspace.interface";
import { createRepoPreparationAgentWorkspace } from "./repo-preparation-agent-workspace";

function createWorkspace(): PreparationWorkspace & {
  execute: ReturnType<typeof vi.fn>;
  executeAgentCommand: ReturnType<typeof vi.fn>;
} {
  return {
    cancelActiveCommands: vi.fn(),
    execute: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "ok" })),
    executeAgentCommand: vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "ok",
    })),
    getPreviewUrl: vi.fn(),
    setOutboundNetworkAccess: vi.fn(),
    uploadFiles: vi.fn(),
  };
}

describe("createRepoPreparationAgentWorkspace", () => {
  it("retains one agent workspace adapter across pipeline stages", async () => {
    const underlying = createWorkspace();
    const workspaces = [
      "repo-preparation",
      "script-generation",
      "capture-path-repair",
      "draft-composite-review",
    ].map(() => createRepoPreparationAgentWorkspace(underlying));

    for (const [index, workspace] of workspaces.entries()) {
      await workspace.execute(`agent-stage-${index}`, {
        env: {},
        timeoutMs: 1_000,
      });
    }

    expect(new Set(workspaces)).toHaveLength(1);
    expect(underlying.executeAgentCommand).toHaveBeenCalledTimes(4);
    expect(underlying.execute).not.toHaveBeenCalled();
  });

  it("allows ordinary /workspace commands and preserves their output", async () => {
    const underlying = createWorkspace();
    const workspace = createRepoPreparationAgentWorkspace(underlying);

    await expect(
      workspace.execute("cat /workspace/package.json", {
        env: {},
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
    expect(underlying.executeAgentCommand).toHaveBeenCalledWith(
      "cat /workspace/package.json",
      expect.not.objectContaining({ env: expect.anything() }),
    );
    expect(underlying.execute).not.toHaveBeenCalled();
  });

  it("does not treat shell paths as an authorization boundary", async () => {
    const underlying = createWorkspace();
    const workspace = createRepoPreparationAgentWorkspace(underlying);

    const result = await workspace.execute(
      "ln -s /workspace/.makeademo/preparation-manifest.json /tmp/makeademo/submitted-code/validation-result.json",
      { env: {}, timeoutMs: 1_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(underlying.executeAgentCommand).toHaveBeenCalledWith(
      "ln -s /workspace/.makeademo/preparation-manifest.json /tmp/makeademo/submitted-code/validation-result.json",
      expect.not.objectContaining({ env: expect.anything() }),
    );
  });

  it("forwards direct dependency installs without opening the network gate", async () => {
    const underlying = createWorkspace();
    const workspace = createRepoPreparationAgentWorkspace(underlying);

    const result = await workspace.execute("npm ci --ignore-scripts", {
      env: {},
      timeoutMs: 1_000,
    });

    expect(result.exitCode).toBe(0);
    expect(underlying.executeAgentCommand).toHaveBeenCalledWith(
      "npm ci --ignore-scripts",
      expect.not.objectContaining({ env: expect.anything() }),
    );
    expect(underlying.execute).not.toHaveBeenCalled();
    expect(underlying.setOutboundNetworkAccess).not.toHaveBeenCalled();
  });

  it("preserves workspace method receivers for cancellation and audit logging", async () => {
    const underlying = {
      ...createWorkspace(),
      async cancelActiveCommands() {
        expect(this).toBe(underlying);
      },
      async writeSandboxLog() {
        expect(this).toBe(underlying);
      },
    };
    const workspace = createRepoPreparationAgentWorkspace(underlying);

    await workspace.cancelActiveCommands?.();
    await workspace.writeSandboxLog?.({ event: "test" });
  });
});
