import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "../preparation-workspace.interface";
import {
  preparationManifestPath,
  readPreparationManifestFile,
} from "./repo-preparation-artifact-handoff";

describe("readPreparationManifestFile", () => {
  it("rejects an agent-authored manifest beyond its byte bound before parsing", async () => {
    const workspace = {
      async execute() {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `{"padding":"${"x".repeat(256 * 1024)}"}`,
        };
      },
      async uploadFiles() {},
    } satisfies PreparationWorkspace;

    await expect(
      readPreparationManifestFile(workspace, preparationManifestPath),
    ).rejects.toThrow(
      "Preparation manifest file exceeds its 262144 byte bound.",
    );
  });
});
