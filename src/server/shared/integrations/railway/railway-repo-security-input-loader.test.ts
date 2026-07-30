import { describe, expect, it } from "vitest";

import { readRepoSecurityInputInfrastructureDiagnostic } from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-input-loader.interface";
import { RailwayRepoSecurityInputLoader } from "./railway-repo-security-input-loader";
import type { RailwaySandboxGateway } from "./railway-sandbox-gateway.interface";

describe("RailwayRepoSecurityInputLoader", () => {
  it("runs clone, inventory, and text reads as the unprivileged repository owner with a sealed environment", async () => {
    const commands: string[] = [];
    const loader = new RailwayRepoSecurityInputLoader(
      fakeGateway({ commands, destroy: async () => {} }),
    );

    await loader.load({
      repoUrl: "https://github.com/example/repository",
      shouldReadText: (path) => path === "package.json",
    });

    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command).toContain("| runuser -u 'makeademo' -- env -i");
      expect(command).toContain("HOME='/home/makeademo'");
      expect(command).toContain("TMPDIR='/tmp/makeademo'");
      expect(command).toContain(
        "PATH='/opt/makeademo/capture-runtime/bin:/usr/local/bin:/usr/bin:/bin'",
      );
      expect(command).not.toContain(
        "/opt/makeademo/toolchains/node/versions/22.23.1/bin",
      );
    }
    expect(decodeCommand(commands[0] ?? "")).toContain("git clone");
    expect(decodeCommand(commands[1] ?? "")).toContain("find '/workspace'");
    expect(decodeCommand(commands[2] ?? "")).toBe(
      "cat '/workspace/package.json'",
    );
  });

  it("reports a safe release-settlement diagnostic without replacing successful Repo Security input", async () => {
    const loader = new RailwayRepoSecurityInputLoader(
      fakeGateway({
        destroy: async () =>
          Promise.reject(new Error("token=secret sandbox-id=secret-id")),
      }),
    );

    const failure = await loader
      .load({
        repoUrl: "https://github.com/example/repository",
        shouldReadText: (path) => path === "package.json",
      })
      .catch((error: unknown) => error);

    expect(readRepoSecurityInputInfrastructureDiagnostic(failure)).toEqual({
      phase: "release-settlement",
      provider: "railway",
    });
    expect(String(failure)).not.toContain("secret");
  });
});

function fakeGateway(input: {
  commands?: string[];
  destroy: () => Promise<void>;
}): RailwaySandboxGateway {
  return {
    async createSandbox() {
      return { id: "owned-sandbox" };
    },
    destroySandbox: input.destroy,
    async execute(_sandbox, command) {
      input.commands?.push(command);
      const repositoryCommand = decodeCommand(command);
      const stdout = repositoryCommand.includes("-printf '%P\\t%s\\n'")
        ? "README.md\t7\npackage.json\t10\n"
        : repositoryCommand.includes("cat '/workspace/package.json'")
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

function decodeCommand(command: string): string {
  const encoded = command.match(/^printf %s '([^']+)' \| base64 --decode/);
  return encoded?.[1] === undefined
    ? command
    : Buffer.from(encoded[1], "base64").toString("utf8");
}
