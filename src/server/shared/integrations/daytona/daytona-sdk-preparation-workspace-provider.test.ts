import { execFile, spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import {
  SubmittedCodeToolchainRepairRequiredError,
  provisionSubmittedCodeToolchain,
} from "../../../pipeline/03-repo-preparation/submitted-code-execution";
import { submittedCodeKnownGoodNodeReleaseSnapshot } from "../../../pipeline/03-repo-preparation/submitted-code-node-release-catalog.interface";
import { resolveSubmittedCodeToolchain as resolveAgainstNodeCatalog } from "../../../pipeline/03-repo-preparation/submitted-code-toolchain.schema";
import { submittedRuntimeIdentityMarker } from "../../submitted-runtime-launch-identity";
import {
  DaytonaSdkPreparationWorkspaceProvider,
  createDaytonaSdkPreparationWorkspaceHandle,
} from "./daytona-sdk-preparation-workspace-provider";

const execFileAsync = promisify(execFile);

function resolveSubmittedCodeToolchain(
  metadata: Parameters<typeof resolveAgainstNodeCatalog>[0],
) {
  return resolveAgainstNodeCatalog(
    metadata,
    submittedCodeKnownGoodNodeReleaseSnapshot,
  );
}

function supportedPnpmMetadata(projectRoot: string) {
  return {
    candidates: [
      {
        files: {
          "package.json": JSON.stringify({
            engines: { node: "22" },
            packageManager: "pnpm@11.13.0",
          }),
          "pnpm-lock.yaml": "",
        },
        projectRoot,
      },
    ],
  };
}

async function provisionToolchainForSubmittedCodeSync(
  handle: PreparationWorkspaceHandle,
): Promise<{
  plan: ReturnType<typeof resolveSubmittedCodeToolchain>;
}> {
  const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));
  if (handle.workspace.provisionSubmittedCodeToolchain === undefined) {
    throw new Error("submitted-code toolchain provisioning is unavailable");
  }
  await handle.workspace.provisionSubmittedCodeToolchain(plan);
  return { plan };
}

function hydrationAttestationStdout(): string {
  return [
    `MAKEADEMO_UPSTREAM_SRI=sha512-${Buffer.alloc(64).toString("base64")}`,
    `MAKEADEMO_ARTIFACT_SHA512=${"a".repeat(128)}`,
    "",
  ].join("\n");
}

function bunHydrationAttestationStdout(): string {
  return [
    `MAKEADEMO_UPSTREAM_SHA256=${"b".repeat(64)}`,
    `MAKEADEMO_ARTIFACT_SHA256=${"b".repeat(64)}`,
    "",
  ].join("\n");
}

function nodeRuntimeAttestationStdout(version: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    version,
    archiveSha256: "c".repeat(64),
    nodeBinarySha256: "d".repeat(64),
    signedManifestSha256: "e".repeat(64),
    signerPrimaryFingerprint: "F".repeat(40),
  });
}

function trustedNodeProvisionAttestation(script: string): string | undefined {
  if (
    !script.includes("makeademo-provision-submitted-node-runtime provision")
  ) {
    return undefined;
  }
  const version = /\bprovision[^0-9]+([0-9]+\.[0-9]+\.[0-9]+)/.exec(
    script,
  )?.[1];
  return version === undefined
    ? undefined
    : nodeRuntimeAttestationStdout(version);
}

