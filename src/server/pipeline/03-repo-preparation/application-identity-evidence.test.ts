import { describe, expect, it } from "vitest";

import { createApplicationIdentityBaseline } from "./application-identity-evidence";

describe("Application Identity evidence", () => {
  it("builds a deterministic content-addressed UI identity index from pinned source paths", () => {
    const sourceControlledPaths = [
      "src/features/invoices/index.tsx",
      "package.json",
      "apps/web/app/dashboard/page.tsx",
      "src/App.tsx",
      "src/components/navigation/sidebar.tsx",
      "apps/web/app/layout.tsx",
    ];

    const baseline = createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths,
      sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
    });
    const reordered = createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: [...sourceControlledPaths].reverse(),
      sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
    });

    expect(baseline.uiIdentityIndex.entries).toEqual([
      {
        path: "apps/web/app/dashboard/page.tsx",
        roles: ["route", "ui-source"],
      },
      {
        path: "apps/web/app/layout.tsx",
        roles: ["layout", "ui-source"],
      },
      { path: "package.json", roles: ["source-path"] },
      { path: "src/App.tsx", roles: ["ui-root", "ui-source"] },
      {
        path: "src/components/navigation/sidebar.tsx",
        roles: ["navigation-shell", "ui-source"],
      },
      {
        path: "src/features/invoices/index.tsx",
        roles: ["feature-root", "ui-source"],
      },
    ]);
    expect(baseline.uiIdentityIndex).toMatchObject({
      entryCount: sourceControlledPaths.length,
      indexSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(reordered).toEqual(baseline);
  });

  it("binds the UI identity digest to the pinned source tree content", () => {
    const first = createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: ["src/App.tsx"],
      sourceTreeObjectId: "a".repeat(40),
    });
    const second = createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: ["src/App.tsx"],
      sourceTreeObjectId: "b".repeat(40),
    });

    expect(first.uiIdentityIndex.indexSha256).not.toBe(
      second.uiIdentityIndex.indexSha256,
    );
  });
});
