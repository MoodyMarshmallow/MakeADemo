import { readFile, readdir } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Agent Harness OpenCode dependencies", () => {
  it("keeps Repo Preparation tool vocabulary and payload schemas out of harness production modules", async () => {
    const harnessDirectory = fileURLToPath(new URL("../", import.meta.url));
    const sourceFiles = await readTypeScriptFiles(harnessDirectory);
    const productVocabulary =
      /makeademo_|manifestPath|input\.command|\{\s*command\s*:|command\?:/;
    const violations = await Promise.all(
      sourceFiles.map(async (path) => ({
        path: relative(harnessDirectory, path),
        source: await readFile(path, "utf8"),
      })),
    );

    expect(
      violations
        .filter(({ source }) => productVocabulary.test(source))
        .map(({ path }) => path),
    ).toEqual([]);
  });

  it("does not import Pipeline modules", async () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const source = await readFile(
      `${directory}opencode-agent-session.ts`,
      "utf8",
    );

    expect(source).not.toContain("pipeline/");
  });

  it("constructs production opencode run commands only in the harness command builder", async () => {
    const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const sourceFiles = await readTypeScriptFiles(serverDirectory);
    const commandBuilders = (
      await Promise.all(
        sourceFiles.map(async (path) => ({
          path,
          source: await readFile(path, "utf8"),
        })),
      )
    )
      .filter(({ source }) => source.includes('"opencode run"'))
      .map(({ path }) => relative(serverDirectory, path));

    expect(commandBuilders).toEqual([
      "agent-harness/opencode/opencode-run-command.ts",
    ]);
  });

  it("keeps private OpenCode modules out of production Pipeline modules", async () => {
    const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const pipelineDirectory = `${serverDirectory}pipeline`;
    const sourceFiles = await readTypeScriptFiles(pipelineDirectory);
    const privateOpenCodeImports = (
      await Promise.all(
        sourceFiles.map(async (path) => ({
          path: relative(serverDirectory, path),
          source: await readFile(path, "utf8"),
        })),
      )
    )
      .filter(({ source }) => source.includes("agent-harness/opencode/"))
      .map(({ path }) => path);

    expect(privateOpenCodeImports).toEqual([]);
  });

  it("keeps private harness and Composition imports out of Pipeline tests", async () => {
    const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const pipelineDirectory = `${serverDirectory}pipeline`;
    const sourceFiles = await readTypeScriptFiles(pipelineDirectory, true);
    const forbiddenImports = (
      await Promise.all(
        sourceFiles.map(async (path) => ({
          path: relative(serverDirectory, path),
          source: await readFile(path, "utf8"),
        })),
      )
    )
      .filter(
        ({ path }) => path.endsWith(".test.ts") || path.endsWith(".test.mts"),
      )
      .filter(
        ({ source }) =>
          source.includes("agent-harness/opencode/") ||
          source.includes("composition/"),
      )
      .map(({ path }) => path);

    expect(forbiddenImports).toEqual([]);
  });

  it("keeps Repo Preparation tool runtime definitions provider-neutral", async () => {
    const toolsDirectory = fileURLToPath(
      new URL(
        "../../pipeline/03-repo-preparation/agent-task/tools/",
        import.meta.url,
      ),
    );
    const sourceFiles = await readTypeScriptFiles(toolsDirectory, true);
    const violations = (
      await Promise.all(
        sourceFiles.map(async (path) => ({
          path: relative(toolsDirectory, path),
          source: await readFile(path, "utf8"),
        })),
      )
    )
      .filter(
        ({ path, source }) =>
          path.includes("repo-preparation-tool-") &&
          /[@]opencode-ai\/plugin|tool\.schema|OpenCode/.test(source),
      )
      .map(({ path }) => path);

    expect(violations).toEqual([]);
  });

  it("keeps provider/model selection out of production Pipeline modules", async () => {
    const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const sourceFiles = await readTypeScriptFiles(`${serverDirectory}pipeline`);
    const violations = (
      await Promise.all(
        sourceFiles.map(async (path) => ({
          path: relative(serverDirectory, path),
          source: await readFile(path, "utf8"),
        })),
      )
    )
      .filter(
        ({ source }) =>
          source.includes("agent-model-defaults") ||
          source.includes("AgentSessionProfile"),
      )
      .map(({ path }) => path);

    expect(violations).toEqual([]);
  });

  it("keeps provider-neutral CLI parsing inward from composition", async () => {
    const pipelineOptionsPath = fileURLToPath(
      new URL(
        "../../pipeline/00-orchestration/pre-capture-cli-options.ts",
        import.meta.url,
      ),
    );
    const source = await readFile(pipelineOptionsPath, "utf8");
    expect(source).not.toContain("composition/");
    expect(source).not.toContain("providerID");
    expect(source).not.toContain("modelID");
  });
});

async function readTypeScriptFiles(
  directory: string,
  includeTests = false,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return readTypeScriptFiles(path, includeTests);
      return entry.isFile() &&
        (path.endsWith(".ts") || path.endsWith(".mts")) &&
        (includeTests ||
          (!path.endsWith(".test.ts") && !path.endsWith(".test.mts")))
        ? [path]
        : [];
    }),
  );
  return files.flat();
}