describe("DaytonaSdkPreparationWorkspaceProvider", () => {
  it("creates the primary sandbox with network access enabled", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      snapshot: "makeademo-opencode",
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls[0]).toEqual({
      create: {
        autoDeleteInterval: -1,
        autoStopInterval: 15,
        disk: 3,
        networkBlockAll: false,
        snapshot: "makeademo-opencode",
      },
    });
  });

  it("creates the submitted-code sandbox only when the approved toolchain is provisioned", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });

    const handle = await provider.create();

    expect(calls).not.toContainEqual(
      expect.objectContaining({
        create: expect.objectContaining({
          snapshot: "makeademo-submitted-code",
        }),
      }),
    );
    await provisionToolchainForSubmittedCodeSync(handle);

    expect(calls).toContainEqual({
      create: {
        autoDeleteInterval: -1,
        networkBlockAll: false,
        snapshot: "makeademo-submitted-code",
        user: "root",
      },
    });
  });

  it("deletes an unapproved parent without archiving it", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });

    const handle = await provider.create();
    await handle.discard?.();

    expect(calls).toContainEqual({ delete: "parent_sandbox" });
    expect(calls).not.toContainEqual({ stop: "parent_sandbox" });
    expect(calls).not.toContainEqual({ archive: "parent_sandbox" });
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        create: expect.objectContaining({
          snapshot: "makeademo-submitted-code",
        }),
      }),
    );
  });

  it("deletes an ID-less primary sandbox before rejecting creation", async () => {
    const calls: unknown[] = [];
    const { id: _id, ...sandbox } = fakeLinkedSandbox(
      calls,
      "primary_sandbox",
      "ok",
    );
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          return sandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      },
    });

    await expect(provider.create()).rejects.toThrow(
      "Daytona did not return a sandbox id.",
    );
    expect(calls).toContainEqual({ delete: undefined });
    expect(calls).not.toContainEqual({ stop: "primary_sandbox" });
    expect(calls).not.toContainEqual({ archive: "primary_sandbox" });
  });

  it("uses a bounded Daytona sandbox create timeout", async () => {
    const calls: unknown[] = [];
    const sandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown, options?: unknown) {
          calls.push({ create: input, options });
          return sandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      } as never,
      sandboxCreateTimeoutSeconds: 180,
    });

    await provider.create();

    expect(calls[0]).toEqual({
      create: {
        autoDeleteInterval: -1,
        autoStopInterval: 15,
        disk: 3,
        networkBlockAll: false,
      },
      options: { timeout: 180 },
    });
  });

  it("retries transient Daytona connection failures while creating a sandbox", async () => {
    const calls: unknown[] = [];
    const sandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown, options?: unknown) {
          calls.push({ create: input, options });
          if (calls.filter((call) => "create" in Object(call)).length === 1) {
            const error = new Error("ECONNREFUSED");
            error.name = "DaytonaConnectionError";
            throw error;
          }

          return sandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      } as never,
      sandboxCreateTimeoutSeconds: 180,
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls.slice(0, 2)).toEqual([
      {
        create: {
          autoDeleteInterval: -1,
          autoStopInterval: 15,
          disk: 3,
          networkBlockAll: false,
        },
        options: { timeout: 180 },
      },
      {
        create: {
          autoDeleteInterval: -1,
          autoStopInterval: 15,
          disk: 3,
          networkBlockAll: false,
        },
        options: { timeout: 180 },
      },
    ]);
  });

  it("uploads screened workspace files with abortable Daytona fs.uploadFileStream", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
    ]);

    expect(calls[1]).toEqual({
      uploadFileStream: {
        remotePath: "/workspace/package.json",
        source: "/tmp/repo/package.json",
        options: {},
      },
    });
  });

  it("passes upload cancellation and timeout options to Daytona fs.uploadFileStream", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();
    const controller = new AbortController();

    await handle.workspace.uploadFiles(
      [
        {
          destinationPath: "/workspace/.makeademo/draft-review/draft.mp4",
          sourcePath: "/tmp/draft.mp4",
        },
      ],
      { signal: controller.signal, timeoutMs: 25 },
    );

    expect(calls[1]).toEqual({
      uploadFileStream: {
        remotePath: "/workspace/.makeademo/draft-review/draft.mp4",
        source: "/tmp/draft.mp4",
        options: { signal: controller.signal, timeout: 1 },
      },
    });
  });

  it("downloads captured workspace artifacts with Daytona fs.downloadFiles", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.downloadFiles?.([
      {
        destinationPath: "/tmp/capture/scene.webm",
        sourcePath: "/workspace/.makeademo/capture/scene.webm",
      },
    ]);

    expect(calls[1]).toEqual({
      downloadFiles: {
        files: [
          {
            destination: "/tmp/capture/scene.webm",
            source: "/workspace/.makeademo/capture/scene.webm",
          },
        ],
        timeoutSec: 0,
      },
    });
  });

  it("streams a bounded submitted-code download with cancellation and timeout options", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        downloadStreamChunks: [Buffer.from("1234"), Buffer.from("5678")],
      }),
    });
    const handle = await provider.create();
    const directory = await mkdtemp(join(tmpdir(), "makeademo-stream-"));
    const destinationPath = join(directory, "screenshot.png");
    const controller = new AbortController();

    try {
      await handle.workspace.downloadSubmittedCodeFiles?.(
        [{ destinationPath, sourcePath: "/workspace/screenshot.png" }],
        { maxBytes: 8, signal: controller.signal, timeoutMs: 25 },
      );

      expect(await readFile(destinationPath, "utf8")).toBe("12345678");
      expect(calls).toContainEqual({
        downloadFileStream: {
          options: expect.objectContaining({
            onProgress: expect.any(Function),
            signal: expect.any(AbortSignal),
            timeout: 1,
          }),
          sandbox: "sandbox_123",
          sourcePath: "/workspace/screenshot.png",
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates the local parent directory before streaming a bounded download", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        downloadStreamChunks: [Buffer.from("screenshot")],
      }),
    });
    const handle = await provider.create();
    const directory = await mkdtemp(join(tmpdir(), "makeademo-stream-parent-"));
    const destinationPath = join(directory, "nested", "screenshot.png");

    try {
      await handle.workspace.downloadSubmittedCodeFiles?.(
        [{ destinationPath, sourcePath: "/workspace/screenshot.png" }],
        { maxBytes: 32, timeoutMs: 25 },
      );

      expect(await readFile(destinationPath, "utf8")).toBe("screenshot");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("aborts a submitted-code stream before writing beyond its byte cap", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        downloadStreamChunks: [Buffer.from("1234"), Buffer.from("56789")],
      }),
    });
    const handle = await provider.create();
    const directory = await mkdtemp(join(tmpdir(), "makeademo-stream-cap-"));

    try {
      await expect(
        handle.workspace.downloadSubmittedCodeFiles?.(
          [
            {
              destinationPath: join(directory, "screenshot.png"),
              sourcePath: "/workspace/screenshot.png",
            },
          ],
          { maxBytes: 8, timeoutMs: 25 },
        ),
      ).rejects.toThrow("exceeded 8 bytes");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails when Daytona cannot download a captured workspace artifact", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { downloadError: "missing file" }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.downloadFiles?.([
        {
          destinationPath: "/tmp/capture/scene.webm",
          sourcePath: "/workspace/.makeademo/capture/scene.webm",
        },
      ]),
    ).rejects.toThrow(
      "Failed to download Daytona sandbox file /workspace/.makeademo/capture/scene.webm: missing file",
    );
  });

  it("uploads workspace artifacts to the Daytona workspace", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/.makeademo/capture/script.ts",
        sourcePath: "/tmp/script.ts",
      },
    ]);

    expect(calls[1]).toEqual({
      uploadFileStream: {
        remotePath: "/workspace/.makeademo/capture/script.ts",
        source: "/tmp/script.ts",
        options: {},
      },
    });
  });

  it("reconnects to an existing sandbox as a preparation workspace", async () => {
    const calls: unknown[] = [];

    const handle = await createDaytonaSdkPreparationWorkspaceHandle({
      client: fakeClient(calls),
      sandboxId: "sandbox_existing",
    });
    const result = await handle.workspace.execute("pwd");

    expect(handle.id).toBe("sandbox_existing");
    expect(result.stdout).toBe("ok");
    expect(calls).toEqual(
      expect.arrayContaining([
        { get: "sandbox_existing" },
        { decodedPtyScript: expect.stringContaining("/bin/sh -c 'pwd'") },
      ]),
    );
  });

  it("binds Application Identity to the explicit pinned revision", async () => {
    const calls: unknown[] = [];
    const pinnedRevision = "0123456789abcdef0123456789abcdef01234567";
    const sourceTreeObjectId = "89abcdef0123456789abcdef0123456789abcdef";
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyCommandResponse() {
          return {
            exitCode: 0,
            stderr: "",
            stdout: `${pinnedRevision}\0${sourceTreeObjectId}\0package.json\0src/app.ts\0`,
          };
        },
      }),
    });
    const handle = await provider.create();

    const baseline =
      await handle.workspace.captureApplicationIdentityBaseline?.({
        pinnedRevision,
        repoUrl: "https://github.com/example/app",
      });

    expect(baseline).toEqual({
      pathInventorySha256:
        "e51bfeac950794cd0e820c3af5d2aee782425119ea6d26b8e931d0f6e063cb25",
      pinnedRevision,
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: ["package.json", "src/app.ts"],
      sourceTreeObjectId,
      uiIdentityIndex: {
        entries: [
          { path: "package.json", roles: ["source-path"] },
          { path: "src/app.ts", roles: ["source-path"] },
        ],
        entryCount: 2,
        indexSha256:
          "cbd95b350088536c5f68bf5291d57c6dabbfd4946f712643ccefd82696505a94",
        sizeBytes: 89,
      },
    });
  });

  it("captures the baseline even when TMPDIR does not exist", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-baseline-"));
    const calls: unknown[] = [];
    let baselineScript: string | undefined;
    try {
      await execFileAsync("git", ["init", "-q", workspace]);
      await execFileAsync("git", [
        "-C",
        workspace,
        "config",
        "user.email",
        "test@example.com",
      ]);
      await execFileAsync("git", [
        "-C",
        workspace,
        "config",
        "user.name",
        "Test",
      ]);
      await writeFile(join(workspace, "package.json"), "{}\n");
      await execFileAsync("git", ["-C", workspace, "add", "package.json"]);
      await execFileAsync("git", [
        "-C",
        workspace,
        "commit",
        "-qm",
        "baseline",
      ]);
      const { stdout: revisionOutput } = await execFileAsync("git", [
        "-C",
        workspace,
        "rev-parse",
        "HEAD",
      ]);
      const pinnedRevision = revisionOutput.trim();
      const { stdout: treeOutput } = await execFileAsync("git", [
        "-C",
        workspace,
        "rev-parse",
        "HEAD^{tree}",
      ]);
      const sourceTreeObjectId = treeOutput.trim();
      const provider = new DaytonaSdkPreparationWorkspaceProvider({
        client: fakeClient(calls, {
          ptyCommandResponse(script) {
            baselineScript = script;
            return {
              exitCode: 0,
              stderr: "",
              stdout: `${pinnedRevision}\0${sourceTreeObjectId}\0package.json\0`,
            };
          },
        }),
      });
      const handle = await provider.create();

      await handle.workspace.captureApplicationIdentityBaseline?.({
        pinnedRevision,
        repoUrl: "https://github.com/example/app",
      });

      const baselineEncoded =
        baselineScript?.match(/[A-Za-z0-9+/=]{100,}/)?.[0];
      expect(baselineEncoded).toBeDefined();
      const decodedBaselineCommand = Buffer.from(
        baselineEncoded as string,
        "base64",
      ).toString();
      expect(decodedBaselineCommand).toContain(
        "/usr/bin/mktemp -p /workspace .makeademo-identity-baseline.XXXXXXXXXX",
      );
      const baselineCommand = decodedBaselineCommand.replaceAll(
        "/workspace",
        workspace,
      );
      const missingTmpDir = join(workspace, "missing-tmp");
      const result = await execFileAsync("/bin/bash", ["-c", baselineCommand], {
        cwd: workspace,
        env: { PATH: process.env.PATH, TMPDIR: missingTmpDir },
      });

      expect(result.stdout).toContain(
        `${pinnedRevision}\0${sourceTreeObjectId}\0package.json\0`,
      );
      expect(
        (await readdir(workspace)).filter((path) =>
          path.startsWith(".makeademo-identity-baseline."),
        ),
      ).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("captures the prepared workspace diff against its bound pinned revision", async () => {
    const calls: unknown[] = [];
    const pinnedRevision = "0123456789abcdef0123456789abcdef01234567";
    const sourceTreeObjectId = "89abcdef0123456789abcdef0123456789abcdef";
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+prepared",
      "",
    ].join("\n");
    let responseIndex = 0;
    let preparedDiffScript: string | undefined;
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyCommandResponse(script) {
          responseIndex += 1;
          if (responseIndex === 1) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: `${pinnedRevision}\0${sourceTreeObjectId}\0old.ts\0package.json\0src/app.ts\0`,
            };
          }
          preparedDiffScript = (script.match(/[A-Za-z0-9+/=]{100,}/g) ?? [])
            .map((encoded) => Buffer.from(encoded, "base64").toString("utf8"))
            .find((decoded) =>
              decoded.includes("makeademo-prepared-workspace-diff"),
            );
          return {
            exitCode: 0,
            stderr: "",
            stdout: `${[
              "MAKEADEMO_PREPARED_WORKSPACE_DIFF_V1",
              Buffer.from("M\0src/app.ts\0D\0old.ts\0").toString("base64"),
              Buffer.from("package.json\0src/app.ts\0demo/new.ts\0").toString(
                "base64",
              ),
              Buffer.from(patch).toString("base64"),
            ].join("\n")}\n`,
          };
        },
      }),
    });
    const handle = await provider.create();
    await handle.workspace.captureApplicationIdentityBaseline?.({
      pinnedRevision,
      repoUrl: "https://github.com/example/app",
    });

    const diff = await handle.workspace.capturePreparedWorkspaceDiff?.();

    expect(diff).toEqual({
      artifactId:
        "workspace-diff:sha256:1f54ed6aeecad2e86e6d9472f07e351ba32071a42a01a8957a2e14237cbe7722",
      createdPaths: ["demo/new.ts"],
      deletedPaths: ["old.ts"],
      modifiedPaths: ["src/app.ts"],
      patch,
      patchSha256:
        "1f54ed6aeecad2e86e6d9472f07e351ba32071a42a01a8957a2e14237cbe7722",
      sizeBytes: 98,
    });
    expect(preparedDiffScript).toContain("ulimit -f 32768");
  });

  it("executes commands, stops, and archives the sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello");
    await handle.release();

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          decodedPtyScript: expect.stringContaining("opencode run hello"),
        },
        { stop: "sandbox_123" },
        { archive: "sandbox_123" },
      ]),
    );
  });

  it("executes agent shell commands as the unprivileged workspace user", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.executeAgentCommand?.(
      "printf pwned > /usr/local/bin/node",
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          decodedPtyScript: expect.stringMatching(
            /runuser -u .*pwuser.*env -i.*\/bin\/bash --noprofile --norc/,
          ),
        },
      ]),
    );
  });

  it("executes read-only argv with trusted binaries and a scrubbed fixed workspace", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.executeReadOnlyCommand?.(
      { argv: ["rg", "-F", "$(touch /tmp/pwned);", "src"] },
      { timeoutMs: 15_000 },
    );

    const script = calls
      .flatMap((call) => {
        const decoded = (call as { decodedPtyScript?: unknown })
          .decodedPtyScript;
        return typeof decoded === "string" ? [decoded] : [];
      })
      .find((value) => value.includes("/usr/sbin/runuser"));
    expect(script).toContain("/usr/sbin/runuser -u");
    expect(script).toContain("/usr/bin/env -i HOME=");
    expect(script).toContain("TMPDIR=");
    expect(script).toContain("PATH=");
    expect(script).toContain("/bin/bash --noprofile --norc -c");
    expect(script).toContain("/usr/bin/timeout --signal=KILL 15s");
    expect(script).toContain("/usr/bin/rg");
    expect(script).toContain("/usr/bin/realpath -e --");
    expect(script).toContain("/workspace/src");
  });

  it("executes a reviewer source read at the backend-pinned Git object", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.executeReadOnlyCommand?.(
      {
        argv: [
          "git",
          "show",
          "0123456789abcdef0123456789abcdef01234567:src/app/page.tsx",
        ],
      },
      { timeoutMs: 10_000 },
    );

    const script = calls
      .flatMap((call) => {
        const decoded = (call as { decodedPtyScript?: unknown })
          .decodedPtyScript;
        return typeof decoded === "string" ? [decoded] : [];
      })
      .find((value) => value.includes("/usr/bin/git"));
    expect(script).toContain(
      "0123456789abcdef0123456789abcdef01234567:src/app/page.tsx",
    );
    expect(script).not.toContain("HEAD:src/app/page.tsx");
  });

  it("revalidates read-only argv at the Daytona provider boundary", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.executeReadOnlyCommand?.(
        { argv: ["git", "config", "core.pager", "sh -c id"] },
        { timeoutMs: 15_000 },
      ),
    ).rejects.toThrow("git query is not allowed");
    expect(calls).not.toEqual(
      expect.arrayContaining([
        { decodedPtyScript: expect.stringContaining("sh -c id") },
      ]),
    );
  });

  it.each([
    ["sed", ["sed", "-n", "1p", "--", "repository-alias"]],
    ["rg", ["rg", "needle", "repository-alias"]],
    ["git diff", ["git", "diff", "HEAD", "--", "repository-alias"]],
  ])(
    "rejects %s paths whose resolved target is a protected repository directory",
    async (_name, argv) => {
      const calls: unknown[] = [];
      const provider = new DaytonaSdkPreparationWorkspaceProvider({
        client: fakeClient(calls),
      });
      const handle = await provider.create();

      await handle.workspace.executeReadOnlyCommand?.(
        { argv },
        { timeoutMs: 15_000 },
      );

      const script = calls
        .flatMap((call) => {
          const decoded = (call as { decodedPtyScript?: unknown })
            .decodedPtyScript;
          return typeof decoded === "string" ? [decoded] : [];
        })
        .find((value) => value.includes("/usr/bin/realpath"));
      expect(script).toContain(
        'case "$makeademo_inspection_path" in /workspace/.git|/workspace/.git/*|/workspace/.makeademo|/workspace/.makeademo/*)',
      );
    },
  );

  it("disables Git helpers, pagers, hooks, locks, and repository fsmonitor during inspection", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.executeReadOnlyCommand?.(
      { argv: ["git", "status"] },
      { timeoutMs: 15_000 },
    );

    const script = calls
      .flatMap((call) => {
        const decoded = (call as { decodedPtyScript?: unknown })
          .decodedPtyScript;
        return typeof decoded === "string" ? [decoded] : [];
      })
      .find((value) => value.includes("/usr/bin/git"));
    expect(script).toContain("GIT_CONFIG_GLOBAL=");
    expect(script).toContain("GIT_CONFIG_SYSTEM=");
    expect(script).toContain("GIT_EXTERNAL_DIFF=");
    expect(script).toContain("GIT_OPTIONAL_LOCKS=");
    expect(script).toContain("GIT_PAGER=");
    expect(script).toContain("GIT_TERMINAL_PROMPT=");
    expect(script).toContain("core.fsmonitor=false");
    expect(script).toContain("core.hooksPath=/dev/null");
    expect(script).toContain("interactive.diffFilter=");
    expect(script).toContain("status");
    expect(script).toContain("--untracked-files=no");
  });

  it("hands the cloned workspace to the agent user without following symlinks", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.prepareForAgent?.();

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          decodedPtyScript: expect.stringMatching(
            /find .*\/workspace.* -xdev -exec chown --no-dereference .*pwuser:pwuser/,
          ),
        },
        {
          decodedPtyScript: expect.stringMatching(
            /makeademo-inspect-submitted-code-toolchain.*chmod 0750/,
          ),
        },
      ]),
    );
  });

  it("passes parent command environment through cancellable Daytona commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      commandTimeoutMs: 1_500,
    });
    const handle = await provider.create();

    await handle.workspace.execute("npm ci", { env: { CI: "true" } });

    expect(calls).toContainEqual({
      createPty: {
        cwd: "/workspace",
        envs: { CI: "true" },
        sandbox: "parent_sandbox",
      },
    });
  });

  it("owns pnpm bounded argv and common build limits after caller input", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              engines: { node: "22" },
              packageManager: "pnpm@10.27.0+sha512.0123456789abcdef",
            }),
            "pnpm-lock.yaml": "",
          },
          projectRoot: "webapp",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await handle.workspace.executeSubmittedProject?.(
      {
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
        installProfile: "bounded",
        plan,
      },
      {
        env: {
          CHILD_CONCURRENCY: "99",
          CI: "true",
          CMAKE_BUILD_PARALLEL_LEVEL: "99",
          MAKEFLAGS: "-j99",
          NODE_ENV: "development",
          OPENAI_API_KEY: "agent-secret",
          TOKEN: "caller-secret",
          TURBO_CONCURRENCY: "99",
          npm_config_child_concurrency: "99",
          npm_config_network_concurrency: "99",
        },
      },
    );
    await handle.workspace.executeSubmittedCode?.(
      "node playwright-control.mjs",
    );

    expect(calls).toContainEqual({
      createPty: {
        cwd: "/workspace/webapp",
        envs: {},
        sandbox: "submitted_sandbox",
      },
    });
    expect(calls).toContainEqual({
      decodedPtyScript: {
        sandbox: "submitted_sandbox",
        script: expect.stringContaining("runuser -u"),
      },
    });
    expect(calls).toContainEqual({
      decodedPtyScript: {
        sandbox: "submitted_sandbox",
        script: expect.stringContaining("YARN_IGNORE_PATH"),
      },
    });
    const submittedExecution = calls
      .filter(
        (call): call is { decodedPtyScript: { script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) =>
        decodeSubmittedExecutionFromFramedScript(call.decodedPtyScript.script),
      )
      .find((execution) => execution?.command.startsWith("'pnpm'"));
    expect(submittedExecution).toEqual(
      expect.objectContaining({
        command:
          "'pnpm' 'install' '--frozen-lockfile' '--child-concurrency=2' '--network-concurrency=4'",
        env: expect.objectContaining({
          CHILD_CONCURRENCY: "2",
          CMAKE_BUILD_PARALLEL_LEVEL: "2",
          MAKEFLAGS: "-j2",
          NODE_ENV: "development",
          TURBO_CONCURRENCY: "2",
        }),
      }),
    );
    expect(JSON.stringify(calls)).not.toContain("22.12.0");
    expect(JSON.stringify(calls)).not.toContain('"99"');
    expect(JSON.stringify(calls)).not.toContain("agent-secret");
    expect(JSON.stringify(calls)).not.toContain("caller-secret");
  });

  it("attaches safe cgroup deltas to a bounded install SIGKILL", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([], {
        resourceSnapshots: [
          "MAKEADEMO_RESOURCE_SNAPSHOT=1\nmemory_oom_kill=2\nmemory_peak_bytes=4000000000\npids_current=40\npids_limit=512\npids_max_events=0\n",
          "MAKEADEMO_RESOURCE_SNAPSHOT=1\nmemory_oom_kill=3\nmemory_peak_bytes=4294967296\npids_current=38\npids_limit=512\npids_max_events=0\n",
        ],
        submittedInstallExitCode: 137,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    const result = await handle.workspace.executeSubmittedProject?.({
      argv: plan.install?.argv ?? [],
      executable: plan.install?.executable ?? "pnpm",
      installProfile: "bounded",
      plan,
    });

    expect(result).toMatchObject({
      exitCode: 137,
      resourceDiagnostics: {
        classification: "cgroup-oom-kill",
        memoryOomKillDelta: 1,
        memoryPeakBytes: 4_294_967_296,
        pidsCurrent: 38,
        pidsLimit: 512,
      },
    });
  });

  it("owns Yarn 4 concurrency configuration after caller input", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              engines: { node: "22" },
              packageManager: "yarn@4.12.0",
            }),
            "yarn.lock": "__metadata:\n  version: 8\n",
          },
          projectRoot: ".",
        },
      ],
    });
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await handle.workspace.executeSubmittedProject?.(
      {
        argv: ["install", "--immutable"],
        executable: "yarn",
        installProfile: "bounded",
        plan,
      },
      {
        env: {
          YARN_NETWORK_CONCURRENCY: "99",
          YARN_TASK_POOL_CONCURRENCY: "99",
        },
      },
    );

    const executions = calls
      .filter(
        (call): call is { decodedPtyScript: { script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) =>
        decodeSubmittedExecutionFromFramedScript(call.decodedPtyScript.script),
      )
      .flatMap((execution) => (execution === undefined ? [] : [execution]));
    expect(executions).toContainEqual(
      expect.objectContaining({
        command: "'yarn' 'install' '--immutable'",
        env: expect.objectContaining({
          YARN_NETWORK_CONCURRENCY: "4",
          YARN_TASK_POOL_CONCURRENCY: "2",
        }),
      }),
    );
    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: ["install", "--immutable", "--mode=skip-build"],
        executable: "yarn",
        installProfile: "bounded",
        plan,
      }),
    ).rejects.toThrow("not the catalog install");
  });

  it("hydrates Corepack's real cache root before binding it to submitted execution", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({ packageManager: "pnpm@11.13.0" }),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedProject?.({
      argv: plan.install?.argv ?? [],
      executable: plan.install?.executable ?? "pnpm",
      plan,
    });

    expect(calls).toContainEqual({
      createPty: {
        cwd: "/",
        envs: expect.objectContaining({
          COREPACK_ENABLE_PROJECT_SPEC: "0",
          COREPACK_ENV_FILE: "0",
          HOME: "/var/empty",
        }),
        sandbox: "submitted_sandbox",
      },
    });
    const scripts = calls
      .filter(
        (
          call,
        ): call is { decodedPtyScript: { sandbox: string; script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) => call.decodedPtyScript.script);
    expect(scripts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("staging-corepack/v1/pnpm"),
        expect.stringMatching(/COREPACK_HOME=.*\/corepack/),
        expect.stringContaining("! -user root"),
      ]),
    );
  });

  it("accepts a root-owned read-only artifact that submitted code cannot modify", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        emulateLinuxRootArtifactWriteAccess: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: plan.install?.argv ?? [],
        executable: plan.install?.executable ?? "pnpm",
        plan,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const verificationScript = calls
      .filter(
        (
          call,
        ): call is { decodedPtyScript: { sandbox: string; script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) => call.decodedPtyScript.script)
      .find((script) => script.includes("MAKEADEMO_VERIFY_TRUSTED_ARTIFACT"));
    expect(verificationScript).toContain("-perm /222");
    expect(verificationScript).toContain("runuser -u");
    expect(verificationScript).toContain(
      'test ! -w "$artifact_root" || fail "artifact-root-pwuser-write"',
    );
  });

  it("binds every submitted command to the hydrated Node and package-manager paths without mise", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({ packageManager: "pnpm@10.26.1" }),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          },
          projectRoot: ".",
        },
      ],
    });
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedProject?.({
      argv: plan.install?.argv ?? [],
      executable: "pnpm",
      plan,
    });
    await handle.workspace.executeSubmittedRuntime?.({
      command: "command -v pnpm && pnpm --version",
      plan,
    });
    await handle.workspace.executeSubmittedCode?.("pnpm --version", {
      env: { PATH: "/submitted/caller/bin" },
    });

    const scripts = calls
      .filter(
        (call): call is { decodedPtyScript: { script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) => call.decodedPtyScript.script);
    const executions = scripts
      .map(decodeSubmittedExecutionFromFramedScript)
      .filter((execution) => execution !== undefined);
    const runtimeExecution = executions.find((execution) =>
      execution.command.includes("command -v pnpm"),
    );
    if (runtimeExecution === undefined) {
      throw new Error("missing decoded submitted runtime execution");
    }
    const artifactBin = runtimeExecution.env.PATH?.split(":")[0];
    if (artifactBin === undefined) throw new Error("missing artifact bin");
    const trustedNodeBin = `/opt/makeademo/toolchains/node/sha256/${"c".repeat(64)}/bin`;
    expect(executions).toHaveLength(3);
    for (const execution of executions) {
      expect(execution.env.PATH).toBe(
        `${artifactBin}:${trustedNodeBin}:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin`,
      );
      expect(execution.env.PATH).not.toContain("/submitted/caller/bin");
      expect(Object.keys(execution.env)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^MISE_/)]),
      );
    }
    expect(executions.map((execution) => execution.command)).toEqual([
      "'pnpm' 'install' '--frozen-lockfile' '--child-concurrency=2' '--network-concurrency=4'",
      "command -v pnpm && pnpm --version",
      "pnpm --version",
    ]);
    const allSubmittedScripts = scripts.join("\n");
    expect(allSubmittedScripts).not.toContain("mise");
    expect(allSubmittedScripts).not.toContain(`node@${plan.node.version}`);
    expect(allSubmittedScripts).toContain(`${trustedNodeBin}/node`);
  });

  it("runs capture through the fixed MakeADemo Node runtime", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    const result = await handle.workspace.executeMakeADemoCapture?.({
      runDirectory: "/workspace/.makeademo/capture-contract",
      scriptPath: "/workspace/.makeademo/capture-contract/demo.mjs",
      stderrPath: "/workspace/.makeademo/capture-contract/demo.stderr.log",
      stdoutPath: "/workspace/.makeademo/capture-contract/demo.stdout.log",
      timeoutMs: 16_500,
    });

    expect(result?.exitCode).toBe(0);
    const execution = decodedSubmittedScripts(calls)
      .map(decodeSubmittedExecutionFromFramedScript)
      .find((candidate) => candidate?.command.includes("demo.mjs"));
    expect(execution).toEqual({
      command: [
        "cd '/workspace/.makeademo/capture-contract'",
        "/usr/bin/timeout -s TERM 17 '/opt/makeademo/capture-runtime/bin/node' '/workspace/.makeademo/capture-contract/demo.mjs' > '/workspace/.makeademo/capture-contract/demo.stdout.log' 2> '/workspace/.makeademo/capture-contract/demo.stderr.log'",
        "code=$?",
        "/bin/cat '/workspace/.makeademo/capture-contract/demo.stdout.log'",
        "/bin/cat '/workspace/.makeademo/capture-contract/demo.stderr.log' >&2",
        "exit $code",
      ].join("; "),
      env: {
        HOME: "/workspace/.makeademo/agent-home",
        MAKEADEMO_PLAYWRIGHT_MODULE_ROOT:
          "/opt/makeademo/playwright-runtime/node_modules",
        PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
        PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
        TMPDIR: "/workspace/.makeademo/tmp",
      },
    });
    expect(JSON.stringify(execution)).not.toContain(
      "/opt/makeademo/toolchains/",
    );
    expect(JSON.stringify(execution)).not.toContain(" bun ");
  });

  it("owns submitted runtime quiescence and verifies the validated port without process scanning", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await handle.workspace.quiesceSubmittedRuntime?.({
      port: 4173,
      timeoutMs: 500,
    });

    const scripts = decodedSubmittedScripts(calls).join("\n");
    expect(scripts).toContain("/dev/tcp/127.0.0.1/4173");
    expect(scripts).not.toContain("/proc/[0-9]*/cmdline");
    expect(JSON.stringify(calls)).not.toContain("OPENAI_API_KEY");
  });

  it("quiesces a retained runtime by process group, escalates to KILL, and fails closed on an occupied port", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, { retainedRuntimePid: 4242 }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await handle.workspace.executeSubmittedRuntime?.({
      command: "echo runtime-start",
      plan,
    });
    await handle.workspace.quiesceSubmittedRuntime?.({
      port: 4173,
      timeoutMs: 500,
    });

    const quiescenceScript = decodedSubmittedScripts(calls).find(
      (script) =>
        script.includes("makeademo_pid") && script.includes("kill -TERM"),
    );
    expect(quiescenceScript).toBeDefined();
    if (quiescenceScript === undefined) {
      throw new Error("Expected the guarded quiescence script.");
    }
    expect(quiescenceScript).toContain('kill -TERM -- -"$makeademo_pgid"');
    expect(quiescenceScript).not.toContain('|| kill -TERM "$makeademo_pid"');
    expect(quiescenceScript).toContain('kill -0 -- -"$makeademo_pgid"');
    expect(quiescenceScript).toContain('kill -KILL -- -"$makeademo_pgid"');
    expect(quiescenceScript).toContain("makeademo_identity_matches");
    expect(quiescenceScript.indexOf("makeademo_identity_matches")).toBeLessThan(
      quiescenceScript.indexOf('kill -TERM -- -"$makeademo_pgid"'),
    );
    expect(quiescenceScript).toContain("/dev/tcp/127.0.0.1/4173");

    const occupiedCalls: unknown[] = [];
    const occupiedProvider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(occupiedCalls, {
        quiescencePortOccupied: true,
        retainedRuntimePid: 4242,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const occupiedHandle = await occupiedProvider.create();
    const occupiedPlan =
      await provisionToolchainForSubmittedCodeSync(occupiedHandle);
    await occupiedHandle.workspace.syncSubmittedCodeWorkspace?.();
    await occupiedHandle.workspace.executeSubmittedRuntime?.({
      command: "echo runtime-start",
      plan: occupiedPlan.plan,
    });

    await expect(
      occupiedHandle.workspace.quiesceSubmittedRuntime?.({
        port: 4173,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(
      "port 4173 remains occupied after quiescence. Diagnostics: retained process group 4242; listener pid=5151 pgid=5151 command=node",
    );

    await expect(
      occupiedHandle.workspace.quiesceSubmittedRuntime?.({
        port: 4173,
        timeoutMs: 500,
      }),
    ).rejects.toThrow("port 4173 remains occupied after quiescence");
    const occupiedQuiescenceScripts = decodedSubmittedScripts(
      occupiedCalls,
    ).filter((script) => script.includes("/dev/tcp/127.0.0.1/4173"));
    expect(occupiedQuiescenceScripts.at(-1)).not.toContain(
      "makeademo_pid='4242'",
    );
  });

  it("refuses to signal a reused PID and clears the stale retained identity", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        quiescenceIdentityMismatch: true,
        retainedRuntimePid: 4242,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedRuntime?.({
      command: "echo runtime-start",
      plan,
    });

    await expect(
      handle.workspace.quiesceSubmittedRuntime?.({
        port: 4173,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(
      "identity changed before quiescence; no further signal was sent. Diagnostics: retained process identity no longer matches; refusing to signal",
    );

    await expect(
      handle.workspace.quiesceSubmittedRuntime?.({
        port: 4173,
        timeoutMs: 500,
      }),
    ).resolves.toBeUndefined();
    const quiescenceScripts = decodedSubmittedScripts(calls).filter((script) =>
      script.includes("/dev/tcp/127.0.0.1/4173"),
    );
    const guardedScript = quiescenceScripts.at(-2);
    expect(guardedScript).toContain("makeademo_start_time=");
    expect(guardedScript).toContain("9001");
    expect(guardedScript?.indexOf("refusing to signal")).toBeLessThan(
      guardedScript?.indexOf('kill -TERM -- -"$makeademo_pgid"') ?? -1,
    );
    expect(quiescenceScripts.at(-1)).not.toContain("makeademo_pid='4242'");
  });

  it("continues after a retained runtime exits naturally and its port stays closed", async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once("error", reject);
      portProbe.listen(0, "127.0.0.1", resolve);
    });
    const address = portProbe.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a local TCP port.");
    }
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));

    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        executeQuiescenceLocally: true,
        retainedRuntimePid: 4242,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    const runtime = { command: "echo runtime-start", plan };
    await handle.workspace.executeSubmittedRuntime?.(runtime);

    await expect(
      handle.workspace.quiesceSubmittedRuntime?.({
        port: address.port,
        timeoutMs: 500,
      }),
    ).resolves.toBeUndefined();
    await expect(
      handle.workspace.executeSubmittedRuntime?.(runtime),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("fails closed without signaling when a reused PID has an unrelated occupied port", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a local TCP port.");
    }

    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        executeQuiescenceLocally: true,
        retainedRuntimePid: 4242,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedRuntime?.({
      command: "echo runtime-start",
      plan,
    });

    try {
      await expect(
        handle.workspace.quiesceSubmittedRuntime?.({
          port: address.port,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(
        "identity changed before quiescence; no further signal was sent",
      );
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const quiescenceScript = decodedSubmittedScripts(calls).find(
      (script) =>
        script.includes(`/dev/tcp/127.0.0.1/${address.port}`) &&
        script.includes("makeademo_identity_matches"),
    );
    expect(quiescenceScript).toBeDefined();
    expect(
      quiescenceScript?.indexOf("refusing to signal because port"),
    ).toBeLessThan(
      quiescenceScript?.indexOf('kill -TERM -- -"$makeademo_pgid"') ?? -1,
    );
  });

  it("does not accept one closed-port sample when the stale runtime port becomes occupied", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a local TCP port.");
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        executeQuiescenceLocally: true,
        retainedRuntimePid: 4242,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedRuntime?.({
      command: "echo runtime-start",
      plan,
    });

    const reopened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.once("error", reject);
        server.listen(address.port, "127.0.0.1", resolve);
      }, 40);
      timer.unref();
    });
    try {
      await expect(
        handle.workspace.quiesceSubmittedRuntime?.({
          port: address.port,
          timeoutMs: 500,
        }),
      ).rejects.toThrow("was not confirmed closed twice");
      await reopened;
      expect(server.listening).toBe(true);
    } finally {
      await reopened.catch(() => undefined);
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("rejects a runtime report whose nonce-bound identity is not a session leader", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        malformedRetainedRuntimeIdentity: true,
        retainedRuntimePid: 4242,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await expect(
      handle.workspace.executeSubmittedRuntime?.({
        command: "echo runtime-start",
        plan,
      }),
    ).rejects.toThrow("did not report a valid session identity");
  });

  it("waits for the owned runtime listener to release its port before succeeding", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        executeQuiescenceLocally: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a local TCP port.");
    }
    const closeTimer = setTimeout(() => server.close(), 100);

    try {
      await expect(
        handle.workspace.quiesceSubmittedRuntime?.({
          port: address.port,
          timeoutMs: 100,
        }),
      ).resolves.toBeUndefined();
    } finally {
      clearTimeout(closeTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(process.platform !== "linux")(
    "kills an original stubborn group member after TERM exits the session leader",
    async () => {
      const portProbe = createServer();
      await new Promise<void>((resolve, reject) => {
        portProbe.once("error", reject);
        portProbe.listen(0, "127.0.0.1", resolve);
      });
      const address = portProbe.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a local TCP port.");
      }
      await new Promise<void>((resolve) => portProbe.close(() => resolve()));

      const leader = spawn(
        "setsid",
        [
          "/bin/sh",
          "-c",
          `trap 'exit 143' TERM; (trap '' TERM; exec python3 -m http.server ${address.port} --bind 127.0.0.1) & wait`,
        ],
        { stdio: "ignore" },
      );
      const processId = leader.pid;
      if (processId === undefined) throw new Error("Expected a leader PID.");

      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            const response = await fetch(`http://127.0.0.1:${address.port}`);
            if (response.ok) break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        await expect(
          fetch(`http://127.0.0.1:${address.port}`),
        ).resolves.toMatchObject({ ok: true });

        const stat = await readFile(`/proc/${processId}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        const identity = {
          processGroupId: Number(fields[2]),
          processId,
          processStartTimeTicks: Number(fields[19]),
          sessionId: Number(fields[3]),
        };
        expect(identity).toMatchObject({
          processGroupId: processId,
          sessionId: processId,
        });

        const calls: unknown[] = [];
        const provider = new DaytonaSdkPreparationWorkspaceProvider({
          client: fakeCommandTimeoutClient(calls, {
            executeQuiescenceLocally: true,
            retainedRuntimeIdentity: identity,
          }),
          submittedCodeSnapshot: "makeademo-submitted-code",
        });
        const handle = await provider.create();
        const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
        await handle.workspace.syncSubmittedCodeWorkspace?.();
        await handle.workspace.executeSubmittedRuntime?.({
          command: "echo runtime-start",
          plan,
        });

        await expect(
          handle.workspace.quiesceSubmittedRuntime?.({
            port: address.port,
            timeoutMs: 500,
          }),
        ).resolves.toBeUndefined();
        await expect(
          fetch(`http://127.0.0.1:${address.port}`),
        ).rejects.toThrow();
      } finally {
        try {
          process.kill(-processId, "SIGKILL");
        } catch {
          // The quiescence contract should already have removed the group.
        }
      }
    },
  );

  it("rejects a second submitted runtime start until successful quiescence clears the retained process group", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, { retainedRuntimePid: 4242 }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    const runtime = { command: "echo runtime-start", plan };

    await handle.workspace.executeSubmittedRuntime?.(runtime);
    const callsAfterFirstStart = calls.length;
    await expect(
      handle.workspace.executeSubmittedRuntime?.(runtime),
    ).rejects.toThrow("submitted runtime is already active");
    expect(calls).toHaveLength(callsAfterFirstStart);

    await handle.workspace.quiesceSubmittedRuntime?.({
      port: 4173,
      timeoutMs: 500,
    });
    await expect(
      handle.workspace.executeSubmittedRuntime?.(runtime),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("keeps a provisioned npm launcher ahead of the hydrated Node bundle's npm", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package-lock.json": "{}",
            "package.json": JSON.stringify({
              engines: { node: "22" },
              packageManager: "npm@10.9.2",
            }),
          },
          projectRoot: ".",
        },
      ],
    });
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedRuntime?.({
      command: "command -v npm && npm --version",
      plan,
    });

    const execution = decodedSubmittedScripts(calls)
      .map(decodeSubmittedExecutionFromFramedScript)
      .find((candidate) => candidate?.command.includes("command -v npm"));
    expect(execution?.env.PATH?.split(":").slice(0, 2)).toEqual([
      expect.stringMatching(
        /\/toolchains\/npm-10\.9\.2-[^/]+\/[a-f0-9]+\/bin$/,
      ),
      `/opt/makeademo/toolchains/node/sha256/${"c".repeat(64)}/bin`,
    ]);
  });

  it("hydrates the signed Node runtime before acquiring a package manager", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();

    await handle.workspace.provisionSubmittedCodeToolchain?.(
      resolveSubmittedCodeToolchain(supportedPnpmMetadata(".")),
    );

    const scripts = decodedSubmittedScripts(calls);
    expect(
      scripts.findIndex((script) =>
        script.includes("makeademo-provision-submitted-node-runtime provision"),
      ),
    ).toBeLessThan(
      scripts.findIndex((script) =>
        script.includes("MAKEADEMO_ARTIFACT_SHA512"),
      ),
    );
  });

  it("does not acquire a package manager when signed Node hydration fails", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        nodeProvisioningFailure: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(
        resolveSubmittedCodeToolchain(supportedPnpmMetadata(".")),
      ),
    ).rejects.toThrow("Trusted Node runtime hydration failed");
    expect(decodedSubmittedScripts(calls)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("MAKEADEMO_ARTIFACT_SHA512"),
      ]),
    );
  });

  it("verifies Node and package-manager artifacts once during first provisioning", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    const provisioningScripts = decodedSubmittedScripts(calls);
    expect(
      provisioningScripts.filter((script) =>
        script.includes("makeademo-provision-submitted-node-runtime provision"),
      ),
    ).toHaveLength(1);
    expect(
      provisioningScripts.filter((script) =>
        script.includes("MAKEADEMO_VERIFY_TRUSTED_ARTIFACT"),
      ),
    ).toHaveLength(1);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    calls.splice(0);

    await handle.workspace.executeSubmittedRuntime?.({
      command: "pnpm --version",
      plan,
    });

    const runtimeScripts = decodedSubmittedScripts(calls);
    expect(runtimeScripts).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "makeademo-provision-submitted-node-runtime provision",
        ),
        expect.stringContaining("MAKEADEMO_VERIFY_TRUSTED_ARTIFACT"),
      ]),
    );
    expect(runtimeScripts.at(-1)).toContain("pnpm");
  });

  it("poisons the submitted child after package-manager verification fails", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        packageManagerVerificationFailure: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).rejects.toThrow("Trusted package-manager artifact verification failed");
    const commandCountAfterFailure = calls.length;
    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).rejects.toThrow("fresh submitted-code sandbox");
    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow("fresh submitted-code sandbox");
    await expect(
      handle.workspace.executeSubmittedCode?.("true"),
    ).rejects.toThrow("fresh submitted-code sandbox");
    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: plan.install?.argv ?? [],
        executable: plan.install?.executable ?? "pnpm",
        plan,
      }),
    ).rejects.toThrow("fresh submitted-code sandbox");
    await expect(
      handle.workspace.executeSubmittedRuntime?.({
        command: "pnpm --version",
        plan,
      }),
    ).rejects.toThrow("fresh submitted-code sandbox");

    expect(calls).toHaveLength(commandCountAfterFailure);
    expect(
      decodedSubmittedScripts(calls).filter((script) =>
        script.includes("makeademo-provision-submitted-node-runtime provision"),
      ),
    ).toHaveLength(1);
    expect(
      decodedSubmittedScripts(calls).filter((script) =>
        script.includes('pack "$descriptor"'),
      ),
    ).toHaveLength(1);
    expect(
      decodedSubmittedScripts(calls).filter((script) =>
        script.includes("MAKEADEMO_VERIFY_TRUSTED_ARTIFACT"),
      ),
    ).toHaveLength(1);
  });

  it.skipIf(process.env.MAKEADEMO_RUN_REAL_COREPACK_TEST !== "1")(
    "uses Corepack's actual v1 cache layout before moving it to the runtime home",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "makeademo-real-corepack-"));
      const stagingHome = join(root, "staging-corepack");
      const artifact = join(root, "artifact.tgz");
      const runtimeHome = join(root, "runtime", "corepack");
      const environment = { ...process.env, COREPACK_HOME: stagingHome };

      try {
        await mkdir(join(stagingHome, "v1", "pnpm"), { recursive: true });
        await execFileAsync(
          "bunx",
          ["--bun", "corepack", "pack", "pnpm@10.27.0", "-o", artifact],
          { cwd: root, env: environment, timeout: 60_000 },
        );
        await execFileAsync(
          "bunx",
          ["--bun", "corepack", "install", "-g", "--cache-only", artifact],
          { cwd: root, env: environment, timeout: 60_000 },
        );
        await mkdir(dirname(runtimeHome), { recursive: true });
        await rename(stagingHome, runtimeHome);

        await access(join(runtimeHome, "v1", "pnpm", "10.27.0"));
      } finally {
        await rm(root, { force: true, recursive: true }).catch(() => {});
      }
    },
    120_000,
  );

  it.skipIf(process.env.MAKEADEMO_RUN_REAL_COREPACK_TEST !== "1")(
    "executes exact Yarn Berry generations from official cli-dist artifacts",
    async () => {
      for (const version of ["2.4.2", "3.8.7", "4.11.0"]) {
        const root = await mkdtemp(join(tmpdir(), "makeademo-real-yarn-"));

        try {
          const packed = await execFileAsync(
            "npm",
            [
              "pack",
              "--silent",
              `@yarnpkg/cli-dist@${version}`,
              "--pack-destination",
              root,
            ],
            { cwd: root, timeout: 60_000 },
          );
          const artifact = join(root, packed.stdout.trim());
          await execFileAsync(
            "tar",
            ["-xzf", artifact, "-C", root, "package/bin/yarn.js"],
            { cwd: root, timeout: 60_000 },
          );

          const executed = await execFileAsync(
            "node",
            [join(root, "package/bin/yarn.js"), "--version"],
            { cwd: root, timeout: 60_000 },
          );
          expect(executed.stdout.trim()).toBe(version);
        } finally {
          await rm(root, { force: true, recursive: true }).catch(() => {});
        }
      }
    },
    240_000,
  );

  it("derives package-manager integrity from the fixed official npm registry", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedProject?.({
      argv: plan.install?.argv ?? [],
      executable: plan.install?.executable ?? "pnpm",
      plan,
    });

    const scripts = calls
      .filter(
        (call): call is { decodedPtyScript: { script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) => call.decodedPtyScript.script)
      .join("\n");
    expect(scripts).toContain("https://registry.npmjs.org/pnpm/11.13.0");
    expect(scripts).toContain("metadata.deprecated");
    expect(scripts).toContain("MAKEADEMO_REGISTRY_RELEASE_DEPRECATED");
    expect(scripts).toContain("MAKEADEMO_UPSTREAM_SRI=");
    expect(scripts).toContain("$upstream_hash");
    expect(scripts).toContain('pack "$descriptor"');
    expect(scripts).toContain(
      `/opt/makeademo/toolchains/node/sha256/${"c".repeat(64)}/bin/corepack`,
    );
    expect(scripts).not.toContain("mise");
  });

  it("rejects registry releases carrying non-empty deprecation metadata", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([], {
        deprecatedPackageManagerRelease: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();

    await expect(
      provisionSubmittedCodeToolchain(
        handle.workspace,
        resolveSubmittedCodeToolchain(supportedPnpmMetadata(".")),
      ),
    ).rejects.toBeInstanceOf(SubmittedCodeToolchainRepairRequiredError);
  });

  it("provisions the revisioned Yarn 2 default from its exact cli-dist release", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({ engines: { yarn: ">=2 <3" } }),
            "yarn.lock": "__metadata:\n  version: 4\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).resolves.toBeUndefined();

    const scripts = decodedSubmittedScripts(calls).join("\n");
    expect(plan.packageManager?.version).toBe("2.4.2");
    expect(scripts).toContain(
      "https://registry.npmjs.org/@yarnpkg%2fcli-dist/2.4.2",
    );
    expect(scripts).toContain('const expectedVersion = "2.4.2"');
  });

  it("reports an exact missing Yarn cli-dist release without falling back", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        unavailablePackageManagerRelease: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({ packageManager: "yarn@2.4.3" }),
            "yarn.lock": "__metadata:\n  version: 4\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await expect(
      provisionSubmittedCodeToolchain(handle.workspace, plan),
    ).rejects.toMatchObject({
      code: "package_manager_release_unavailable",
      name: "SubmittedCodeToolchainRepairRequiredError",
    });

    const scripts = decodedSubmittedScripts(calls).join("\n");
    expect(scripts).toContain(
      "https://registry.npmjs.org/@yarnpkg%2fcli-dist/2.4.3",
    );
    expect(scripts).not.toContain(
      "https://registry.npmjs.org/@yarnpkg%2fcli-dist/2.4.2",
    );
    expect(
      scripts.indexOf('if [ "$metadata_http_status" != 200 ]'),
    ).toBeLessThan(scripts.indexOf('"$tarball_url" -o "$artifact"'));
    expect(calls).toContainEqual({ registryMetadataUnavailable: true });
    expect(calls).not.toContainEqual(
      expect.objectContaining({ submittedProjectExecution: expect.anything() }),
    );
  });

  it("launches Yarn Berry from the exact registry-verified cli-dist artifact", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({ packageManager: "yarn@4.12.0" }),
            "yarn.lock": "__metadata:\n  version: 6\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);

    const scripts = calls
      .filter(
        (call): call is { decodedPtyScript: { script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) => call.decodedPtyScript.script)
      .join("\n");
    expect(scripts).toContain(
      "https://registry.npmjs.org/@yarnpkg%2fcli-dist/4.12.0",
    );
    expect(scripts).toContain('"$tarball_url" -o "$artifact"');
    expect(scripts).toContain("package/bin/yarn.js");
    expect(scripts).toContain('"$yarn_cli"');
    expect(scripts).toContain(
      `/opt/makeademo/toolchains/node/sha256/${"c".repeat(64)}/bin/node`,
    );
    expect(scripts).not.toContain("mise");
    expect(scripts).not.toContain("registry.npmjs.org/yarn/4.12.0");
    expect(scripts).not.toContain("corepack pack");
    expect(scripts).not.toContain("corepack install");
    expect(scripts).not.toContain("corepack yarn@4.12.0");
  });

  it("verifies a declared Yarn Berry Corepack hash against the launched CLI", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const declaredCorepackHash =
      "sha512.f45ab632439a67f8bc759bf32ead036a1f413287b9042726b7cc4818b7b49e14e9423ba49b18f9e06ea4941c1ad062385b1d8760a8d5091a1a31e5f6219afca8";
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              packageManager: `yarn@4.12.0+${declaredCorepackHash}`,
            }),
            "yarn.lock": "__metadata:\n  version: 6\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);

    const scripts = calls
      .filter(
        (call): call is { decodedPtyScript: { script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .map((call) => call.decodedPtyScript.script)
      .join("\n");
    const comparisonStart = scripts.indexOf(
      'test "sha512.$(sha512sum "$yarn_cli"',
    );
    expect(comparisonStart).toBeGreaterThanOrEqual(0);
    expect(scripts.slice(comparisonStart, comparisonStart + 512)).toContain(
      declaredCorepackHash,
    );
    expect(scripts).not.toContain(
      `test "$upstream_hash" = '${declaredCorepackHash}'`,
    );
    expect(scripts).not.toContain("repo.yarnpkg.com");
    expect(scripts).toContain(
      "https://registry.npmjs.org/@yarnpkg%2fcli-dist/4.12.0",
    );
  });

  it("rejects a declared Yarn Berry hash that differs from the launched CLI", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls, {
        emulatedYarnCliSha512: "0".repeat(128),
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const declaredCorepackHash =
      "sha512.f45ab632439a67f8bc759bf32ead036a1f413287b9042726b7cc4818b7b49e14e9423ba49b18f9e06ea4941c1ad062385b1d8760a8d5091a1a31e5f6219afca8";
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              packageManager: `yarn@4.12.0+${declaredCorepackHash}`,
            }),
            "yarn.lock": "__metadata:\n  version: 6\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).rejects.toThrow(
      "Trusted package-manager hydration failed for yarn@4.12.0: launched Yarn CLI digest mismatch",
    );
  });

  it("hydrates an exact Bun release from the official GitHub asset without an installer", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "bun.lock": "{}",
            "package.json": JSON.stringify({ packageManager: "bun@1.2.22" }),
          },
          projectRoot: ".",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.executeSubmittedProject?.({
      argv: plan.install?.argv ?? [],
      executable: plan.install?.executable ?? "bun",
      plan,
    });

    const scripts = JSON.stringify(calls);
    expect(scripts).toContain(
      "https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.2.22",
    );
    expect(scripts).toContain("bun-linux-x64.zip");
    expect(scripts).toContain("asset.digest");
    expect(scripts).toContain("release?.tag_name !== expectedTag");
    expect(scripts).toContain("release?.prerelease !== false");
    expect(scripts).toContain(
      "https://github.com/oven-sh/bun/releases/download/bun-v1.2.22/bun-linux-x64.zip",
    );
    expect(scripts).toContain("asset.size > 134217728");
    expect(scripts).toContain("uncompressed size");
    expect(scripts).toContain("Number.isSafeInteger");
    expect(scripts).toContain("268435456");
    expect(scripts.indexOf("uncompressed size")).toBeLessThan(
      scripts.indexOf("unzip -q"),
    );
    expect(scripts).toContain("sha256sum");
    expect(scripts).toContain("MAKEADEMO_UPSTREAM_SHA256");
    expect(scripts).toContain("MAKEADEMO_ARTIFACT_SHA256");
    expect(scripts).toContain("$artifact_sha256/bin");
    expect(scripts).toContain("--version");
    expect(scripts).not.toContain("bun.sh/install");
    expect(scripts).not.toContain("corepack pack");
  });

  it("rejects Bun releases before the GitHub digest boundary before acquisition", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const supported = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "bun.lock": "{}",
            "package.json": JSON.stringify({ packageManager: "bun@1.2.22" }),
          },
          projectRoot: ".",
        },
      ],
    });
    if (supported.packageManager === undefined) {
      throw new Error("missing supported Bun manager");
    }
    const unsupported = {
      ...supported,
      packageManager: {
        ...supported.packageManager,
        version: "1.2.15",
      },
    };

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(unsupported),
    ).rejects.toThrow("Unsupported package-manager compatibility generation");
    expect(JSON.stringify(calls)).not.toContain(
      "api.github.com/repos/oven-sh/bun",
    );
  });

  it("rejects Bun hydration without an authoritative GitHub digest attestation", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient([], { commandStdout: "missing digest" }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "bun.lock": "{}",
            "package.json": JSON.stringify({ packageManager: "bun@1.2.22" }),
          },
          projectRoot: ".",
        },
      ],
    });

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).rejects.toThrow("GitHub SHA-256 attestation");
  });

  it("rebinds a changed lock plan to the same artifact without reopening acquisition", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const firstPlan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({ packageManager: "pnpm@10.27.0" }),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          },
          projectRoot: ".",
        },
      ],
    });
    const repairedPlan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({ packageManager: "pnpm@10.27.0" }),
            "pnpm-lock.yaml":
              "lockfileVersion: '9.0'\nsettings:\n  repaired: true\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(firstPlan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.provisionSubmittedCodeToolchain?.(repairedPlan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    expect(
      calls.filter((call) =>
        JSON.stringify(call).includes("MAKEADEMO_ARTIFACT_SHA512"),
      ),
    ).toHaveLength(1);
  });

  it("reuses the same artifact across repeated synchronization and rejects a different artifact", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));
    const changedPlan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              engines: { node: "22" },
              packageManager: "pnpm@11.13.0",
            }),
            "pnpm-lock.yaml":
              "lockfileVersion: '9.0'\nsettings:\n  changed: true\n",
          },
          projectRoot: ".",
        },
      ],
    });
    const differentArtifactPlan = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              engines: { node: "22" },
              packageManager: "pnpm@10.26.0",
            }),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: plan.install?.argv ?? [],
        executable: plan.install?.executable ?? "pnpm",
        plan,
      }),
    ).rejects.toThrow("requires synchronization");
    await handle.workspace.provisionSubmittedCodeToolchain?.(changedPlan);

    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: plan.install?.argv ?? [],
        executable: plan.install?.executable ?? "pnpm",
        plan,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(differentArtifactPlan),
    ).rejects.toThrow("fresh submitted-code sandbox");
  });

  it("allows the same bound plan to resynchronize a repaired workspace", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([]),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);

    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).resolves.toBeUndefined();
  });

  it("requires a fresh submitted sandbox when only the exact Node release changes", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([]),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const node22 = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));
    const node24 = resolveSubmittedCodeToolchain({
      candidates: [
        {
          files: {
            "package.json": JSON.stringify({
              engines: { node: "24" },
              packageManager: "pnpm@11.13.0",
            }),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          },
          projectRoot: ".",
        },
      ],
    });

    await handle.workspace.provisionSubmittedCodeToolchain?.(node22);
    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(node24),
    ).rejects.toThrow("fresh submitted-code sandbox");
  });

  it("rejects a synchronized child lockfile that differs from the provisioned plan", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([], {
        submittedIntegrityFailureAttempt: 1,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);

    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow("lockfile integrity did not match");
  });

  it("rechecks the child lockfile before an immutable install", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([], {
        submittedIntegrityFailureAttempt: 2,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await expect(
      handle.workspace.executeSubmittedProject?.({
        argv: plan.install?.argv ?? [],
        executable: plan.install?.executable ?? "pnpm",
        plan,
      }),
    ).rejects.toThrow("lockfile integrity did not match");
  });

  it("provisions a toolchain without changing submitted-code network policy", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(
        resolveSubmittedCodeToolchain(supportedPnpmMetadata(".")),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not depend on submitted-code network update failures during provisioning", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(
        resolveSubmittedCodeToolchain(supportedPnpmMetadata(".")),
      ),
    ).resolves.toBeUndefined();
  });

  it("runs submitted runtime commands from the planned project root with a sealed environment", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("webapp"));
    const command = "pnpm run demo; printf '%s' safe";
    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await handle.workspace.executeSubmittedRuntime?.(
      { command, plan },
      {
        env: {
          NEXT_PUBLIC_API_URL: "https://public.example.test",
          NODE_ENV: "production",
          OPENAI_API_KEY: "agent-secret",
          TOKEN: "caller-secret",
        },
      },
    );

    expect(calls).toContainEqual({
      createPty: {
        cwd: "/workspace/webapp",
        envs: {},
        sandbox: "submitted_sandbox",
      },
    });
    expect(calls).toContainEqual({
      decodedPtyScript: {
        sandbox: "submitted_sandbox",
        script: expect.stringContaining("runuser -u"),
      },
    });
    expect(JSON.stringify(calls)).not.toContain("22.12.0");
    expect(JSON.stringify(calls)).not.toContain("agent-secret");
    expect(JSON.stringify(calls)).not.toContain("caller-secret");
  });

  it("rejects a runtime plan that changed after its private binding", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([]),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));
    const tampered = {
      ...plan,
      install: { argv: ["install"], executable: "pnpm" },
    };

    await handle.workspace.provisionSubmittedCodeToolchain?.(plan);
    await expect(
      handle.workspace.executeSubmittedRuntime?.({
        command: "pnpm run demo",
        plan: tampered,
      }),
    ).rejects.toThrow("not the catalog install");
  });

  it("rejects a direct plan whose Corepack integrity suffix is malformed", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([]),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = {
      catalogRevision: "submitted-js-2026-07-26.1" as const,
      evidence: [],
      install: {
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
      },
      node: {
        family: 22 as const,
        lifecycle: "supported" as const,
        version: "22.23.1" as const,
      },
      packageManager: {
        corepackHash: "sha512.not-hex",
        generation: "pnpm-modern" as const,
        name: "pnpm" as const,
        version: "11.13.0" as const,
      },
      projectRoot: ".",
    };

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).rejects.toThrow("Invalid Corepack package-manager integrity suffix");
  });

  it("rejects a direct plan whose project root traverses outside workspace", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([]),
      submittedCodeSnapshot: "makeademo-submitted-code",
    });
    const handle = await provider.create();
    const plan = {
      catalogRevision: "submitted-js-2026-07-26.1" as const,
      evidence: [],
      install: {
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        executable: "pnpm",
      },
      node: {
        family: 22 as const,
        lifecycle: "supported" as const,
        version: "22.23.1" as const,
      },
      packageManager: {
        generation: "pnpm-modern" as const,
        name: "pnpm" as const,
        version: "11.13.0" as const,
      },
      projectRoot: "apps/../private",
    };

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).rejects.toThrow("Unsafe submitted project root: apps/../private");
  });

  it("accepts a per-call timeout override for parent Daytona commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      commandTimeoutMs: 1_500,
    });
    const handle = await provider.create();

    await handle.workspace.execute("opencode run hello", { timeoutMs: 2_500 });

    expect(calls).toContainEqual({
      decodedPtyScript: {
        sandbox: "parent_sandbox",
        script: expect.stringContaining("opencode run hello"),
      },
    });
  });

  it("fails fast when a Daytona command does not finish", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandNeverResolves: true }),
      commandTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(handle.workspace.execute("npm ci")).rejects.toThrow(
      "Daytona command did not finish within 1ms.",
    );
    expect(calls).toEqual(expect.arrayContaining([{ kill: true }]));
  });

  it("resolves signed preview URLs for browser validation", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();
    const getPreviewUrl = handle.workspace.getPreviewUrl?.bind(
      handle.workspace,
    );
    if (getPreviewUrl === undefined) {
      throw new Error("Provider did not expose preview URL support.");
    }

    await expect(getPreviewUrl(4173)).resolves.toBe(
      "https://preview.example.test:4173",
    );
    expect(calls[1]).toEqual({
      getSignedPreviewUrl: { port: 4173, ttl: 3600 },
    });
  });

  it("fails fast when Daytona does not return a preview URL", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { previewNeverResolves: true }),
      previewUrlTimeoutMs: 1,
    });
    const handle = await provider.create();
    const getPreviewUrl = handle.workspace.getPreviewUrl?.bind(
      handle.workspace,
    );
    if (getPreviewUrl === undefined) {
      throw new Error("Provider did not expose preview URL support.");
    }

    await expect(getPreviewUrl(4173)).rejects.toThrow(
      "Daytona preview URL creation did not finish within 1ms.",
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        { getSignedPreviewUrl: { port: 4173, ttl: 3600 } },
      ]),
    );
  });

  it("streams command output through a Daytona PTY when callbacks are provided", async () => {
    const calls: unknown[] = [];
    const streamed: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello", {
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
    });

    expect(result).toEqual({
      exitCode: 7,
      stderr: "",
      stdout: "hello\n",
    });
    expect(streamed).toEqual(["stdout:hello\n"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        { waitForConnection: true },
        { decodedPtyScript: expect.stringContaining("opencode run hello") },
        { disconnect: true },
      ]),
    );
    expect(calls.filter((call) => "wait" in Object(call))).toHaveLength(0);
  });

  it("does not treat a forged application exit marker as wrapper completion", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyEmitsForgedExitMarker: true }),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("printf forged", {
      onStdout: () => {},
    });

    expect(result.exitCode).toBe(7);
  });

  it("uses a per-call timeout override for streaming Daytona commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyWaitsForDisconnect: true,
        ptySuppressExitMarker: true,
      }),
      commandTimeoutMs: 1_000,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run slow", {
        onStdout: () => {},
        timeoutMs: 1,
      }),
    ).rejects.toThrow("Daytona command did not finish within 1ms.");
    expect(calls).toEqual(expect.arrayContaining([{ disconnect: true }]));
  });

  it("appends each sandbox log event to both durable paths with one command", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog?.({
      event: "repo-preparation.started",
      stage: "repo-preparation",
    });

    const commands = calls.flatMap((call) =>
      typeof call === "object" &&
      call !== null &&
      "executeCommand" in call &&
      typeof call.executeCommand === "string"
        ? [call.executeCommand]
        : [],
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("/tmp/makeademo/sandbox-log.jsonl");
    expect(commands[0]).toContain("/workspace/.makeademo/sandbox-log.jsonl");
    expect(commands[0]).not.toContain(" cp ");
    expect(countOccurrences(commands[0] ?? "", '"event"')).toBe(1);
  });

  it("writes Pino-formatted sandbox logs through durable files", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog?.({
      event: "repo-preparation.started",
      stage: "repo-preparation",
      timestamp: "2026-06-17T00:00:00.000Z",
    });
    await handle.workspace.writeSandboxLog?.({
      event: "repo-preparation.succeeded",
      stage: "repo-preparation",
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            "/tmp/makeademo/sandbox-log.jsonl",
          ),
        },
        {
          executeCommand: expect.stringContaining(
            '"event":"repo-preparation.succeeded"',
          ),
        },
        {
          executeCommand: expect.stringContaining('"level":"info"'),
        },
        {
          executeCommand: expect.stringContaining(
            '"message":"repo-preparation.succeeded"',
          ),
        },
        {
          executeCommand: expect.stringContaining('"service":"makeademo"'),
        },
        {
          executeCommand: expect.stringContaining(
            '"eventTime":"2026-06-17T00:00:00.000Z"',
          ),
        },
      ]),
    );
    const sandboxLogWrites = calls
      .filter(
        (call): call is { executeCommand: string } =>
          typeof call === "object" &&
          call !== null &&
          "executeCommand" in call &&
          typeof call.executeCommand === "string" &&
          call.executeCommand.includes("printf '%s'") &&
          call.executeCommand.includes("/tmp/makeademo/sandbox-log.jsonl"),
      )
      .map((call) => call.executeCommand);
    expect(sandboxLogWrites).not.toHaveLength(0);
    for (const command of sandboxLogWrites) {
      expect(countOccurrences(command, '"workspaceId"')).toBe(1);
      expect(countOccurrences(command, '"message"')).toBe(1);
      expect(command).not.toContain('"timestamp"');
      expect(command).not.toContain("/tmp/makeademo/submitted-code");
    }
    expect(
      calls.filter(
        (call) =>
          typeof call === "object" && call !== null && "createSession" in call,
      ),
    ).toHaveLength(0);
  });

  it("does not resolve sandbox logging until both durable appends finish", async () => {
    const calls: unknown[] = [];
    const workspaceLogWriteStarted = deferred<void>();
    const workspaceLogWrite = deferred<void>();
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        awaitWorkspaceLogWrite: workspaceLogWrite.promise,
        onWorkspaceLogWriteStarted: workspaceLogWriteStarted.resolve,
      }),
    });
    const handle = await provider.create();

    let resolved = false;
    const write = handle.workspace
      .writeSandboxLog?.({
        event: "repo-preparation.started",
        stage: "repo-preparation",
      })
      .then(() => {
        resolved = true;
      });

    await workspaceLogWriteStarted.promise;

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            "tee -a '/tmp/makeademo/sandbox-log.jsonl' >> '/workspace/.makeademo/sandbox-log.jsonl'",
          ),
        },
      ]),
    );
    expect(resolved).toBe(false);

    workspaceLogWrite.resolve();
    await expect(write).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("surfaces sandbox logging failures when a durable path is unavailable", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { failWorkspaceLogWrite: true }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeSandboxLog?.({
        event: "repo-preparation.started",
        stage: "repo-preparation",
      }),
    ).rejects.toThrow("Failed to write Daytona sandbox audit log.");

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            "tee -a '/tmp/makeademo/sandbox-log.jsonl' >> '/workspace/.makeademo/sandbox-log.jsonl'",
          ),
        },
      ]),
    );
  });

  it("fails fast when a durable sandbox log write does not finish", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandNeverResolves: true }),
      logWriteTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeSandboxLog?.({
        event: "demo-runtime-preflight.started",
        stage: "demo-runtime-preflight",
      }),
    ).rejects.toThrow("Daytona sandbox log write did not finish within 1ms.");
  });

  it("disconnects active streaming commands before archiving the sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyWaitsForDisconnect: true,
      }),
    });
    const handle = await provider.create();

    const execution = handle.workspace.execute("opencode run slow", {
      onStdout: () => {},
    });
    await waitForPtyPayloads(calls, 1);
    await handle.release();

    await expect(execution).resolves.toMatchObject({ exitCode: 7 });
    expect(calls).toEqual(
      expect.arrayContaining([
        { disconnect: true },
        { archive: "sandbox_123" },
      ]),
    );
    expect(
      calls.findIndex((call) => "disconnect" in Object(call)),
    ).toBeLessThan(calls.findIndex((call) => "archive" in Object(call)));
  });

  it("kills active streaming commands before disconnecting so cancellation settles", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitsForKill: true }),
    });
    const handle = await provider.create();

    const execution = handle.workspace.execute("opencode run slow", {
      onStdout: () => {},
    });
    await waitForPtyPayloads(calls, 1);

    await Promise.all([
      handle.workspace.cancelActiveCommands?.(),
      handle.workspace.cancelActiveCommands?.(),
    ]);
    await expect(
      Promise.race([
        execution,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("cancellation did not settle")),
            100,
          ),
        ),
      ]),
    ).resolves.toMatchObject({ exitCode: 7 });

    const killIndex = calls.findIndex((call) => "kill" in Object(call));
    const disconnectIndex = calls.findIndex(
      (call) => "disconnect" in Object(call),
    );
    expect(killIndex).toBeGreaterThanOrEqual(0);
    expect(killIndex).toBeLessThan(disconnectIndex);
    expect(calls.filter((call) => "kill" in Object(call))).toHaveLength(1);
    expect(calls.filter((call) => "disconnect" in Object(call))).toHaveLength(
      1,
    );
  });

  it("times out and disconnects a streaming command that never finishes", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyWaitsForDisconnect: true,
        ptySuppressExitMarker: true,
      }),
      commandTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run slow", { onStdout: () => {} }),
    ).rejects.toThrow("Daytona command did not finish within 1ms.");

    expect(calls).toEqual(expect.arrayContaining([{ disconnect: true }]));
  });

  it("passes streaming command environment variables through PTY options", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.execute("opencode run hello", {
      env: { OPENCODE_CONFIG_DIR: "/tmp/makeademo/opencode" },
      onStdout: () => {},
    });

    expect(calls[1]).toEqual({
      createPty: expect.objectContaining({
        envs: { OPENCODE_CONFIG_DIR: "/tmp/makeademo/opencode" },
      }),
    });
  });

  it("fails fast when a streaming PTY never connects", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyNeverConnects: true }),
      ptyConnectionTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", {
        onStdout: () => {},
      }),
    ).rejects.toThrow("Daytona PTY did not connect within 1ms");

    expect(calls).toEqual(
      expect.arrayContaining([
        { waitForConnection: true },
        { disconnect: true },
      ]),
    );
  });

  it("retries streaming PTY startup before sending the command", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyConnectionFailuresBeforeSuccess: 1 }),
      ptyConnectionTimeoutMs: 1,
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello", {
      onStdout: () => {},
    });

    expect(result).toMatchObject({ exitCode: 7, stdout: "hello\n" });
    expect(calls.filter((call) => "createPty" in Object(call))).toHaveLength(2);
    expect(
      calls.filter((call) => "waitForConnection" in Object(call)),
    ).toHaveLength(2);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(2);
  });

  it("retries streaming PTY startup with a fresh id after stale duplicate-id creation", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyStaleDuplicateIdOnFirstCreate: true }),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello", {
      onStdout: () => {},
    });

    const ptyIds = calls
      .filter(
        (call): call is { createPty: { id: string } } =>
          typeof call === "object" &&
          call !== null &&
          "createPty" in call &&
          typeof call.createPty === "object" &&
          call.createPty !== null &&
          "id" in call.createPty &&
          typeof call.createPty.id === "string",
      )
      .map((call) => call.createPty.id);
    expect(result).toMatchObject({ exitCode: 7, stdout: "hello\n" });
    expect(ptyIds).toHaveLength(2);
    expect(ptyIds[1]).not.toBe(ptyIds[0]);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(2);
  });

  it("does not retry streaming PTY failures after sending the command", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptySuppressExitMarker: true,
      }),
      commandTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", { onStdout: () => {} }),
    ).rejects.toThrow("Daytona command did not finish within 1ms.");

    expect(calls.filter((call) => "createPty" in Object(call))).toHaveLength(1);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(2);
    expect(calls.filter((call) => "wait" in Object(call))).toHaveLength(0);
  });

  it("does not retry non-streaming command failures after PTY startup", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandFails: true }),
    });
    const handle = await provider.create();

    await expect(handle.workspace.execute("npm test")).rejects.toThrow(
      "executeCommand failed",
    );

    expect(calls.filter((call) => "createPty" in Object(call))).toHaveLength(1);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(2);
  });

  it("fails cleanly when streaming PTY startup retries are exhausted", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyConnectionFailuresBeforeSuccess: 99 }),
      ptyConnectionTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", { onStdout: () => {} }),
    ).rejects.toThrow("Daytona PTY did not connect within 1ms.");

    expect(calls.filter((call) => "createPty" in Object(call))).toHaveLength(3);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(0);
  });

  it("relays sandbox logs to configured sinks", async () => {
    const calls: unknown[] = [];
    const relayedLogs: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      sandboxLogSinks: [
        {
          write(line) {
            relayedLogs.push(line);
          },
        },
      ],
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog?.({
      event: "demo-runtime-preflight.dependency-install.started",
      stage: "demo-runtime-preflight",
      workspaceId: "workspace_123",
    });

    expect(relayedLogs).toHaveLength(1);
    expect(JSON.parse(relayedLogs[0] ?? "{}")).toMatchObject({
      component: "daytona-sandbox",
      event: "demo-runtime-preflight.dependency-install.started",
      message: "demo-runtime-preflight.dependency-install.started",
      stage: "demo-runtime-preflight",
      workspaceId: "workspace_123",
    });
  });

  it("creates an archivable submitted-code sandbox when configured", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      snapshot: "makeademo-opencode",
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    expect(handle.id).toBe("parent_sandbox");
    expect(calls.slice(0, 2)).toEqual([
      {
        create: {
          autoDeleteInterval: -1,
          autoStopInterval: 15,
          disk: 3,
          networkBlockAll: false,
          snapshot: "makeademo-opencode",
        },
      },
      {
        create: {
          autoDeleteInterval: -1,
          networkBlockAll: false,
          snapshot: "makeademo-submitted-code-browser",
          user: "root",
        },
      },
    ]);
    expect(calls[1]).not.toHaveProperty("create.ephemeral");
    expect(calls[1]).not.toHaveProperty("create.linkedSandbox");
  });

  it("rejects all public submitted execution until the workspace is synchronized", async () => {
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient([]),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await expect(
      handle.workspace.executeSubmittedCode?.("npm test"),
    ).rejects.toThrow("requires synchronization after provisioning");
    await expect(
      handle.workspace.executeMakeADemoCapture?.({
        runDirectory: "/workspace/.makeademo/capture-contract",
        scriptPath: "/workspace/.makeademo/capture-contract/demo.mjs",
        stderrPath: "/workspace/.makeademo/capture-contract/demo.stderr.log",
        stdoutPath: "/workspace/.makeademo/capture-contract/demo.stdout.log",
        timeoutMs: 16_500,
      }),
    ).rejects.toThrow("requires synchronization after provisioning");
  });

  it("can discard the parent after submitted-code sandbox creation fails", async () => {
    const calls: unknown[] = [];
    const parentSandbox = fakeLinkedSandbox(
      calls,
      "parent_sandbox",
      "parent ok",
    );
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          if (calls.filter((call) => "create" in Object(call)).length > 1) {
            throw new Error("linked create timed out");
          }

          return parentSandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      },
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    const handle = await provider.create();
    const plan = resolveSubmittedCodeToolchain(supportedPnpmMetadata("."));

    await expect(
      handle.workspace.provisionSubmittedCodeToolchain?.(plan),
    ).rejects.toThrow("linked create timed out");
    expect(calls).not.toContainEqual({ delete: "parent_sandbox" });

    await handle.discard?.();

    expect(calls).toEqual(
      expect.arrayContaining([{ delete: "parent_sandbox" }]),
    );
  });

  it("routes submitted-code execution and preview through the logical child sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    const getPreviewUrl = handle.workspace.getPreviewUrl?.bind(
      handle.workspace,
    );
    if (getPreviewUrl === undefined) {
      throw new Error("Provider did not expose preview URL support.");
    }

    const result = await handle.workspace.executeSubmittedCode?.("npm test");
    await expect(getPreviewUrl(3000)).resolves.toBe(
      "https://child-preview.example.test:3000",
    );

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "child ok" });
    expect(calls).toEqual(
      expect.arrayContaining([
        { createPty: "submitted_sandbox" },
        {
          decodedPtyScript: {
            sandbox: "submitted_sandbox",
            script: expect.stringContaining("runuser -u"),
          },
        },
        {
          getSignedPreviewUrl: {
            port: 3000,
            sandbox: "submitted_sandbox",
            ttl: 3600,
          },
        },
      ]),
    );
  });

  it("preserves submitted-code stdout, stderr, and exit status through cancellable execution", async () => {
    const calls: unknown[] = [];
    const behavior: FakeLinkedClientOptions = {};
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, behavior),
      commandTimeoutMs: 1,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    Object.assign(behavior, {
      commandExitCode: 23,
      commandStderr: "warning\n",
      commandStdout: "result\n",
    });

    await expect(
      handle.workspace.executeSubmittedCode?.("npm test"),
    ).resolves.toEqual({
      exitCode: 23,
      stderr: "warning\n",
      stdout: "result\n",
    });
  });

  it("preserves submitted-code bytes when the PTY emits CRLF framing", async () => {
    const behavior: FakeLinkedClientOptions = {};
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient([], behavior),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    Object.assign(behavior, {
      commandExitCode: 17,
      commandStderr: "warning\r\n",
      commandStdout: "first\r\nsecond\n",
      ptyUsesCrlf: true,
    });

    await expect(
      handle.workspace.executeSubmittedCode?.("npm test"),
    ).resolves.toEqual({
      exitCode: 17,
      stderr: "warning\r\n",
      stdout: "first\r\nsecond\n",
    });
  });

  it("keeps interactive prompts outside submitted-code result framing", async () => {
    const behavior: FakeLinkedClientOptions = {};
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient([], behavior),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    Object.assign(behavior, {
      commandStderr: "warning\n",
      commandStdout: "abc",
      ptyPrompt: "sandbox$ ",
      ptyUsesCrlf: true,
    });

    await expect(
      handle.workspace.executeSubmittedCode?.("npm test"),
    ).resolves.toEqual({
      exitCode: 0,
      stderr: "warning\n",
      stdout: "abc",
    });
  });

  it("completes submitted-code streaming from its trusted marker when Daytona PTY wait never completes", async () => {
    const calls: unknown[] = [];
    const streamed: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitsForDisconnect: true }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    calls.length = 0;

    const result = await handle.workspace.executeSubmittedCode?.(
      "node --version",
      {
        onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
        onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
        timeoutMs: 10,
      },
    );

    expect(result).toEqual({ exitCode: 7, stderr: "", stdout: "hello\n" });
    expect(streamed).toEqual(["stdout:hello\n"]);
    expect(calls.filter((call) => "wait" in Object(call))).toHaveLength(0);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          decodedPtyScript: expect.stringContaining("runuser -u"),
        },
      ]),
    );
    expect(calls).toEqual(expect.arrayContaining([{ disconnect: true }]));
  });

  it("materializes uploaded files in the logical child without its bulk upload API", async () => {
    const calls: unknown[] = [];
    const root = await mkdtemp(join(tmpdir(), "makeademo-child-upload-"));
    const parentWorkspace = join(root, "parent");
    const submittedWorkspace = join(root, "submitted");
    const sourcePath = join(root, "capture-script.ts");
    await mkdir(parentWorkspace, { recursive: true });
    await mkdir(submittedWorkspace, { recursive: true });
    await writeFile(sourcePath, "console.log('capture');\n");

    try {
      const provider = new DaytonaSdkPreparationWorkspaceProvider({
        client: fakeLocalShellLinkedClient(calls, {
          parentWorkspace,
          submittedWorkspace,
        }),
        submittedCodeSnapshot: "makeademo-submitted-code-browser",
      });
      const handle = await provider.create();
      await provisionToolchainForSubmittedCodeSync(handle);

      await handle.workspace.uploadSubmittedCodeFiles?.([
        {
          destinationPath: "/workspace/.makeademo/capture/script.ts",
          sourcePath,
        },
      ]);

      await expect(
        readFile(
          join(submittedWorkspace, ".makeademo/capture/script.ts"),
          "utf8",
        ),
      ).resolves.toBe("console.log('capture');\n");
      expect(calls).not.toContainEqual({
        uploadFiles: {
          files: [
            {
              destination: "/workspace/.makeademo/capture/script.ts",
              source: sourcePath,
            },
          ],
          sandbox: "submitted_sandbox",
        },
      });
      expect(calls).not.toContainEqual({
        uploadFiles: {
          files: [
            {
              destination: "/workspace/.makeademo/capture/script.ts",
              source: sourcePath,
            },
          ],
          sandbox: "parent_sandbox",
        },
      });
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            executeCommand: expect.objectContaining({
              sandbox: "submitted_sandbox",
            }),
          }),
        ]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("passes submitted-code environment through cancellable Daytona commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      commandTimeoutMs: 1_500,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    await handle.workspace.executeSubmittedCode?.("npm test", {
      env: { NODE_ENV: "test" },
    });

    expect(calls).toContainEqual({
      createPty: {
        cwd: "/workspace",
        envs: {},
        sandbox: "submitted_sandbox",
      },
    });
  });

  it("injects the trusted baked browser path into submitted-code execution", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    calls.length = 0;

    await handle.workspace.executeSubmittedCode?.("playwright-cli open", {
      env: {
        MAKEADEMO_PLAYWRIGHT_MODULE_ROOT:
          "/workspace/untrusted-playwright-modules",
        PLAYWRIGHT_BROWSERS_PATH: "/workspace/untrusted-browser-cache",
      },
    });

    const submittedScripts = calls
      .filter(
        (
          call,
        ): call is { decodedPtyScript: { sandbox: string; script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .filter(
        ({ decodedPtyScript }) =>
          decodedPtyScript.sandbox === "submitted_sandbox",
      )
      .map(({ decodedPtyScript }) => decodedPtyScript.script);

    expect(submittedScripts).toHaveLength(1);
    expect(submittedScripts[0]).toContain("PLAYWRIGHT_BROWSERS_PATH=");
    expect(submittedScripts[0]).toContain("/ms-playwright");
    expect(submittedScripts[0]).toContain("MAKEADEMO_PLAYWRIGHT_MODULE_ROOT=");
    expect(submittedScripts[0]).toContain(
      "/opt/makeademo/playwright-runtime/node_modules",
    );
    expect(submittedScripts.join("\n")).not.toContain(
      "/workspace/untrusted-browser-cache",
    );
    expect(submittedScripts.join("\n")).not.toContain(
      "/workspace/untrusted-playwright-modules",
    );
  });

  it("retains the trusted Playwright runtime after package-manager artifact binding", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    const { plan } = await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    calls.length = 0;

    await handle.workspace.executeSubmittedRuntime?.({
      command: "node capture-script.mjs",
      plan,
    });

    const submittedExecution = calls
      .filter(
        (
          call,
        ): call is { decodedPtyScript: { sandbox: string; script: string } } =>
          typeof call === "object" &&
          call !== null &&
          "decodedPtyScript" in call,
      )
      .filter(
        ({ decodedPtyScript }) =>
          decodedPtyScript.sandbox === "submitted_sandbox",
      )
      .map(({ decodedPtyScript }) =>
        decodeSubmittedExecutionFromFramedScript(decodedPtyScript.script),
      )
      .find((execution) => execution?.command.includes("capture-script.mjs"));

    expect(submittedExecution?.env).toMatchObject({
      MAKEADEMO_PLAYWRIGHT_MODULE_ROOT:
        "/opt/makeademo/playwright-runtime/node_modules",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    });
    expect(JSON.stringify(submittedExecution)).not.toContain(
      "/workspace/repository",
    );
  });

  it("fails fast when non-stream submitted-code execution does not finish", async () => {
    const calls: unknown[] = [];
    const behavior: FakeLinkedClientOptions = {};
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, behavior),
      commandTimeoutMs: 1,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    behavior.executeCommandNeverResolves = true;

    await expect(
      handle.workspace.executeSubmittedCode?.("npm ci"),
    ).rejects.toThrow("Daytona command did not finish within 1ms.");

    expect(calls).toEqual(
      expect.arrayContaining([
        { createPty: "submitted_sandbox" },
        { killPty: "submitted_sandbox" },
      ]),
    );
  });

  it("retries an invalid Daytona bearer token once with fresh archive paths and telemetry", async () => {
    const calls: unknown[] = [];
    const relayedLogs: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        archiveAuthFailuresBeforeSuccess: 1,
      }),
      sandboxLogSinks: [{ write: (line) => void relayedLogs.push(line) }],
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();

    const archiveCommands = calls
      .filter((call) => isArchiveCall(call, "parent_sandbox"))
      .map(
        (call) =>
          (call as { executeCommand: { command: string } }).executeCommand
            .command,
      );
    expect(archiveCommands).toHaveLength(2);
    expect(
      new Set(
        archiveCommands.map(
          (command) => command.match(/prepared-workspace-[a-f0-9-]+\.tgz/)?.[0],
        ),
      ),
    ).toHaveLength(2);
    expect(
      calls.filter(
        (call) =>
          typeof call === "object" && call !== null && "uploadFiles" in call,
      ),
    ).toHaveLength(1);
    expect(calls.filter((call) => isCleanupCall(call))).toHaveLength(4);

    const events = relayedLogs.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "daytona.sync-submitted-code-workspace.started",
        }),
        expect.objectContaining({
          event: "daytona.sync-submitted-code-workspace.operation.failed",
          operation: "archive",
          attempt: 1,
          maxAttempts: 2,
        }),
        expect.objectContaining({
          event: "daytona.sync-submitted-code-workspace.retrying",
          attempt: 1,
          maxAttempts: 2,
        }),
        expect.objectContaining({
          event: "daytona.sync-submitted-code-workspace.succeeded",
          attempt: 2,
          maxAttempts: 2,
        }),
      ]),
    );
  });

  it("does not retry a near-match Daytona authentication error", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        archiveAuthError:
          "unauthorized: authentication failed: Bearer token is invalid (temporary)",
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await provisionToolchainForSubmittedCodeSync(handle);
    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow(
      "unauthorized: authentication failed: Bearer token is invalid (temporary)",
    );
    expect(
      calls.filter(
        (call) =>
          typeof call === "object" && call !== null && "uploadFiles" in call,
      ),
    ).toHaveLength(0);
  });

  it("restores submitted-code workspace through a POSIX shell while preserving dependency stores and replacing repository cache state", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-daytona-shell-"));
    const parentWorkspace = join(root, "parent");
    const submittedWorkspace = join(root, "submitted");
    const calls: unknown[] = [];
    await mkdir(join(parentWorkspace, ".makeademo"), { recursive: true });
    await mkdir(join(parentWorkspace, ".cache", "nested"), { recursive: true });
    await mkdir(join(parentWorkspace, ".bun"), { recursive: true });
    await mkdir(join(parentWorkspace, ".npm"), { recursive: true });
    await mkdir(join(parentWorkspace, "packages", "web", ".next", "cache"), {
      recursive: true,
    });
    await mkdir(join(parentWorkspace, "node_modules"), { recursive: true });
    await mkdir(join(parentWorkspace, "packages", "web", "node_modules"), {
      recursive: true,
    });
    await mkdir(join(submittedWorkspace, "node_modules"), { recursive: true });
    await mkdir(join(submittedWorkspace, "packages", "web", "node_modules"), {
      recursive: true,
    });
    await mkdir(join(submittedWorkspace, ".cache", "nested"), {
      recursive: true,
    });
    await mkdir(join(submittedWorkspace, ".bun"), { recursive: true });
    await mkdir(join(submittedWorkspace, ".npm"), { recursive: true });
    await writeFile(join(parentWorkspace, "package.json"), "prepared app");
    await writeFile(join(parentWorkspace, ".env.local"), "prepared secret");
    await writeFile(
      join(parentWorkspace, "packages", "web", "route.ts"),
      "prepared route",
    );
    await writeFile(
      join(parentWorkspace, ".makeademo", "capture.webm"),
      "generated artifact",
    );
    await writeFile(
      join(parentWorkspace, "node_modules", "prepared-cache.txt"),
      "must stay excluded",
    );
    await writeFile(
      join(
        parentWorkspace,
        "packages",
        "web",
        "node_modules",
        "prepared-cache.txt",
      ),
      "must stay excluded",
    );
    await writeFile(
      join(parentWorkspace, ".cache", "nested", "prepared.txt"),
      "prepared application cache",
    );
    await writeFile(
      join(parentWorkspace, ".bun", "prepared.txt"),
      "prepared bun state",
    );
    await writeFile(
      join(parentWorkspace, ".npm", "prepared.txt"),
      "prepared npm state",
    );
    await writeFile(
      join(submittedWorkspace, "node_modules", "preserved-cache.txt"),
      "keep me",
    );
    await writeFile(join(submittedWorkspace, "stale.txt"), "remove me");
    await writeFile(join(submittedWorkspace, ".env.local"), "stale secret");
    await writeFile(
      join(submittedWorkspace, ".cache", "nested", "stale.txt"),
      "remove me",
    );
    await writeFile(join(submittedWorkspace, ".bun", "stale.txt"), "remove me");
    await writeFile(join(submittedWorkspace, ".npm", "stale.txt"), "remove me");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLocalShellLinkedClient(calls, {
        parentWorkspace,
        submittedWorkspace,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    try {
      const handle = await provider.create();

      await provisionToolchainForSubmittedCodeSync(handle);
      await handle.workspace.syncSubmittedCodeWorkspace?.();

      await expect(
        readFile(join(submittedWorkspace, "package.json"), "utf8"),
      ).resolves.toBe("prepared app");
      await expect(
        readFile(
          join(submittedWorkspace, "node_modules", "preserved-cache.txt"),
          "utf8",
        ),
      ).resolves.toBe("keep me");
      await expectPathMissing(
        join(submittedWorkspace, "node_modules", "prepared-cache.txt"),
      );
      await expect(
        readFile(join(submittedWorkspace, ".env.local"), "utf8"),
      ).resolves.toBe("prepared secret");
      await expect(
        readFile(
          join(submittedWorkspace, "packages", "web", "route.ts"),
          "utf8",
        ),
      ).resolves.toBe("prepared route");
      await expectPathMissing(
        join(
          submittedWorkspace,
          "packages",
          "web",
          "node_modules",
          "prepared-cache.txt",
        ),
      );
      await expect(
        readFile(
          join(submittedWorkspace, ".cache", "nested", "prepared.txt"),
          "utf8",
        ),
      ).resolves.toBe("prepared application cache");
      await expect(
        readFile(join(submittedWorkspace, ".bun", "prepared.txt"), "utf8"),
      ).resolves.toBe("prepared bun state");
      await expect(
        readFile(join(submittedWorkspace, ".npm", "prepared.txt"), "utf8"),
      ).resolves.toBe("prepared npm state");
      await expectPathMissing(
        join(submittedWorkspace, ".cache", "nested", "stale.txt"),
      );
      await expectPathMissing(join(submittedWorkspace, ".bun", "stale.txt"));
      await expectPathMissing(join(submittedWorkspace, ".npm", "stale.txt"));
      await access(join(submittedWorkspace, ".makeademo", "tmp"));
      await access(join(submittedWorkspace, ".makeademo", "cache"));
      await expectPathMissing(
        join(submittedWorkspace, ".makeademo", "capture.webm"),
      );
      await expectPathMissing(join(submittedWorkspace, "stale.txt"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports parent archive stdout, stderr, and exit code when archiving prepared files fails", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        failParentArchive: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await provisionToolchainForSubmittedCodeSync(handle);
    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow(
      "Failed to archive prepared Daytona workspace (exit code 8). stderr: tar: permission denied stdout: archive started",
    );
  });

  it("reports submitted-code restore stderr when extracting prepared files fails", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        failSubmittedRestore: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await provisionToolchainForSubmittedCodeSync(handle);
    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow(
      "Failed to restore prepared files in submitted-code sandbox (exit code 9). stderr: tar: corrupt archive stdout: restore started",
    );
  });

  it("fails sync when Daytona archive transfer hangs without waiting for remote cleanup", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        downloadFilesNeverResolves: true,
        remoteCleanupNeverResolves: true,
      }),
      commandTimeoutMs: 1,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await provisionToolchainForSubmittedCodeSync(handle);
    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow(
      "Daytona prepared workspace archive download did not finish within 1ms.",
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: {
            command: expect.stringContaining("rm -f"),
            sandbox: "parent_sandbox",
          },
        },
        {
          executeCommand: {
            command: expect.stringContaining("rm -f"),
            sandbox: "submitted_sandbox",
          },
        },
      ]),
    );
  });

  it("releases a submitted-code workspace by stopping and archiving the child before the primary", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await handle.release();

    expect(
      calls.filter(
        (call) =>
          "stop" in Object(call) ||
          "archive" in Object(call) ||
          "delete" in Object(call),
      ),
    ).toEqual([
      { stop: "submitted_sandbox" },
      { archive: "submitted_sandbox" },
      { stop: "parent_sandbox" },
      { archive: "parent_sandbox" },
    ]);
    expect(calls).not.toContainEqual({ delete: "submitted_sandbox" });
    expect(calls).not.toContainEqual({ delete: "parent_sandbox" });
  });

  it("stops and archives both sandboxes without changing network policy", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await handle.release();

    expect(
      calls.filter(
        (call) =>
          "stop" in Object(call) ||
          "archive" in Object(call) ||
          "delete" in Object(call),
      ),
    ).toEqual([
      { stop: "submitted_sandbox" },
      { archive: "submitted_sandbox" },
      { stop: "parent_sandbox" },
      { archive: "parent_sandbox" },
    ]);
  });

  it("cancels active primary and submitted-code commands before release", async () => {
    const calls: unknown[] = [];
    const behavior: FakeLinkedClientOptions = {};
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, behavior),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    await handle.workspace.syncSubmittedCodeWorkspace?.();
    Object.assign(behavior, {
      executeCommandNeverResolves: true,
      ptyWaitsForKill: true,
    });
    calls.length = 0;

    const primaryExecution = handle.workspace.execute("slow primary command", {
      onStdout: () => {},
    });
    const submittedExecution = handle.workspace.executeSubmittedCode?.(
      "slow submitted command",
    );
    await waitForPtyPayloads(calls, 2);

    await handle.release();

    await expect(primaryExecution).resolves.toMatchObject({ exitCode: 143 });
    await expect(
      Promise.race([
        submittedExecution,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("submitted command did not cancel")),
            100,
          ),
        ),
      ]),
    ).resolves.toMatchObject({ exitCode: 143 });
    expect(calls).toEqual(
      expect.arrayContaining([
        { killPty: "parent_sandbox" },
        { killPty: "submitted_sandbox" },
      ]),
    );
  });

  it("cancels a non-streaming primary setup command before release", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        executeCommandNeverResolves: true,
        ptyWaitsForKill: true,
      }),
    });
    const handle = await provider.create();

    const execution = handle.workspace.execute("slow setup command");
    await waitForPtyPayloads(calls, 1);
    await handle.release();

    await expect(
      Promise.race([
        execution,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("primary setup command did not cancel")),
            100,
          ),
        ),
      ]),
    ).resolves.toMatchObject({ exitCode: 143 });
    const primaryKill = calls.findIndex(
      (call) =>
        "killPty" in Object(call) &&
        (call as { killPty?: unknown }).killPty === "parent_sandbox",
    );
    expect(primaryKill).toBeGreaterThanOrEqual(0);
  });

  it("cancels the primary agent handoff command before release", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        executeCommandNeverResolves: true,
        ptyWaitsForKill: true,
      }),
    });
    const handle = await provider.create();

    const handoff = handle.workspace.prepareForAgent?.();
    await waitForPtyPayloads(calls, 1);
    await handle.release();

    await expect(
      Promise.race([
        handoff,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("agent handoff command did not cancel")),
            100,
          ),
        ),
      ]),
    ).rejects.toThrow("Failed to hand the cloned workspace to the agent user");
    const primaryKill = calls.findIndex(
      (call) =>
        "killPty" in Object(call) &&
        (call as { killPty?: unknown }).killPty === "parent_sandbox",
    );
    expect(primaryKill).toBeGreaterThanOrEqual(0);
  });

  it("releases both sandboxes without changing network policy", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await handle.release();
    expect(calls.slice(-4)).toEqual([
      { stop: "submitted_sandbox" },
      { archive: "submitted_sandbox" },
      { stop: "parent_sandbox" },
      { archive: "parent_sandbox" },
    ]);
  });

  it("does not archive when stopping the primary fails", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, { failStop: true }),
    });
    const handle = await provider.create();

    await expect(handle.release()).rejects.toThrow("primary stop failed");
    expect(calls).toContainEqual({ stop: "parent_sandbox" });
    expect(calls).not.toContainEqual({ archive: "parent_sandbox" });
  });

  it("reports submitted-code stop failure while still cleaning up the primary", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, { failSubmittedStop: true }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await expect(handle.release()).rejects.toThrow(
      "submitted-code stop failed",
    );
    expect(
      calls.filter(
        (call) => "stop" in Object(call) || "archive" in Object(call),
      ),
    ).toEqual([
      { stop: "submitted_sandbox" },
      { stop: "parent_sandbox" },
      { archive: "parent_sandbox" },
    ]);
  });

  it("reports submitted-code archive failure while still cleaning up the primary", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, { failSubmittedArchive: true }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await expect(handle.release()).rejects.toThrow(
      "submitted-code archive failed",
    );
    expect(
      calls.filter(
        (call) => "stop" in Object(call) || "archive" in Object(call),
      ),
    ).toEqual([
      { stop: "submitted_sandbox" },
      { archive: "submitted_sandbox" },
      { stop: "parent_sandbox" },
      { archive: "parent_sandbox" },
    ]);
  });

  it("reports an archive failure after stopping the primary", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, { failArchive: true }),
    });
    const handle = await provider.create();

    await expect(handle.release()).rejects.toThrow("primary archive failed");
    expect(calls.slice(-2)).toEqual([
      { stop: "parent_sandbox" },
      { archive: "parent_sandbox" },
    ]);
  });

  it("releases a workspace without a submitted-code sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
    });
    const handle = await provider.create();

    await handle.release();

    expect(calls.slice(-2)).toEqual([
      { stop: "parent_sandbox" },
      { archive: "parent_sandbox" },
    ]);
    expect(calls).not.toContainEqual({ delete: "parent_sandbox" });
  });

  it("releases at most once when called concurrently", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);

    await Promise.all([handle.release(), handle.release()]);
    expect(calls.filter((call) => "stop" in Object(call))).toEqual([
      { stop: "submitted_sandbox" },
      { stop: "parent_sandbox" },
    ]);
    expect(calls.filter((call) => "archive" in Object(call))).toEqual([
      { archive: "submitted_sandbox" },
      { archive: "parent_sandbox" },
    ]);
  });

  it("does not archive a rejected workspace when release races with discard", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();
    await provisionToolchainForSubmittedCodeSync(handle);
    calls.length = 0;

    await Promise.all([handle.discard?.(), handle.release()]);

    expect(calls).toEqual([
      { delete: "submitted_sandbox" },
      { delete: "parent_sandbox" },
    ]);
  });
});

