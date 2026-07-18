import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const inspectorPath = new URL(
  "./inspect-submitted-code-toolchain.mjs",
  import.meta.url,
);
const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(
    join(tmpdir(), "makeademo-toolchain-inspector-"),
  );
  workspaces.push(workspace);
  return workspace;
}

async function runInspector(workspace: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [inspectorPath.pathname],
    { cwd: workspace },
  );
  return stdout;
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { force: true, recursive: true })),
  );
});

describe("submitted-code toolchain inspector CLI", () => {
  it("accepts a large regular root pnpm lockfile as bounded presence evidence", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "package.json"),
      '{"packageManager":"pnpm@10.27.0"}\n',
    );
    await writeFile(
      join(workspace, "pnpm-lock.yaml"),
      "# lockfile\n".repeat(8192),
    );

    const stdout = await runInspector(workspace);

    expect(JSON.parse(stdout)).toEqual({
      candidates: [
        {
          files: {
            "package.json": '{"packageManager":"pnpm@10.27.0"}\n',
            "pnpm-lock.yaml": "",
          },
          projectRoot: ".",
        },
      ],
    });
  });

  it("uses a valid root package without traversing over-budget nested fanout", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "package.json"),
      '{"packageManager":"pnpm@11.13.0"}\n',
    );
    await writeFile(
      join(workspace, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        mkdir(join(workspace, `nested-${index}`)),
      ),
    );

    expect(JSON.parse(await runInspector(workspace))).toEqual({
      candidates: [
        {
          files: {
            "package.json": '{"packageManager":"pnpm@11.13.0"}\n',
            "pnpm-lock.yaml": "",
          },
          projectRoot: ".",
        },
      ],
    });
  });

  it("rejects a symlinked lockfile", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "package.json"), "{}\n");
    const target = join(workspace, "lockfile-target");
    await writeFile(target, "lockfile\n");
    await symlink(target, join(workspace, "pnpm-lock.yaml"));

    await expect(runInspector(workspace)).rejects.toThrow(
      "unsafe toolchain metadata file: ./pnpm-lock.yaml",
    );
  });

  it("rejects a symlinked root package instead of falling back to nested discovery", async () => {
    const workspace = await createWorkspace();
    const target = join(workspace, "package-target.json");
    await writeFile(target, "{}\n");
    await symlink(target, join(workspace, "package.json"));

    await expect(runInspector(workspace)).rejects.toThrow(
      "unsafe toolchain metadata file: ./package.json",
    );
  });

  it("rejects oversized metadata whose contents are parsed", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "package.json"), "x".repeat(64 * 1024 + 1));

    await expect(runInspector(workspace)).rejects.toThrow(
      "unsafe toolchain metadata file: ./package.json",
    );
  });

  it("does not follow a project directory symlink outside the workspace", async () => {
    const workspace = await createWorkspace();
    const outsideWorkspace = await createWorkspace();
    await writeFile(join(outsideWorkspace, "package.json"), "{}\n");
    await symlink(outsideWorkspace, join(workspace, "linked-project"));

    expect(JSON.parse(await runInspector(workspace))).toEqual({
      candidates: [],
    });
  });

  it("discovers a sole bounded nested JavaScript project when root has no package", async () => {
    const workspace = await createWorkspace();
    const webapp = join(workspace, "webapp");
    await mkdir(webapp);
    await writeFile(
      join(webapp, "package.json"),
      '{"packageManager":"pnpm@10.27.0"}\n',
    );
    await writeFile(join(webapp, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(JSON.parse(await runInspector(workspace))).toEqual({
      candidates: [
        {
          files: {
            "package.json": '{"packageManager":"pnpm@10.27.0"}\n',
            "pnpm-lock.yaml": "",
          },
          projectRoot: "webapp",
        },
      ],
    });
  });

  it("fails early when directory fanout exceeds the bounded traversal budget", async () => {
    const workspace = await createWorkspace();
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        mkdir(join(workspace, `entry-${index}`)),
      ),
    );

    await expect(runInspector(workspace)).rejects.toThrow(
      "toolchain inspection traversal budget exceeded",
    );
  });
});
