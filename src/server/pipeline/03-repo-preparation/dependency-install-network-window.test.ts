import { describe, expect, it } from "vitest";

import {
  runDependencyInstallWithNetworkWindow,
  runPlannedDependencyInstallWithNetworkWindow,
} from "./dependency-install-network-window";
import type { PreparationWorkspace } from "./preparation-workspace.interface";

describe("runDependencyInstallWithNetworkWindow", () => {
  it("unblocks outbound network for a dependency install and blocks it again", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);

    const result = await runDependencyInstallWithNetworkWindow({
      command: "bun install",
      workspace,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "installed" });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it("blocks outbound network again when the install command fails", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events, { exitCode: 1, stderr: "nope" });

    const result = await runDependencyInstallWithNetworkWindow({
      command: "npm install",
      workspace,
    });

    expect(result).toEqual({ exitCode: 1, stderr: "nope", stdout: "" });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:npm install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it("does not fall back to outer workspace execution for dependency install", async () => {
    const workspace = fakeWorkspace([]);
    workspace.execute = async () => {
      throw new Error("outer workspace execution must not run submitted code");
    };

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "pnpm install",
        workspace,
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "installed" });
  });

  it("denies non-install commands without opening submitted-code network", async () => {
    const events: string[] = [];

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "npm run build",
        workspace: fakeWorkspace(events),
      }),
    ).rejects.toThrow(
      "Dependency installation network access is limited to allowlisted package-manager install commands.",
    );

    expect(events).toEqual([]);
  });

  it("surfaces failures when submitted-code network cannot be blocked again", async () => {
    const events: string[] = [];

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "bun install",
        workspace: fakeWorkspace(events, undefined, {
          failNetworkDisable: true,
        }),
      }),
    ).rejects.toThrow("failed to block submitted-code network");

    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
    ]);
  });

  it("blocks submitted-code network again when the closing sandbox log fails", async () => {
    const events: string[] = [];

    const result = await runDependencyInstallWithNetworkWindow({
      command: "bun install",
      workspace: fakeWorkspace(events, undefined, {
        failSandboxLogEvent: "submitted-code-network.closing",
      }),
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "installed" });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it("blocks submitted-code network again when the closing sandbox log never settles", async () => {
    const events: string[] = [];

    const result = runDependencyInstallWithNetworkWindow({
      command: "bun install",
      workspace: fakeWorkspace(events, undefined, {
        neverSettleSandboxLogEvent: "submitted-code-network.closing",
      }),
    });

    await expect(resultWithin(result, 100)).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "installed",
    });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it.each([
    "submitted-code-network.opening",
    "submitted-code-network.opened",
    "submitted-code-network.closed",
  ])(
    "does not let a never-settling %s sandbox log gate install or reseal",
    async (event) => {
      const events: string[] = [];

      const result = runDependencyInstallWithNetworkWindow({
        command: "bun install",
        workspace: fakeWorkspace(events, undefined, {
          neverSettleSandboxLogEvent: event,
        }),
      });

      await expect(resultWithin(result, 100)).resolves.toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "installed",
      });
      expect(events).toContain("submitted-execute:bun install");
      expect(events).toContain("submitted-network:blocked");
    },
  );

  it("blocks submitted-code network again when install execution throws", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);
    workspace.executeSubmittedCode = async (command) => {
      events.push(`submitted-execute:${command}`);
      throw new Error("install exploded");
    };

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "bun install",
        workspace,
      }),
    ).rejects.toThrow("install exploded");

    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it("uses the submitted-code sandbox network window and executor when available", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events, undefined, {
      submittedCode: true,
    });

    const result = await runDependencyInstallWithNetworkWindow({
      command: "pnpm install",
      workspace,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "installed" });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:pnpm install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });
});

describe("runPlannedDependencyInstallWithNetworkWindow", () => {
  it("executes the plan-owned install with exact argv and reseals submitted-code network", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);
    workspace.executeSubmittedProject = async ({ argv, executable, plan }) => {
      events.push(
        `submitted-project:${executable}:${argv.join(",")}:${plan.projectRoot}`,
      );
      return { exitCode: 0, stderr: "", stdout: "planned install completed" };
    };

    const result = await runPlannedDependencyInstallWithNetworkWindow({
      toolchainPlan: {
        catalogRevision: "submitted-js-2026-07-17.1",
        evidence: [],
        install: { argv: ["i", "--frozen-lockfile"], executable: "pnpm" },
        node: { version: "22.23.1" },
        packageManager: { name: "pnpm", version: "10.27.0" },
        projectRoot: "apps/web",
        warnings: [],
      },
      workspace,
    });

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "planned install completed",
    });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-project:pnpm:i,--frozen-lockfile:apps/web",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });
});

function fakeWorkspace(
  events: string[],
  result: { exitCode: number; stderr: string; stdout?: string } = {
    exitCode: 0,
    stderr: "",
    stdout: "installed",
  },
  options: {
    failNetworkDisable?: boolean;
    failSandboxLogEvent?: string;
    neverSettleSandboxLogEvent?: string;
    submittedCode?: boolean;
  } = {},
): PreparationWorkspace {
  const workspace: PreparationWorkspace = {
    async execute(command) {
      events.push(`execute:${command}`);
      return { stdout: "", ...result };
    },
    async executeSubmittedCode(command) {
      events.push(`submitted-execute:${command}`);
      return { stdout: "", ...result };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async setOutboundNetworkAccess(enabled) {
      events.push(enabled ? "network:unblocked" : "network:blocked");
    },
    async setSubmittedCodeNetworkAccess(enabled) {
      events.push(
        enabled ? "submitted-network:unblocked" : "submitted-network:blocked",
      );
      if (!enabled && options.failNetworkDisable === true) {
        throw new Error("failed to block submitted-code network");
      }
    },
    async writeSandboxLog(entry) {
      events.push(`log:${entry.event}`);
      if (entry.event === options.neverSettleSandboxLogEvent) {
        return new Promise<never>(() => {});
      }
      if (entry.event === options.failSandboxLogEvent) {
        throw new Error(`failed to write ${entry.event}`);
      }
    },
    async uploadFiles() {},
  };

  if (options.submittedCode === true) {
    workspace.executeSubmittedCode = async (command) => {
      events.push(`submitted-execute:${command}`);
      return { stdout: "", ...result };
    };
    workspace.setSubmittedCodeNetworkAccess = async (enabled) => {
      events.push(
        enabled ? "submitted-network:unblocked" : "submitted-network:blocked",
      );
    };
  }

  return workspace;
}

function resultWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}