type FakeLinkedClientOptions = {
  deprecatedPackageManagerRelease?: boolean;
  archiveAuthError?: string;
  archiveAuthFailuresBeforeSuccess?: number;
  commandExitCode?: number;
  commandStderr?: string;
  commandStdout?: string;
  downloadFilesNeverResolves?: boolean;
  executeCommandNeverResolves?: boolean;
  failParentArchive?: boolean;
  failArchive?: boolean;
  failSubmittedRestore?: boolean;
  failSubmittedArchive?: boolean;
  failSubmittedStop?: boolean;
  failStop?: boolean;
  ptyWaitsForKill?: boolean;
  ptyPrompt?: string;
  ptyUsesCrlf?: boolean;
  remoteCleanupNeverResolves?: boolean;
};

function fakeLinkedClient(
  calls: unknown[],
  options: FakeLinkedClientOptions = {},
) {
  const parentSandbox = fakeLinkedSandbox(
    calls,
    "parent_sandbox",
    "parent ok",
    options,
  );
  const childSandbox = fakeLinkedSandbox(
    calls,
    "submitted_sandbox",
    "child ok",
    options,
  );

  return {
    async create(input: unknown) {
      calls.push({ create: input });
      if (calls.filter((call) => "create" in Object(call)).length > 1) {
        return childSandbox;
      }

      return parentSandbox;
    },
    async delete(input: { id?: string; name?: string }) {
      calls.push({ delete: input.id ?? input.name });
    },
  };
}

