import { describe, expect, it } from "vitest";

import { createRailwayProductionSandboxProvider } from "./railway-production-sandbox-provider";
import { railwayProductionTemplateRecipe } from "./railway-production-template-recipe";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";

describe("Railway production sandbox provider", () => {
  it("builds every Pipeline sandbox seam around the selected Railway gateway without exposing credentials", async () => {
    const events: unknown[] = [];
    const provider = createRailwayProductionSandboxProvider(
      {
        environmentId: "environment-id",
        projectToken: "sensitive-project-token",
      },
      { gateway: fakeGateway(events) },
    );

    expect(Object.keys(provider).sort()).toEqual([
      "createSandboxRunner",
      "prepareFreshCaptureState",
      "repoPreparationWorkspaceProvider",
      "repoSecurityInputLoader",
    ]);
    expect(
      provider.createSandboxRunner({ releaseWorkspaceOnCleanup: false }),
    ).toBeDefined();

    const input = await provider.repoSecurityInputLoader.load({
      repoUrl: "https://github.com/example/repository",
      shouldReadText: (path) => path === "package.json",
    });

    expect(input).toEqual({
      files: [
        { path: "README.md" },
        { path: "package.json", text: '{"name":"demo"}\n' },
      ],
      repoStats: { fileCount: 2, sizeBytes: 17 },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        create: expect.objectContaining({
          env: {},
          networkIsolation: "ISOLATED",
        }),
      }),
    );
    expect(events).toContainEqual({ destroy: "repo-security" });
    expect(JSON.stringify(events)).not.toContain("sensitive-project-token");
  });

  it("keeps capture Bun and playwright-cli as separate immutable template capabilities", () => {
    expect(railwayProductionTemplateRecipe.revision).toBe(
      "makeademo-railway-pipeline-v2",
    );
    const commands = railwayProductionTemplateRecipe.commands.join("\n");
    expect(commands).toContain("bun-v1.2.22");
    expect(commands).toContain(
      "https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.2.22",
    );
    expect(commands).toContain("sha256sum");
    expect(commands).not.toContain("bun.sh/install");
    expect(commands).toContain("cli-0.1.17.tgz");
    expect(commands).toContain(
      "541c3acb7a7c7aa3aa9a32a0d3b2245923c6289929221311343148e83398b030fa7c07dc2355d811630b5b2852650d01fce73628de3d7aae17a84eb83d43c706",
    );
    expect(commands).not.toContain("npm install --prefix");
    expect(railwayProductionTemplateRecipe.commands.join("\n")).toContain(
      "/opt/makeademo/capture-runtime/bin/playwright-cli",
    );
  });
});

function fakeGateway(events: unknown[]): RailwaySandboxGateway {
  return {
    async createSandbox(options) {
      events.push({ create: options });
      return { id: "repo-security" };
    },
    async destroySandbox(sandbox) {
      events.push({ destroy: sandbox.id });
    },
    async execute(sandbox, command) {
      events.push({ execute: { command, id: sandbox.id } });
      const stdout = command.includes("-printf '%P\\t%s\\n'")
        ? "README.md\t7\npackage.json\t10\n"
        : command.includes("cat '/workspace/package.json'")
          ? '{"name":"demo"}\n'
          : "";
      return {
        async kill() {},
        async result() {
          return {
            exitCode: 0,
            stderr: "",
            stdout,
            timedOut: false,
            truncated: false,
          };
        },
      };
    },
    async readFile() {
      return new ReadableStream<Uint8Array>();
    },
    async writeFile() {},
  };
}
