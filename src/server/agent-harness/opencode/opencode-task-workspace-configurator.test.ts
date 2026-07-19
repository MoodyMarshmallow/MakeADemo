import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createOpenCodeTaskWorkspaceConfigurator } from "./opencode-task-workspace-configurator";

const execFileAsync = promisify(execFile);

describe("createOpenCodeTaskWorkspaceConfigurator", () => {
  it("recreates only its base and scoped task directories with composed files", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-opencode-config-"),
    );
    const configurator = createOpenCodeTaskWorkspaceConfigurator({
      baseConfigFiles: [{ content: "base", path: "opencode.json" }],
      globalToolFiles: [{ content: "global", path: "tools/global.ts" }],
      rootDirectory,
    });
    const baseDirectory = configurator.baseConfigDirectory;
    const taskDirectory =
      configurator.configDirectoryForScope("repo-preparation");

    try {
      await writeFile(join(rootDirectory, "unrelated"), "preserved");
      const command = configurator.createWriteCommand([
        {
          scope: "repo-preparation",
          stageToolFiles: [
            {
              content: "stage",
              path: "plugins/repo-preparation.ts",
            },
          ],
        },
      ]);

      await execFileAsync("zsh", ["-c", command]);

      expect(command).toContain(`rm -rf '${baseDirectory}' '${taskDirectory}'`);
      expect((await readdir(rootDirectory)).sort()).toEqual(
        ["opencode", "opencode-repo-preparation", "unrelated"].sort(),
      );
      expect(await listRelativeFiles(baseDirectory)).toEqual([
        "opencode.json",
        "tools/global.ts",
      ]);
      expect(await listRelativeFiles(taskDirectory)).toEqual([
        "opencode.json",
        "plugins/repo-preparation.ts",
        "tools/global.ts",
      ]);
      await expect(
        readFile(join(baseDirectory, "opencode.json"), "utf8"),
      ).resolves.toBe("base\n");
      await expect(
        readFile(join(taskDirectory, "plugins/repo-preparation.ts"), "utf8"),
      ).resolves.toBe("stage\n");
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("scopes task directories to safe task names", () => {
    const configurator = createOpenCodeTaskWorkspaceConfigurator({
      rootDirectory: "/tmp/makeademo",
    });

    expect(configurator.configDirectoryForScope("script-generation")).toBe(
      "/tmp/makeademo/opencode-script-generation",
    );
    expect(() => configurator.configDirectoryForScope("../outside")).toThrow(
      "OpenCode task scope must use lowercase letters, digits, and hyphens.",
    );
  });
});

async function listRelativeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = entry.name;
    if (entry.isDirectory()) {
      for (const nestedFile of await listRelativeFiles(
        join(directory, entry.name),
      )) {
        files.push(join(relativePath, nestedFile));
      }
      continue;
    }
    files.push(relativePath);
  }
  return files.sort();
}