function fakeCommandTimeoutClient(
  calls: unknown[],
  options: {
    deprecatedPackageManagerRelease?: boolean;
    emulateLinuxRootArtifactWriteAccess?: boolean;
    emulatedYarnCliSha512?: string;
    executeQuiescenceLocally?: boolean;
    nodeProvisioningFailure?: boolean;
    packageManagerVerificationFailure?: boolean;
    resourceSnapshots?: string[];
    malformedRetainedRuntimeIdentity?: boolean;
    quiescenceIdentityMismatch?: boolean;
    quiescencePortOccupied?: boolean;
    retainedRuntimeIdentity?: {
      processGroupId: number;
      processId: number;
      processStartTimeTicks: number;
      sessionId: number;
    };
    retainedRuntimePid?: number;
    submittedInstallExitCode?: number;
    submittedIntegrityFailureAttempt?: number;
    unavailablePackageManagerRelease?: boolean;
  } = {},
) {
  const parentSandbox = fakeCommandTimeoutSandbox(
    calls,
    "parent_sandbox",
    options,
  );
  const childSandbox = fakeCommandTimeoutSandbox(
    calls,
    "submitted_sandbox",
    options,
  );

  return {
    async create(input: unknown) {
      calls.push({ create: input });
      if (calls.filter((call) => "create" in Object(call)).length > 1) {
        return childSandbox;
      }

      return parentSandbox;
    },
    async delete(input: { id?: string; name?: string }) {
      calls.push({ delete: input.id ?? input.name });
    },
  };
}

