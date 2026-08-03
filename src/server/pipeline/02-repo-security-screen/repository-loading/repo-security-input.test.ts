import { describe, expect, it } from "vitest";

import { readRepoSecurityInput } from "./repo-security-input";
import type { RepoSecurityInputLoadInput } from "./repo-security-input-loader.interface";

describe("readRepoSecurityInput", () => {
  it("loads the exact pinned parent and scanner reports", async () => {
    let receivedInput: RepoSecurityInputLoadInput | undefined;
    const result = await readRepoSecurityInput(
      {
        async load(input) {
          receivedInput = input;
          return {
            baselineSourceControlledPaths: ["package.json"],
            preparationWorkspace: fakePreparationWorkspaceHandle(),
            repoSecurity: {
              scannerReports: [
                {
                  findingCount: 0,
                  findings: [],
                  omittedFindingCount: 0,
                  scanner: "semgrep",
                  status: "completed",
                  summary: "Semgrep completed without findings.",
                  version: "1.172.0",
                },
              ],
            },
          };
        },
      },
      "https://github.com/example/app",
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        githubInstallationId: "installation-123",
      },
    );

    expect(result.repoSecurity.scannerReports).toHaveLength(1);
    expect(receivedInput).toMatchObject({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      githubInstallationId: "installation-123",
      repoUrl: "https://github.com/example/app",
    });
  });
});

function fakePreparationWorkspaceHandle() {
  return {
    id: "workspace-1",
    async release() {},
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadFiles() {},
    },
  };
}
