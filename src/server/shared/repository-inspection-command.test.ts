import { describe, expect, it } from "vitest";

import { canonicalizeReadOnlyCommand } from "./repository-inspection-command";

describe("repository inspection command", () => {
  it("pins Git source reads to an explicit full object ID", () => {
    expect(
      canonicalizeReadOnlyCommand({
        argv: [
          "git",
          "show",
          "0123456789abcdef0123456789abcdef01234567:src/app/page.tsx",
        ],
      }),
    ).toEqual({
      argv: [
        "git",
        "--no-replace-objects",
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--format=",
        "0123456789abcdef0123456789abcdef01234567:src/app/page.tsx",
      ],
    });
  });

  it.each([
    "main:src/app/page.tsx",
    "HEAD~1:src/app/page.tsx",
    "0123456789abcdef0123456789abcdef01234567:.git/config",
    "0123456789abcdef0123456789abcdef01234567:../outside",
  ])("rejects an unpinned or unsafe Git source read: %s", (objectPath) => {
    expect(() =>
      canonicalizeReadOnlyCommand({ argv: ["git", "show", objectPath] }),
    ).toThrow();
  });
});