function fakeCommandTimeoutSandbox(
  calls: unknown[],
  id: string,
  options: {
    deprecatedPackageManagerRelease?: boolean;
    emulateLinuxRootArtifactWriteAccess?: boolean;
    emulatedYarnCliSha512?: string;
    executeQuiescenceLocally?: boolean;
    nodeProvisioningFailure?: boolean;
    packageManagerVerificationFailure?: boolean;
    resourceSnapshots?: string[];
    malformedRetainedRuntimeIdentity?: boolean;
    quiescenceIdentityMismatch?: boolean;
    quiescencePortOccupied?: boolean;
    retainedRuntimeIdentity?: {
      processGroupId: number;
      processId: number;
      processStartTimeTicks: number;
      sessionId: number;
    };
    retainedRuntimePid?: number;
    submittedInstallExitCode?: number;
    submittedIntegrityFailureAttempt?: number;
    unavailablePackageManagerRelease?: boolean;
  },
) {
  let submittedIntegrityAttempt = 0;
  return {
    async archive() {
      calls.push({ archive: id });
    },
    fs: {
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
      ) {
        return files.map((file) => ({ source: file.source }));
      },
      async uploadFiles() {},
    },
    id,
    async stop() {
      calls.push({ stop: id });
    },
    async getSignedPreviewUrl(port: number) {
      return { url: `https://${id}.example.test:${port}` };
    },
    process: {
      async createPty(ptyOptions: {
        cwd?: string;
        envs?: Record<string, string>;
        onData: (data: Uint8Array) => void;
      }) {
        calls.push({
          createPty: {
            cwd: ptyOptions.cwd,
            envs: ptyOptions.envs,
            sandbox: id,
          },
        });
        let disconnected = false;
        let killed = false;
        return {
          async disconnect() {
            if (disconnected) return;
            disconnected = true;
            calls.push({ disconnectPty: id });
          },
          async kill() {
            if (killed) return;
            killed = true;
            calls.push({ killPty: id });
          },
          async sendInput(data: string | Uint8Array) {
            const input = String(data);
            calls.push({ sendInput: { data: input, sandbox: id } });
            const readyMarker = input.match(
              /__MAKEADEMO_PTY_READY__:[0-9a-f-]+:/,
            )?.[0];
            if (readyMarker !== undefined) {
              ptyOptions.onData(new TextEncoder().encode(`\n${readyMarker}\n`));
              return;
            }
            const script = decodeNoninteractivePtyCommand(input);
            calls.push({ decodedPtyScript: { sandbox: id, script } });
            if (
              options.executeQuiescenceLocally === true &&
              id === "submitted_sandbox" &&
              script.includes("/dev/tcp/127.0.0.1/")
            ) {
              const execution = await execFileAsync("/bin/sh", ["-c", script]);
              ptyOptions.onData(new TextEncoder().encode(execution.stdout));
              return;
            }
            const verifiesSubmittedIntegrity =
              id === "submitted_sandbox" &&
              script.includes("MAKEADEMO_VERIFY_PROJECT_INTEGRITY");
            if (verifiesSubmittedIntegrity) submittedIntegrityAttempt += 1;
            const integrityFails =
              verifiesSubmittedIntegrity &&
              submittedIntegrityAttempt ===
                options.submittedIntegrityFailureAttempt;
            const rootFalselyAppearsWritable =
              options.emulateLinuxRootArtifactWriteAccess === true &&
              id === "submitted_sandbox" &&
              /(?:^|&& )test ! -w "\$toolchain_home"(?: &&|$)/.test(script);
            const yarnCliDigestMismatch =
              options.emulatedYarnCliSha512 !== undefined &&
              declaredYarnCliSha512(script) !== undefined &&
              declaredYarnCliSha512(script) !== options.emulatedYarnCliSha512;
            const nodeProvisioningFails =
              options.nodeProvisioningFailure === true &&
              trustedNodeProvisionAttestation(script) !== undefined;
            const packageManagerVerificationFails =
              options.packageManagerVerificationFailure === true &&
              script.includes("MAKEADEMO_VERIFY_TRUSTED_ARTIFACT");
            const deprecatedPackageManagerRelease =
              options.deprecatedPackageManagerRelease === true &&
              script.includes("MAKEADEMO_REGISTRY_RELEASE_DEPRECATED");
            const unavailablePackageManagerRelease =
              options.unavailablePackageManagerRelease === true &&
              script.includes("MAKEADEMO_REGISTRY_RELEASE_UNAVAILABLE");
            const resourceSnapshot = script.includes(
              "MAKEADEMO_RESOURCE_SNAPSHOT=1",
            );
            const submittedExecution =
              decodeSubmittedExecutionFromFramedScript(script);
            const submittedInstall =
              id === "submitted_sandbox" &&
              submittedExecution !== undefined &&
              /'(?:npm|pnpm|yarn|bun)' '(?:ci|install)'/.test(
                submittedExecution.command,
              );
            const isRetainedRuntimeStart =
              submittedExecution?.env.MAKEADEMO_RUNTIME_REPORT_TOKEN !==
              undefined;
            const retainedRuntimeIdentity = options.retainedRuntimeIdentity ?? {
              processGroupId: options.retainedRuntimePid ?? 4242,
              processId: options.retainedRuntimePid ?? 4242,
              processStartTimeTicks: 9001,
              sessionId: options.retainedRuntimePid ?? 4242,
            };
            const quiescencePortOccupied =
              options.quiescencePortOccupied === true &&
              script.includes("/dev/tcp/127.0.0.1/4173");
            const quiescenceIdentityMismatch =
              options.quiescenceIdentityMismatch === true &&
              script.includes("makeademo_identity_matches");
            if (unavailablePackageManagerRelease) {
              calls.push({ registryMetadataUnavailable: true });
            }
            emitFramedCommandResponse(script, ptyOptions.onData, {
              exitCode:
                unavailablePackageManagerRelease ||
                deprecatedPackageManagerRelease ||
                integrityFails ||
                rootFalselyAppearsWritable ||
                yarnCliDigestMismatch ||
                nodeProvisioningFails ||
                packageManagerVerificationFails
                  ? 1
                  : quiescenceIdentityMismatch
                    ? 72
                    : quiescencePortOccupied
                      ? 70
                      : submittedInstall
                        ? (options.submittedInstallExitCode ?? 0)
                        : 0,
              stderr: integrityFails
                ? "lock mismatch"
                : quiescenceIdentityMismatch
                  ? "retained process identity no longer matches; refusing to signal"
                  : quiescencePortOccupied
                    ? "retained process group 4242; listener pid=5151 pgid=5151 command=node"
                    : unavailablePackageManagerRelease
                      ? "MAKEADEMO_REGISTRY_RELEASE_UNAVAILABLE"
                      : deprecatedPackageManagerRelease
                        ? "MAKEADEMO_REGISTRY_RELEASE_DEPRECATED"
                        : rootFalselyAppearsWritable
                          ? "root reports the mode-read-only artifact as writable"
                          : yarnCliDigestMismatch
                            ? "launched Yarn CLI digest mismatch"
                            : nodeProvisioningFails
                              ? "signed Node manifest rejected"
                              : packageManagerVerificationFails
                                ? "trusted package-manager artifact changed"
                                : "",
              stdout:
                (resourceSnapshot
                  ? options.resourceSnapshots?.shift()
                  : undefined) ??
                (isRetainedRuntimeStart
                  ? `${submittedRuntimeIdentityMarker}:${submittedExecution.env.MAKEADEMO_RUNTIME_REPORT_TOKEN}:${retainedRuntimeIdentity.processId}:${options.malformedRetainedRuntimeIdentity === true ? retainedRuntimeIdentity.processGroupId + 1 : retainedRuntimeIdentity.processGroupId}:${retainedRuntimeIdentity.sessionId}:${retainedRuntimeIdentity.processStartTimeTicks}\n`
                  : undefined) ??
                trustedNodeProvisionAttestation(script) ??
                (script.includes("MAKEADEMO_ARTIFACT_SHA512")
                  ? hydrationAttestationStdout()
                  : script.includes("MAKEADEMO_ARTIFACT_SHA256")
                    ? bunHydrationAttestationStdout()
                    : "ok"),
            });
          },
          async wait() {
            return { exitCode: 0 };
          },
          async waitForConnection() {},
        };
      },
      async createSession() {},
      async deleteSession() {},
      async executeCommand(
        command: string,
        cwd?: string,
        env?: Record<string, string>,
        timeout?: number,
      ) {
        calls.push({
          executeCommand: { command, cwd, env, sandbox: id, timeout },
        });
        return { exitCode: 0, result: "ok" };
      },
      async executeSessionCommand() {
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand() {
        return { exitCode: 0 };
      },
      async getSessionCommandLogs() {
        return { stderr: "", stdout: "" };
      },
    },
  };
}

