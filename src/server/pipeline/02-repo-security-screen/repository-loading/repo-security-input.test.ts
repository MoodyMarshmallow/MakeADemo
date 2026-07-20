import { describe, expect, it } from "vitest";

import { readRepoSecurityInput } from "./repo-security-input";
import type { RepoSecurityInputLoadInput } from "./repo-security-input-loader.interface";

describe("readRepoSecurityInput", () => {
  it("allows text only for package.json and shell scripts", async () => {
    let receivedInput: RepoSecurityInputLoadInput | undefined;
    const result = await readRepoSecurityInput(
      {
        async load(input) {
          receivedInput = input;
          return {
            files: [
              { path: "package.json", text: '{"name":"app"}' },
              { path: "scripts/start.sh", text: "#!/bin/sh" },
              { path: ".env" },
              { path: "src/app.ts" },
            ],
            repoStats: { fileCount: 4, sizeBytes: 100 },
          };
        },
      },
      "https://github.com/example/app",
      { commitSha: "0123456789abcdef0123456789abcdef01234567" },
    );

    expect(result.repoStats).toEqual({ fileCount: 4, sizeBytes: 100 });
    expect(receivedInput).toMatchObject({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
    });
    expect(receivedInput?.shouldReadText("package.json")).toBe(true);
    expect(receivedInput?.shouldReadText("scripts/start.sh")).toBe(true);
    expect(receivedInput?.shouldReadText(".env")).toBe(false);
    expect(receivedInput?.shouldReadText("apps/web/.env.production")).toBe(
      false,
    );
    expect(receivedInput?.shouldReadText("src/app.ts")).toBe(false);
  });
});
