import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { submittedCodeKnownGoodNodeReleaseSnapshot } from "../../src/server/pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { resolveSubmittedCodeToolchain as resolveAgainstNodeCatalog } from "../../src/server/pipeline/03-repo-preparation/submitted-code-toolchain.schema";

const execFileAsync = promisify(execFile);
const inspectorPath = new URL(
  "./inspect-submitted-code-toolchain.mjs",
  import.meta.url,
);
const workspaces: string[] = [];

function resolveSubmittedCodeToolchain(
  metadata: Parameters<typeof resolveAgainstNodeCatalog>[0],
) {
  return resolveAgainstNodeCatalog(
    metadata,
    submittedCodeKnownGoodNodeReleaseSnapshot,
  );
}

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

function expectedLockEvidence(contents: string) {
  return {
    kind: "canonical-lockfile",
    prefixBase64: Buffer.from(contents)
      .subarray(0, 64 * 1024)
      .toString("base64"),
    sha256: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    size: Buffer.byteLength(contents),
  };
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
    const lockfile = "# lockfile\n".repeat(8192);
    await writeFile(join(workspace, "pnpm-lock.yaml"), lockfile);

    const stdout = await runInspector(workspace);

    expect(JSON.parse(stdout)).toEqual({
      candidates: [
        {
          files: {
            "package.json": '{"packageManager":"pnpm@10.27.0"}\n',
            "pnpm-lock.yaml": expectedLockEvidence(lockfile),
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
            "pnpm-lock.yaml": expectedLockEvidence("lockfileVersion: '9.0'\n"),
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
            "pnpm-lock.yaml": expectedLockEvidence("lockfileVersion: '9.0'\n"),
          },
          projectRoot: "webapp",
        },
      ],
    });
  });

  it.each([
    {
      expectedGeneration: "pnpm-modern",
      lockfile: "lockfileVersion: '9.0'\npackages:\n  left-pad@1.3.0: {}\n",
      lockfileName: "pnpm-lock.yaml",
      packageManager: "pnpm@10.26.1",
    },
    {
      expectedGeneration: "yarn-classic",
      lockfile: '# yarn lockfile v1\nleft-pad@^1.3.0:\n  version "1.3.0"\n',
      lockfileName: "yarn.lock",
      packageManager: "yarn@1.22.19",
    },
    {
      expectedGeneration: "yarn-berry",
      lockfile:
        "__metadata:\n  version: 8\n  cacheKey: 10c0\n\nleft-pad@npm:^1.3.0:\n  version: 1.3.0\n",
      lockfileName: "yarn.lock",
      packageManager: "yarn@4.11.0",
    },
  ])(
    "feeds non-empty $expectedGeneration evidence from the real inspector into the planner",
    async ({ expectedGeneration, lockfile, lockfileName, packageManager }) => {
      const workspace = await createWorkspace();
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({ packageManager }),
      );
      await writeFile(join(workspace, lockfileName), lockfile);

      const metadata = JSON.parse(await runInspector(workspace));
      const plan = resolveSubmittedCodeToolchain(metadata);

      expect(plan.packageManager).toMatchObject({
        generation: expectedGeneration,
        projectIntegrity: expectedLockEvidence(lockfile).sha256,
      });
    },
  );

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