function declaredYarnCliSha512(script: string): string | undefined {
  const comparisonStart = script.indexOf(
    'test "sha512.$(sha512sum "$yarn_cli"',
  );
  if (comparisonStart < 0) return undefined;
  return /sha512\.([a-f0-9]{128})/.exec(
    script.slice(comparisonStart, comparisonStart + 512),
  )?.[1];
}

function decodedSubmittedScripts(calls: unknown[]): string[] {
  return calls.flatMap((call) => {
    if (
      typeof call !== "object" ||
      call === null ||
      !("decodedPtyScript" in call)
    ) {
      return [];
    }
    const decoded = (call as { decodedPtyScript?: unknown }).decodedPtyScript;
    if (typeof decoded !== "object" || decoded === null) return [];
    const record = decoded as { sandbox?: unknown; script?: unknown };
    return record.sandbox === "submitted_sandbox" &&
      typeof record.script === "string"
      ? [record.script]
      : [];
  });
}

function fakeLocalShellLinkedClient(
  calls: unknown[],
  workspaces: { parentWorkspace: string; submittedWorkspace: string },
) {
  const parentSandbox = fakeLocalShellSandbox(
    calls,
    "parent_sandbox",
    workspaces.parentWorkspace,
  );
  const childSandbox = fakeLocalShellSandbox(
    calls,
    "submitted_sandbox",
    workspaces.submittedWorkspace,
  );

  return {
    async create(input: unknown) {
      calls.push({ create: input });
      if (calls.filter((call) => "create" in Object(call)).length > 1) {
        return childSandbox;
      }

      return parentSandbox;
    },
    async delete(input: { id?: string; name?: string }) {
      calls.push({ delete: input.id ?? input.name });
    },
  };
}

