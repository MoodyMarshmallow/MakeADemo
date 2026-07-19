import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRepoPreparationToolRuntimeSource } from "../../pipeline/03-repo-preparation/agent-task/tools/repo-preparation-tool-plugin-source";
import { createRepoPreparationOpenCodeToolFiles } from "./repo-preparation-opencode-tools";

describe("Repo Preparation OpenCode tools", () => {
  it("exposes only the tools owned by Repo Preparation", () => {
    const files = createRepoPreparationOpenCodeToolFiles();
    const toolPlugin = files.find(
      (file) => file.path === "plugins/makeademo-repo-preparation-tools.ts",
    );
    const runtime = files.find(
      (file) => file.path === "repo-preparation-tools-runtime.ts",
    );

    expect(toolPlugin?.content).toContain("@opencode-ai/plugin");
    expect(toolPlugin?.content).toContain("Object.fromEntries");
    expect(runtime?.content).toContain("makeademo_dependency_request_install");
    expect(runtime?.content).toContain("makeademo_validate_preparation");
    expect(runtime?.content).toContain("makeademo_submit_preparation_result");
    expect(runtime?.content).toContain(
      'status === "succeeded" ? { status, manifest }',
    );
    expect(runtime?.content).not.toContain("@opencode-ai/plugin");
    expect(runtime?.content).not.toContain("tool.schema");
  });

  it("keeps Repo Preparation execution rules in the Pipeline runtime module", async () => {
    const source = await readFile(
      join(import.meta.dirname, "repo-preparation-opencode-tools.ts"),
      "utf8",
    );

    expect(source).not.toContain("assertValidationPassed");
    expect(source).not.toContain("preparationManifestPath");
    expect(source).not.toContain("Failed Repo Preparation submissions");
  });

  it("persists canonical arrays for a failed submission with omitted optional fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-repo-tools-"));
    try {
      const paths = {
        dependencyInstallRequestPath: join(root, "dependency.json"),
        preparationManifestPath: join(root, "manifest.json"),
        preparationResultPath: join(root, "result.json"),
        validationRequestPath: join(root, "validation-request.json"),
        validationResultPath: join(root, "validation-result.json"),
      };
      const runtimePath = join(root, "runtime.ts");
      await writeFile(
        runtimePath,
        createRepoPreparationToolRuntimeSource({ artifactPaths: paths }),
        "utf8",
      );
      const runtime = await import(`${runtimePath}?test=${Date.now()}`);
      const submit = runtime.repoPreparationToolDefinitions.find(
        (definition: { name: string }) =>
          definition.name === "makeademo_submit_preparation_result",
      );
      if (submit === undefined) throw new Error("Submit tool is missing.");

      await submit.execute({ args: { blockers: ["x"], status: "failed" } });

      await expect(
        readFile(paths.preparationResultPath, "utf8").then(JSON.parse),
      ).resolves.toEqual({
        assumptions: [],
        blockers: ["x"],
        status: "failed",
        suggestedChanges: [],
      });

      const invalidFailures = [
        { label: "missing blockers", args: { status: "failed" } },
        { label: "empty blockers", args: { blockers: [], status: "failed" } },
        {
          label: "scalar blockers",
          args: { blockers: "x", status: "failed" },
        },
        {
          label: "invalid blocker element",
          args: { blockers: [""], status: "failed" },
        },
        {
          label: "scalar assumptions",
          args: { assumptions: "x", blockers: ["x"], status: "failed" },
        },
        {
          label: "invalid suggested change element",
          args: {
            blockers: ["x"],
            status: "failed",
            suggestedChanges: [1],
          },
        },
      ] as const;
      for (const invalidFailure of invalidFailures) {
        await expect(
          submit.execute({ args: invalidFailure.args }),
          invalidFailure.label,
        ).rejects.toThrow();
      }
      await expect(
        readFile(paths.preparationResultPath, "utf8").then(JSON.parse),
      ).resolves.toEqual({
        assumptions: [],
        blockers: ["x"],
        status: "failed",
        suggestedChanges: [],
      });

      const manifest = {
        demoCommand: "bun run dev",
        url: "http://127.0.0.1:3000",
        workspaceId: "workspace-1",
        assumptions: ["uses local defaults"],
      };
      await writeFile(paths.preparationManifestPath, JSON.stringify(manifest));
      await writeFile(
        paths.validationResultPath,
        JSON.stringify({ status: "succeeded", manifest }),
      );

      await submit.execute({ args: { status: "succeeded" } });

      await expect(
        readFile(paths.preparationResultPath, "utf8").then(JSON.parse),
      ).resolves.toEqual({ status: "succeeded", manifest });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
