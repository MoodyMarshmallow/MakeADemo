import { describe, expect, it } from "vitest";

import { runPlannedDependencyInstallWithNetworkWindow } from "./dependency-install-network-window";
import type { PreparationWorkspace } from "./preparation-workspace.interface";
import { resolveSubmittedCodeToolchain } from "./submitted-code-toolchain.schema";

describe("runPlannedDependencyInstallWithNetworkWindow", () => {
  it("executes only catalog-owned argv and reseals submitted-code network", async () => {
    const events: string[] = [];
    const workspace: PreparationWorkspace = {
      async execute() {
        throw new Error(
          "outer workspace execution must not run submitted code",
        );
      },
      async executeSubmittedProject({ argv, executable, plan }) {
        events.push(
          `submitted-project:${executable}:${argv.join(",")}:${plan.projectRoot}`,
        );
        return { exitCode: 0, stderr: "", stdout: "planned install completed" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async setOutboundNetworkAccess() {},
      async setSubmittedCodeNetworkAccess(enabled) {
        events.push(
          enabled ? "submitted-network:unblocked" : "submitted-network:blocked",
        );
      },
      async uploadFiles() {},
      async writeSandboxLog(entry) {
        events.push(`log:${entry.event}`);
      },
    };

    const result = await runPlannedDependencyInstallWithNetworkWindow({
      toolchainPlan: resolveSubmittedCodeToolchain({
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { node: "22" },
                packageManager: "pnpm@10.27.0",
              }),
              "pnpm-lock.yaml": "",
            },
            projectRoot: ".",
          },
        ],
      }),
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
      "submitted-project:pnpm:i,--frozen-lockfile:.",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it("reseals the network when planned install fails or throws", async () => {
    for (const outcome of ["nonzero", "throws"] as const) {
      const events: string[] = [];
      const workspace = plannedWorkspace(events, outcome);

      if (outcome === "throws") {
        await expect(
          runPlannedDependencyInstallWithNetworkWindow({
            toolchainPlan: supportedPlan(),
            workspace,
          }),
        ).rejects.toThrow("planned install exploded");
      } else {
        await expect(
          runPlannedDependencyInstallWithNetworkWindow({
            toolchainPlan: supportedPlan(),
            workspace,
          }),
        ).resolves.toMatchObject({ exitCode: 42 });
      }

      expect(events).toContain("submitted-network:blocked");
    }
  });

  it("reseals planned network access when audit log writes fail or hang", async () => {
    for (const outcome of ["log-fails", "log-hangs"] as const) {
      const events: string[] = [];
      await expect(
        runPlannedDependencyInstallWithNetworkWindow({
          toolchainPlan: supportedPlan(),
          workspace: plannedWorkspace(events, outcome),
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(events).toContain("submitted-network:blocked");
    }
  });

  it("surfaces a planned network reseal failure", async () => {
    const events: string[] = [];
    const auditEntries: Array<Record<string, unknown>> = [];
    const workspace = plannedWorkspace(events, "reseal-fails");
    workspace.writeSandboxLog = async (entry) => {
      auditEntries.push(entry);
    };
    await expect(
      runPlannedDependencyInstallWithNetworkWindow({
        toolchainPlan: supportedPlan(),
        workspace,
      }),
    ).rejects.toThrow("could not be resealed");
    expect(events).toContain("submitted-network:blocked");
    expect(auditEntries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "submitted-code-network.closed" }),
      ]),
    );
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "submitted-code-network.reseal-failed",
          level: "error",
          reason: "dependency-install",
          resealAttempts: 2,
        }),
      ]),
    );
    expect(JSON.stringify(auditEntries)).not.toContain("reseal failed");
  });

  it("retries one failed reseal before reporting the network window closed", async () => {
    const events: string[] = [];
    const workspace = plannedWorkspace(events, "nonzero");
    let closeAttempts = 0;
    workspace.setSubmittedCodeNetworkAccess = async (enabled) => {
      events.push(
        enabled ? "submitted-network:unblocked" : "submitted-network:blocked",
      );
      if (!enabled && closeAttempts++ === 0)
        throw new Error("transient reseal");
    };

    await expect(
      runPlannedDependencyInstallWithNetworkWindow({
        toolchainPlan: supportedPlan(),
        workspace,
      }),
    ).resolves.toMatchObject({ exitCode: 42 });
    expect(
      events.filter((event) => event === "submitted-network:blocked"),
    ).toHaveLength(2);
  });

  it("attempts reseal when enabling network partially fails", async () => {
    const events: string[] = [];
    const workspace = plannedWorkspace(events, "nonzero");
    let enableAttempts = 0;
    workspace.setSubmittedCodeNetworkAccess = async (enabled) => {
      events.push(
        enabled ? "submitted-network:unblocked" : "submitted-network:blocked",
      );
      if (enabled && enableAttempts++ === 0)
        throw new Error("enable partially failed");
    };

    await expect(
      runPlannedDependencyInstallWithNetworkWindow({
        toolchainPlan: supportedPlan(),
        workspace,
      }),
    ).rejects.toThrow("enable partially failed");
    expect(events).toContain("submitted-network:blocked");
  });
});

function supportedPlan() {
  return resolveSubmittedCodeToolchain({
    candidates: [
      {
        files: {
          "package.json": JSON.stringify({
            engines: { node: "22" },
            packageManager: "pnpm@10.27.0",
          }),
          "pnpm-lock.yaml": "",
        },
        projectRoot: ".",
      },
    ],
  });
}

function plannedWorkspace(
  events: string[],
  outcome: "log-fails" | "log-hangs" | "nonzero" | "reseal-fails" | "throws",
): PreparationWorkspace {
  return {
    async execute() {
      throw new Error("outer workspace execution must not run submitted code");
    },
    async executeSubmittedProject() {
      events.push("planned-install");
      if (outcome === "throws") throw new Error("planned install exploded");
      return {
        exitCode: outcome === "nonzero" ? 42 : 0,
        stderr: "",
        stdout: "",
      };
    },
    async getPreviewUrl() {
      return "https://preview.example.test";
    },
    async setOutboundNetworkAccess() {},
    async setSubmittedCodeNetworkAccess(enabled) {
      events.push(
        enabled ? "submitted-network:unblocked" : "submitted-network:blocked",
      );
      if (!enabled && outcome === "reseal-fails")
        throw new Error("reseal failed");
    },
    async uploadFiles() {},
    async writeSandboxLog() {
      if (outcome === "log-fails") throw new Error("audit log failed");
      if (outcome === "log-hangs") await new Promise(() => {});
    },
  };
}