function fakeLocalShellSandbox(
  calls: unknown[],
  id: string,
  workspacePath: string,
) {
  return {
    async archive() {
      calls.push({ archive: id });
    },
    fs: {
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
        timeoutSec?: number,
      ) {
        calls.push({ downloadFiles: { files, sandbox: id, timeoutSec } });
        for (const file of files) {
          await mkdir(dirname(file.destination), { recursive: true });
          await copyFile(file.source, file.destination);
        }
        return files.map((file) => ({ source: file.source }));
      },
      async uploadFiles(files: Array<{ destination: string; source: string }>) {
        calls.push({ uploadFiles: { files, sandbox: id } });
        for (const file of files) {
          const destination = file.destination.replace(
            "/workspace",
            workspacePath,
          );
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(file.source, destination);
        }
      },
    },
    id,
    async stop() {
      calls.push({ stop: id });
    },
    async getSignedPreviewUrl(port: number) {
      return { url: `https://local-shell.example.test:${port}` };
    },
    process: {
      async createPty(ptyOptions: { onData: (data: Uint8Array) => void }) {
        let disconnected = false;
        return {
          async disconnect() {
            if (disconnected) return;
            disconnected = true;
          },
          async kill() {},
          async sendInput(data: string | Uint8Array) {
            const input = String(data);
            const readyMarker = input.match(
              /__MAKEADEMO_PTY_READY__:[0-9a-f-]+:/,
            )?.[0];
            if (readyMarker !== undefined) {
              ptyOptions.onData(new TextEncoder().encode(`\n${readyMarker}\n`));
              return;
            }
            const script = decodeNoninteractivePtyCommand(input);
            calls.push({ decodedPtyScript: { sandbox: id, script } });
            emitFramedCommandResponse(script, ptyOptions.onData, {
              exitCode: 0,
              stderr: "",
              stdout:
                trustedNodeProvisionAttestation(script) ??
                (script.includes("MAKEADEMO_ARTIFACT_SHA512")
                  ? hydrationAttestationStdout()
                  : script.includes("MAKEADEMO_ARTIFACT_SHA256")
                    ? bunHydrationAttestationStdout()
                    : "ok"),
            });
          },
          async wait() {
            return { exitCode: 0 };
          },
          async waitForConnection() {},
        };
      },
      async createSession() {},
      async deleteSession() {},
      async executeCommand(command: string) {
        calls.push({ executeCommand: { command, sandbox: id } });
        return runLocalWorkspaceCommand(command, workspacePath);
      },
      async executeSessionCommand() {
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand() {
        return { exitCode: 0 };
      },
      async getSessionCommandLogs() {
        return { stderr: "", stdout: "" };
      },
    },
  };
}

