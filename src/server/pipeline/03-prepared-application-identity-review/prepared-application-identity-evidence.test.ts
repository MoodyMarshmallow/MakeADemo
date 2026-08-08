import { describe, expect, it } from "vitest";

import {
  createApplicationIdentityBaseline,
  createPreparedWorkspaceDiff,
} from "../03-repo-preparation/application-identity-evidence";
import { createPreparedApplicationIdentityEvidenceLedger } from "./prepared-application-identity-evidence";

describe("Prepared Application Identity evidence ledger", () => {
  it("accepts a full 64-character pinned Git object ID", () => {
    expect(() =>
      createPreparedApplicationIdentityEvidenceLedger({
        applicationIdentityBaseline: createApplicationIdentityBaseline({
          pinnedRevision: "a".repeat(64),
          repoUrl: "https://github.com/example/app",
          sourceControlledPaths: ["src/app/page.tsx"],
          sourceTreeObjectId: "b".repeat(64),
        }),
        evidence: [],
        mockedBoundaries: [],
        preparedWorkspaceDiff: createPreparedWorkspaceDiff({
          createdPaths: [],
          deletedPaths: [],
          modifiedPaths: [],
          patch: "",
        }),
      }),
    ).not.toThrow();
  });

  it("rejects a structurally forged diff beyond the backend 8 MiB bound", () => {
    expect(() =>
      createPreparedApplicationIdentityEvidenceLedger({
        applicationIdentityBaseline: createApplicationIdentityBaseline({
          pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
          repoUrl: "https://github.com/example/app",
          sourceControlledPaths: ["src/app/page.tsx"],
          sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
        }),
        evidence: [],
        mockedBoundaries: [],
        preparedWorkspaceDiff: {
          artifactId: `workspace-diff:sha256:${"0".repeat(64)}`,
          createdPaths: [],
          deletedPaths: [],
          modifiedPaths: [],
          patch: "x".repeat(8 * 1024 * 1024 + 1),
          patchSha256: "0".repeat(64),
          sizeBytes: 8 * 1024 * 1024 + 1,
        },
      }),
    ).toThrow("content bound");
  });
});