async function runLocalWorkspaceCommand(
  command: string,
  workspacePath: string,
): Promise<{ exitCode: number; result: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      "/bin/sh",
      ["-c", command.replaceAll("/workspace", workspacePath)],
      { timeout: 5_000 },
    );
    return { exitCode: 0, result: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stderr?: string;
      stdout?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      result: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function isArchiveCall(call: unknown, sandbox: string): boolean {
  if (
    typeof call !== "object" ||
    call === null ||
    !("executeCommand" in call)
  ) {
    return false;
  }
  const executeCommand = (call as { executeCommand?: unknown }).executeCommand;
  if (typeof executeCommand !== "object" || executeCommand === null) {
    return false;
  }
  const command = executeCommand as { command?: unknown; sandbox?: unknown };
  return (
    command.sandbox === sandbox &&
    typeof command.command === "string" &&
    command.command.includes("tar ") &&
    command.command.includes("-czf")
  );
}

function isCleanupCall(call: unknown): boolean {
  if (
    typeof call !== "object" ||
    call === null ||
    !("executeCommand" in call)
  ) {
    return false;
  }
  const executeCommand = (call as { executeCommand?: unknown }).executeCommand;
  return (
    typeof executeCommand === "object" &&
    executeCommand !== null &&
    typeof (executeCommand as { command?: unknown }).command === "string" &&
    (executeCommand as { command: string }).command.startsWith("rm -f")
  );
}

function fakeLinkedSandbox(
  calls: unknown[],
  id: string,
  stdout: string,
  options: FakeLinkedClientOptions = {},
) {
  let archiveAuthFailures = options.archiveAuthFailuresBeforeSuccess ?? 0;
  return {
    async archive() {
      calls.push({ archive: id });
      if (options.failArchive === true && id === "parent_sandbox") {
        throw new Error("primary archive failed");
      }
      if (options.failSubmittedArchive === true && id === "submitted_sandbox") {
        throw new Error("submitted-code archive failed");
      }
    },
    fs: {
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
        timeoutSec?: number,
      ) {
        calls.push({ downloadFiles: { files, sandbox: id, timeoutSec } });
        if (options.downloadFilesNeverResolves === true) {
          await new Promise(() => {});
        }
        return files.map((file) => ({ source: file.source }));
      },
      async uploadFiles(files: unknown[]) {
        calls.push({ uploadFiles: { files, sandbox: id } });
      },
    },
    id,
    async stop() {
      calls.push({ stop: id });
      if (options.failStop === true && id === "parent_sandbox") {
        throw new Error("primary stop failed");
      }
      if (options.failSubmittedStop === true && id === "submitted_sandbox") {
        throw new Error("submitted-code stop failed");
      }
    },
    async getSignedPreviewUrl(port: number, ttl?: number) {
      calls.push({ getSignedPreviewUrl: { port, sandbox: id, ttl } });
      return {
        url: `https://${id === "submitted_sandbox" ? "child" : "parent"}-preview.example.test:${port}`,
      };
    },
    process: {
      async createPty(ptyOptions: { onData: (data: Uint8Array) => void }) {
        calls.push({ createPty: id });
        let disconnected = false;
        let killed = false;
        return {
          async disconnect() {
            if (disconnected) return;
            disconnected = true;
            calls.push({ disconnectPty: id });
          },
          async kill() {
            if (killed) return;
            killed = true;
            calls.push({ killPty: id });
          },
          async sendInput(data: string | Uint8Array) {
            const input = String(data);
            calls.push({ sendInput: { data: input, sandbox: id } });
            const readyMarker = input.match(
              /__MAKEADEMO_PTY_READY__:[0-9a-f-]+:/,
            )?.[0];
            if (readyMarker !== undefined) {
              const lineEnding = options.ptyUsesCrlf === true ? "\r\n" : "\n";
              ptyOptions.onData(
                new TextEncoder().encode(
                  `${lineEnding}${readyMarker}${lineEnding}${options.ptyPrompt ?? ""}`,
                ),
              );
              return;
            }
            if (
              options.ptyWaitsForKill !== true &&
              options.executeCommandNeverResolves !== true
            ) {
              const script = decodeNoninteractivePtyCommand(input);
              calls.push({ decodedPtyScript: { sandbox: id, script } });
              emitFramedCommandResponse(
                script,
                ptyOptions.onData,
                {
                  exitCode: options.commandExitCode ?? 0,
                  stderr: options.commandStderr ?? "",
                  stdout:
                    trustedNodeProvisionAttestation(script) ??
                    options.commandStdout ??
                    (script.includes("MAKEADEMO_ARTIFACT_SHA512")
                      ? hydrationAttestationStdout()
                      : script.includes("MAKEADEMO_ARTIFACT_SHA256")
                        ? bunHydrationAttestationStdout()
                        : stdout),
                },
                options.ptyUsesCrlf === true ? "\r\n" : "\n",
              );
            }
          },
          async wait() {
            if (options.ptyWaitsForKill === true) {
              while (!killed) await Promise.resolve();
            }
            return { exitCode: 0 };
          },
          async waitForConnection() {},
        };
      },
      async createSession() {},
      async deleteSession() {},
      async executeCommand(command: string) {
        calls.push({ executeCommand: { command, sandbox: id } });
        if (options.executeCommandNeverResolves === true) {
          await new Promise(() => {});
        }
        if (
          options.failParentArchive === true &&
          id === "parent_sandbox" &&
          command.includes("tar ") &&
          command.includes("-czf")
        ) {
          return {
            exitCode: 8,
            result: "archive started",
            stderr: "tar: permission denied",
          };
        }
        if (
          id === "parent_sandbox" &&
          command.includes("tar ") &&
          command.includes("-czf") &&
          (options.archiveAuthError !== undefined || archiveAuthFailures > 0)
        ) {
          if (archiveAuthFailures > 0) archiveAuthFailures -= 1;
          throw new Error(
            options.archiveAuthError ??
              "unauthorized: authentication failed: Bearer token is invalid",
          );
        }
        if (
          options.failSubmittedRestore === true &&
          id === "submitted_sandbox" &&
          command.includes("tar -xzf")
        ) {
          return {
            exitCode: 9,
            result: "restore started",
            stderr: "tar: corrupt archive",
          };
        }
        if (
          options.remoteCleanupNeverResolves === true &&
          command.includes("rm -f")
        ) {
          await new Promise(() => {});
        }
        return { exitCode: 0, result: stdout };
      },
      async executeSessionCommand() {
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand() {
        return { exitCode: 0 };
      },
      async getSessionCommandLogs() {
        return { stderr: "", stdout: "" };
      },
    },
  };
}

function decodeNoninteractivePtyCommand(input: string): string {
  const encoded = input.match(
    /^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| \/bin\/sh; exit\n$/,
  )?.[1];
  return encoded === undefined
    ? input
    : Buffer.from(encoded, "base64").toString("utf8");
}

function decodeSubmittedExecutionFromFramedScript(
  script: string,
): { command: string; env: Record<string, string> } | undefined {
  const framed =
    /\/bin\/sh -c '([\s\S]*?)' > '\/tmp\/makeademo\/command-[^']+\.stdout'/.exec(
      script,
    )?.[1];
  if (framed === undefined) return undefined;
  const wrapper = framed.replaceAll("'\\''", "'");
  const encoded = /^printf %s '([A-Za-z0-9+/=]+)' \| base64 --decode/.exec(
    wrapper,
  )?.[1];
  const environment = wrapper
    .split(" -- env -i ")[1]
    ?.split(" /bin/bash --noprofile --norc")[0];
  if (encoded === undefined || environment === undefined) return undefined;
  const env = Object.fromEntries(
    [...environment.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)='([^']*)'/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  return {
    command: Buffer.from(encoded, "base64").toString("utf8"),
    env,
  };
}

function testShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function emitFramedCommandResponse(
  input: string,
  onData: (data: Uint8Array) => void,
  result: { exitCode: number; stderr: string; stdout: string },
  lineEnding = "\n",
  prompt?: string,
): void {
  const stdoutMarker = input.match(
    /__MAKEADEMO_COMMAND_STDOUT__:[0-9a-f-]+:/,
  )?.[0];
  const stderrMarker = input.match(
    /__MAKEADEMO_COMMAND_STDERR__:[0-9a-f-]+:/,
  )?.[0];
  const commandExitMarker = input.match(
    /__MAKEADEMO_COMMAND_EXIT__:[0-9a-f-]+:/,
  )?.[0];
  const ptyExitMarker = input.match(/__MAKEADEMO_EXIT__:[0-9a-f-]+:/)?.[0];
  if (
    stdoutMarker === undefined ||
    stderrMarker === undefined ||
    commandExitMarker === undefined ||
    ptyExitMarker === undefined
  ) {
    throw new Error("cancellable command framing was missing");
  }
  onData(
    new TextEncoder().encode(
      [
        "",
        stdoutMarker,
        Buffer.from(result.stdout).toString("base64"),
        ...(prompt === undefined ? [] : [prompt]),
        stderrMarker,
        Buffer.from(result.stderr).toString("base64"),
        `${commandExitMarker}${result.exitCode}`,
        `${ptyExitMarker}0`,
        "",
      ].join(lineEnding),
    ),
  );
}

function fakeClient(
  calls: unknown[],
  options: {
    awaitWorkspaceLogWrite?: Promise<void>;
    downloadError?: string;
    downloadStreamChunks?: Buffer[];
    executeCommandFails?: boolean;
    executeCommandNeverResolves?: boolean;
    failFirstSubmittedCodeInitialization?: boolean;
    failWorkspaceLogWrite?: boolean;
    failSubmittedCodeNetworkDisable?: boolean;
    missingSubmittedCodeImage?: boolean;
    onWorkspaceLogWriteStarted?: () => void;
    previewNeverResolves?: boolean;
    ptyConnectionFailuresBeforeSuccess?: number;
    ptyEmitsForgedExitMarker?: boolean;
    ptyNeverConnects?: boolean;
    ptyStaleDuplicateIdOnFirstCreate?: boolean;
    ptyWaitFails?: boolean;
    ptyWaitsForKill?: boolean;
    ptyWaitsForDisconnect?: boolean;
    ptySuppressExitMarker?: boolean;
    ptyCommandResponse?: (
      script: string,
    ) => { exitCode: number; stderr: string; stdout: string } | undefined;
  } = {},
) {
  let submittedCodeInitializationFailures = 0;
  let ptyConnectionFailures = 0;
  const stalePtyIds = new Set<string>();
  const sandbox = {
    async archive() {
      calls.push({ archive: "sandbox_123" });
    },
    fs: {
      async downloadFileStream(
        sourcePath: string,
        streamOptions?: { signal?: AbortSignal; timeout?: number },
      ) {
        calls.push({
          downloadFileStream: {
            options: streamOptions ?? {},
            sandbox: "sandbox_123",
            sourcePath,
          },
        });
        return Readable.from(options.downloadStreamChunks ?? []);
      },
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
        timeoutSec?: number,
      ) {
        calls.push({ downloadFiles: { files, timeoutSec } });
        return files.map((file) => ({
          ...(options.downloadError === undefined
            ? {}
            : { error: options.downloadError }),
          source: file.source,
        }));
      },
      async uploadFiles(files: unknown[]) {
        calls.push({ uploadFiles: files });
      },
      async uploadFileStream(
        source: string,
        remotePath: string,
        uploadOptions?: { signal?: AbortSignal; timeout?: number },
      ) {
        calls.push({
          uploadFileStream: {
            options: uploadOptions ?? {},
            remotePath,
            source,
          },
        });
      },
    },
    id: "sandbox_123",
    async stop() {
      calls.push({ stop: "sandbox_123" });
    },
    async getSignedPreviewUrl(port: number, ttl?: number) {
      calls.push({ getSignedPreviewUrl: { port, ttl } });
      if (options.previewNeverResolves === true) {
        await new Promise(() => {});
      }
      return { url: `https://preview.example.test:${port}` };
    },
    process: {
      async createPty(ptyOptions: {
        id: string;
        cwd?: string;
        envs?: Record<string, string>;
        cols?: number;
        rows?: number;
        onData: (data: Uint8Array) => void;
      }) {
        calls.push({
          createPty: {
            cols: ptyOptions.cols,
            cwd: ptyOptions.cwd,
            envs: ptyOptions.envs,
            id: ptyOptions.id,
            rows: ptyOptions.rows,
          },
        });
        if (options.ptyStaleDuplicateIdOnFirstCreate === true) {
          if (stalePtyIds.size === 0) {
            stalePtyIds.add(ptyOptions.id);
            throw new Error("PTY session with ID already exists.");
          }
          if (stalePtyIds.has(ptyOptions.id)) {
            throw new Error("PTY session with ID already exists.");
          }
        }
        let disconnected = false;
        let killed = false;
        let resolveDisconnect: (() => void) | undefined;
        let resolveKill: (() => void) | undefined;
        const disconnectedPromise = new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        });
        const killedPromise = new Promise<void>((resolve) => {
          resolveKill = resolve;
        });
        return {
          async disconnect() {
            if (disconnected) {
              return;
            }
            disconnected = true;
            calls.push({ disconnect: true });
            resolveDisconnect?.();
          },
          async kill() {
            if (killed) {
              return;
            }
            killed = true;
            calls.push({ kill: true });
            resolveKill?.();
          },
          async sendInput(data: string | Uint8Array) {
            const input = String(data);
            calls.push({ sendInput: data });
            const readyMarker = input.match(
              /__MAKEADEMO_PTY_READY__:[0-9a-f-]+:/,
            )?.[0];
            if (readyMarker !== undefined) {
              ptyOptions.onData(new TextEncoder().encode(`\n${readyMarker}\n`));
              return;
            }
            if (options.executeCommandFails === true) {
              throw new Error("executeCommand failed");
            }
            if (options.executeCommandNeverResolves === true) return;
            const script = decodeNoninteractivePtyCommand(input);
            calls.push({ decodedPtyScript: script });
            if (script.includes("__MAKEADEMO_COMMAND_STDOUT__:")) {
              const configuredResponse = options.ptyCommandResponse?.(script);
              emitFramedCommandResponse(script, ptyOptions.onData, {
                ...(configuredResponse ?? {
                  exitCode: 0,
                  stderr: "",
                  stdout:
                    trustedNodeProvisionAttestation(script) ??
                    (script.includes("MAKEADEMO_ARTIFACT_SHA512")
                      ? hydrationAttestationStdout()
                      : script.includes("MAKEADEMO_ARTIFACT_SHA256")
                        ? bunHydrationAttestationStdout()
                        : "ok"),
                }),
              });
              return;
            }
            const exitMarker = script.match(
              /__MAKEADEMO_EXIT__:[0-9a-f-]+:/,
            )?.[0];
            if (exitMarker === undefined) {
              throw new Error("trusted PTY exit marker was missing");
            }
            ptyOptions.onData(new TextEncoder().encode("hello\n"));
            if (options.ptyEmitsForgedExitMarker === true) {
              ptyOptions.onData(
                new TextEncoder().encode("\n__MAKEADEMO_EXIT__:99\n"),
              );
            }
            if (options.ptySuppressExitMarker !== true) {
              ptyOptions.onData(new TextEncoder().encode(`\n${exitMarker}7\n`));
            }
          },
          async wait() {
            calls.push({ wait: true });
            if (options.ptyWaitFails === true) {
              throw new Error("PTY wait failed after command started.");
            }
            if (options.ptyWaitsForDisconnect === true) {
              await disconnectedPromise;
            } else if (options.ptyWaitsForKill === true) {
              await killedPromise;
            }
            return { exitCode: 0 };
          },
          async waitForConnection() {
            calls.push({ waitForConnection: true });
            if (
              ptyConnectionFailures <
              (options.ptyConnectionFailuresBeforeSuccess ?? 0)
            ) {
              ptyConnectionFailures += 1;
              await new Promise(() => {});
            }
            if (options.ptyNeverConnects === true) {
              await new Promise(() => {});
            }
          },
        };
      },
      async createSession(sessionId: string) {
        calls.push({ createSession: sessionId });
      },
      async deleteSession(sessionId: string) {
        calls.push({ deleteSession: sessionId });
      },
      async executeCommand(command: string) {
        calls.push({ executeCommand: command });
        if (options.executeCommandFails === true) {
          throw new Error("executeCommand failed");
        }
        if (options.executeCommandNeverResolves === true) {
          await new Promise(() => {});
        }
        if (
          options.failSubmittedCodeNetworkDisable === true &&
          command.includes("docker network disconnect bridge")
        ) {
          return {
            exitCode: 1,
            result: "",
            stderr: "failed to disable submitted-code network",
          };
        }
        if (
          options.awaitWorkspaceLogWrite !== undefined &&
          command.includes("/workspace/.makeademo/sandbox-log.jsonl")
        ) {
          options.onWorkspaceLogWriteStarted?.();
          await options.awaitWorkspaceLogWrite;
        }
        if (
          options.failWorkspaceLogWrite === true &&
          command.includes("/workspace/.makeademo/sandbox-log.jsonl")
        ) {
          return {
            exitCode: 1,
            result: "",
            stderr:
              "mkdir: cannot create directory '/workspace': Permission denied",
          };
        }
        if (
          options.missingSubmittedCodeImage === true &&
          command.includes("docker image inspect")
        ) {
          return {
            exitCode: 1,
            result: "",
            stderr:
              "Submitted-code image makeademo-submitted-code:node-browser is missing from the prepared Daytona workspace image.",
          };
        }
        if (
          options.failFirstSubmittedCodeInitialization === true &&
          command.includes("docker run -d") &&
          submittedCodeInitializationFailures === 0
        ) {
          submittedCodeInitializationFailures += 1;
          return { exitCode: 1, result: "", stderr: "docker failed" };
        }
        return { exitCode: 0, result: "ok" };
      },
      async executeSessionCommand(
        sessionId: string,
        request: {
          command: string;
          runAsync?: boolean;
          suppressInputEcho?: boolean;
        },
      ) {
        calls.push({ executeSessionCommand: { ...request, sessionId } });
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand(sessionId: string, commandId: string) {
        calls.push({ getSessionCommand: { commandId, sessionId } });
        return { exitCode: 7 };
      },
      async getSessionCommandLogs(
        sessionId: string,
        commandId: string,
        onStdout?: (chunk: string) => void,
        onStderr?: (chunk: string) => void,
      ) {
        calls.push({ getSessionCommandLogs: { commandId, sessionId } });
        if (onStdout !== undefined || onStderr !== undefined) {
          onStdout?.("hello");
          onStderr?.("warn");
          return;
        }

        return { stderr: "streamed stderr", stdout: "streamed stdout" };
      },
    },
  };

  return {
    async create(input: unknown) {
      calls.push({ create: input });
      return sandbox;
    },
    async delete(input: { id?: string; name?: string }) {
      calls.push({ delete: input.id ?? input.name });
    },
    async get(idOrName: string) {
      calls.push({ get: idOrName });
      return sandbox;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

async function waitForPtyPayloads(
  calls: unknown[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = calls.filter((call) => {
      if (typeof call !== "object" || call === null || !("sendInput" in call)) {
        return false;
      }
      const value = (call as { sendInput?: unknown }).sendInput;
      const input =
        typeof value === "string"
          ? value
          : typeof value === "object" && value !== null && "data" in value
            ? (value as { data?: unknown }).data
            : undefined;
      return (
        typeof input === "string" && input.includes("| base64 -d | /bin/sh")
      );
    }).length;
    if (count >= expectedCount) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${expectedCount} PTY command payloads to start.`);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
