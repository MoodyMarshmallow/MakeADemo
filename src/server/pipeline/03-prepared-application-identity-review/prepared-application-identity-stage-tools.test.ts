import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { canonicalizeReadOnlyCommand } from "../../shared/repository-inspection-command";
import {
  createApplicationIdentityBaseline,
  createPreparedWorkspaceDiff,
} from "../03-repo-preparation/application-identity-evidence";
import { createPreparedApplicationIdentityEvidenceLedger } from "./prepared-application-identity-evidence";
import { createPreparedApplicationIdentityStageTools } from "./prepared-application-identity-stage-tools";

const execFileAsync = promisify(execFile);

describe("Prepared Application Identity stage tools", () => {
  it("accepts the complete 8 MiB backend diff and exposes bounded pages", async () => {
    const patch = "x".repeat(8 * 1024 * 1024);
    const diff = createPreparedWorkspaceDiff({
      createdPaths: ["src/demo/page.tsx"],
      deletedPaths: [],
      modifiedPaths: [],
      patch,
    });
    const ledger = createPreparedApplicationIdentityEvidenceLedger({
      applicationIdentityBaseline: createApplicationIdentityBaseline({
        pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
        repoUrl: "https://github.com/example/app",
        sourceControlledPaths: ["src/app/page.tsx"],
        sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
      }),
      evidence: [],
      mockedBoundaries: [],
      preparedWorkspaceDiff: diff,
    });
    const tools = createPreparedApplicationIdentityStageTools({
      evidenceLedger: ledger,
      workspace: {
        async execute() {
          throw new Error("general execution must remain unavailable");
        },
        async uploadFiles() {},
      },
    });
    const readEvidence = tools.find(
      (tool) => tool.name === "read_prepared_identity_evidence",
    );
    if (readEvidence === undefined) throw new Error("expected evidence tool");

    const firstPage = JSON.parse(
      await readTextResult(
        readEvidence.execute({ evidenceId: diff.artifactId, offset: "0" }),
      ),
    ) as { content: string; omittedCharacters: number; offset: number };

    expect(firstPage).toMatchObject({
      offset: 0,
      omittedCharacters: patch.length - 16 * 1024,
    });
    expect(firstPage.content).toHaveLength(16 * 1024);

    const lastPage = JSON.parse(
      await readTextResult(
        readEvidence.execute({
          evidenceId: diff.artifactId,
          offset: String(patch.length - 16 * 1024),
        }),
      ),
    ) as { content: string; omittedCharacters: number; offset: number };
    expect(lastPage).toMatchObject({
      content: "x".repeat(16 * 1024),
      offset: patch.length - 16 * 1024,
      omittedCharacters: 0,
    });
  });

  it("reads pinned source from the ledger tree without consulting mutable HEAD", async () => {
    const executeReadOnlyCommand = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "first\nsecond\nthird",
    }));
    const tools = createPreparedApplicationIdentityStageTools({
      evidenceLedger: ledgerWithEvidence(),
      workspace: {
        async execute() {
          throw new Error("general execution must remain unavailable");
        },
        executeReadOnlyCommand,
        async uploadFiles() {},
      },
    });
    const inspectSource = tools.find(
      (tool) => tool.name === "inspect_pinned_source",
    );
    if (inspectSource === undefined) throw new Error("expected source tool");

    await expect(
      readTextResult(
        inspectSource.execute({
          endLine: "2",
          path: "src/app/page.tsx",
          startLine: "2",
        }),
      ),
    ).resolves.toBe("second");
    expect(executeReadOnlyCommand).toHaveBeenCalledOnce();
    expect(executeReadOnlyCommand).toHaveBeenCalledWith(
      {
        argv: [
          "git",
          "show",
          "abcdef0123456789abcdef0123456789abcdef01:src/app/page.tsx",
        ],
      },
      { timeoutMs: 10_000 },
    );
  });

  it("ignores preparation-installed Git replacements when reading pinned source", async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "makeademo-pinned-source-"),
    );
    try {
      await runGit(repository, "init", "--quiet");
      await runGit(repository, "config", "user.email", "test@example.com");
      await runGit(repository, "config", "user.name", "MakeADemo Test");
      await writeFile(
        join(repository, "App.tsx"),
        "export const identity = 'actual pinned app';\n",
      );
      await runGit(repository, "add", "App.tsx");
      await runGit(repository, "commit", "--quiet", "-m", "actual app");
      const pinnedRevision = await runGit(repository, "rev-parse", "HEAD");
      const pinnedTree = await runGit(
        repository,
        "rev-parse",
        `${pinnedRevision}^{tree}`,
      );

      await writeFile(
        join(repository, "App.tsx"),
        "export const identity = 'replacement app';\n",
      );
      await runGit(repository, "commit", "--quiet", "-am", "replacement app");
      const replacementRevision = await runGit(repository, "rev-parse", "HEAD");
      const replacementTree = await runGit(
        repository,
        "rev-parse",
        `${replacementRevision}^{tree}`,
      );
      await runGit(repository, "replace", pinnedRevision, replacementRevision);
      await runGit(repository, "replace", pinnedTree, replacementTree);

      const tools = createPreparedApplicationIdentityStageTools({
        evidenceLedger: createPreparedApplicationIdentityEvidenceLedger({
          applicationIdentityBaseline: createApplicationIdentityBaseline({
            pinnedRevision,
            repoUrl: "https://github.com/example/app",
            sourceControlledPaths: ["App.tsx"],
            sourceTreeObjectId: pinnedTree,
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
        workspace: {
          async execute() {
            throw new Error("general execution must remain unavailable");
          },
          async executeReadOnlyCommand(request) {
            const canonical = canonicalizeReadOnlyCommand(request);
            const [program, ...args] = canonical.argv;
            if (program === undefined) throw new Error("missing program");
            const result = await execFileAsync(program, args, {
              cwd: repository,
              encoding: "utf8",
            });
            return {
              exitCode: 0,
              stderr: result.stderr,
              stdout: result.stdout,
            };
          },
          async uploadFiles() {},
        },
      });
      const inspectSource = tools.find(
        (tool) => tool.name === "inspect_pinned_source",
      );
      if (inspectSource === undefined) throw new Error("expected source tool");

      await expect(
        readTextResult(
          inspectSource.execute({
            endLine: "1",
            path: "App.tsx",
            startLine: "1",
          }),
        ),
      ).resolves.toBe("export const identity = 'actual pinned app';");
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  it("searches the pinned path inventory through bounded pages", async () => {
    const ledger = createPreparedApplicationIdentityEvidenceLedger({
      applicationIdentityBaseline: createApplicationIdentityBaseline({
        pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
        repoUrl: "https://github.com/example/app",
        sourceControlledPaths: Array.from(
          { length: 300 },
          (_, index) =>
            `src/routes/route-${String(index).padStart(3, "0")}.tsx`,
        ),
        sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
      }),
      evidence: [],
      mockedBoundaries: [],
      preparedWorkspaceDiff: createPreparedWorkspaceDiff({
        createdPaths: [],
        deletedPaths: [],
        modifiedPaths: [],
        patch: "",
      }),
    });
    const tools = createPreparedApplicationIdentityStageTools({
      evidenceLedger: ledger,
      workspace: {
        async execute() {
          throw new Error("general execution must remain unavailable");
        },
        async uploadFiles() {},
      },
    });
    const search = tools.find(
      (tool) => tool.name === "search_pinned_source_paths",
    );
    if (search === undefined) throw new Error("expected path search tool");

    const page = JSON.parse(
      await readTextResult(search.execute({ offset: "40", query: "route-" })),
    ) as { matches: string[]; omittedMatches: number; offset: number };

    expect(page.offset).toBe(40);
    expect(page.matches).toHaveLength(40);
    expect(page.omittedMatches).toBe(220);
  });

  it("searches bounded pre-mutation UI identity evidence by deterministic role", async () => {
    const ledger = createPreparedApplicationIdentityEvidenceLedger({
      applicationIdentityBaseline: createApplicationIdentityBaseline({
        pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
        repoUrl: "https://github.com/example/app",
        sourceControlledPaths: [
          "apps/web/app/dashboard/page.tsx",
          "apps/web/app/layout.tsx",
          "src/components/navigation/sidebar.tsx",
        ],
        sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
      }),
      evidence: [],
      mockedBoundaries: [],
      preparedWorkspaceDiff: createPreparedWorkspaceDiff({
        createdPaths: [],
        deletedPaths: [],
        modifiedPaths: [],
        patch: "",
      }),
    });
    const tools = createPreparedApplicationIdentityStageTools({
      evidenceLedger: ledger,
      workspace: {
        async execute() {
          throw new Error("general execution must remain unavailable");
        },
        async uploadFiles() {},
      },
    });
    const search = tools.find(
      (tool) => tool.name === "search_pinned_ui_identity",
    );
    if (search === undefined) throw new Error("expected UI identity search");

    const page = JSON.parse(
      await readTextResult(search.execute({ offset: "0", role: "route" })),
    ) as {
      matches: Array<{ path: string; roles: string[] }>;
      omittedMatches: number;
    };

    expect(page).toEqual({
      matches: [
        {
          path: "apps/web/app/dashboard/page.tsx",
          roles: ["route", "ui-source"],
        },
      ],
      offset: 0,
      omittedMatches: 0,
      totalMatches: 1,
    });
  });

  it("downloads and verifies screenshot bytes before returning real image content", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("verified-pixels"),
    ]);
    const screenshotPath = "/workspace/.makeademo/identity-review.png";
    let backendTempPath: string | undefined;
    const downloadFiles = vi.fn(async (files) => {
      backendTempPath = files[0]?.destinationPath;
      if (backendTempPath === undefined) throw new Error("missing destination");
      await writeFile(backendTempPath, png);
    });
    const tools = createPreparedApplicationIdentityStageTools({
      evidenceLedger: ledgerWithEvidence({ png, screenshotPath }),
      workspace: {
        downloadFiles,
        async execute() {
          throw new Error("general execution must remain unavailable");
        },
        async uploadFiles() {},
      },
    });
    const readEvidence = tools.find(
      (tool) => tool.name === "read_prepared_identity_evidence",
    );
    if (readEvidence === undefined) throw new Error("expected evidence tool");

    await expect(
      readEvidence.execute({ evidenceId: screenshotEvidenceId(png) }),
    ).resolves.toEqual([
      {
        text: JSON.stringify({
          id: screenshotEvidenceId(png),
          kind: "prepared-screenshot",
          sha256: sha256(png),
          sizeBytes: png.length,
        }),
        type: "text",
      },
      { data: png.toString("base64"), mimeType: "image/png", type: "image" },
    ]);
    expect(downloadFiles).toHaveBeenCalledWith(
      [{ destinationPath: expect.any(String), sourcePath: screenshotPath }],
      { maxBytes: 10 * 1024 * 1024, timeoutMs: 10_000 },
    );
    expect(backendTempPath).not.toBe(screenshotPath);
    if (backendTempPath === undefined) throw new Error("missing temp path");
    await expect(access(backendTempPath)).rejects.toThrow();
  });

  it("rejects screenshot bytes that do not match the backend digest", async () => {
    const capturedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("captured-pixels"),
    ]);
    const substitutedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("attacker-pixels"),
    ]);
    let backendTempPath: string | undefined;
    const tools = createPreparedApplicationIdentityStageTools({
      evidenceLedger: ledgerWithEvidence({ png: capturedPng }),
      workspace: {
        async downloadFiles(files) {
          backendTempPath = files[0]?.destinationPath;
          if (backendTempPath === undefined) throw new Error("missing path");
          await writeFile(backendTempPath, substitutedPng);
        },
        async execute() {
          throw new Error("general execution must remain unavailable");
        },
        async uploadFiles() {},
      },
    });
    const readEvidence = tools.find(
      (tool) => tool.name === "read_prepared_identity_evidence",
    );
    if (readEvidence === undefined) throw new Error("expected evidence tool");

    await expect(
      readEvidence.execute({ evidenceId: screenshotEvidenceId(capturedPng) }),
    ).rejects.toThrow("failed verification");
    if (backendTempPath === undefined) throw new Error("missing temp path");
    await expect(access(backendTempPath)).rejects.toThrow();
  });
});

async function readTextResult(
  result: ReturnType<
    ReturnType<
      typeof createPreparedApplicationIdentityStageTools
    >[number]["execute"]
  >,
): Promise<string> {
  const value = await result;
  if (typeof value !== "string") throw new Error("expected text result");
  return value;
}

function ledgerWithEvidence(
  input: { png?: Buffer; screenshotPath?: string } = {},
) {
  const png =
    input.png ??
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("pixels"),
    ]);
  return createPreparedApplicationIdentityEvidenceLedger({
    applicationIdentityBaseline: createApplicationIdentityBaseline({
      pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://github.com/example/app",
      sourceControlledPaths: ["src/app/page.tsx"],
      sourceTreeObjectId: "abcdef0123456789abcdef0123456789abcdef01",
    }),
    evidence: [
      {
        content: JSON.stringify({
          mimeType: "image/png",
          path:
            input.screenshotPath ?? "/workspace/.makeademo/identity-review.png",
          sha256: sha256(png),
          sizeBytes: png.length,
        }),
        id: screenshotEvidenceId(png),
        kind: "prepared-screenshot",
      },
      {
        content: "- main: Native app",
        id: "accessibility-snapshot:sha256:example",
        kind: "accessibility-snapshot",
      },
    ],
    mockedBoundaries: [],
    preparedWorkspaceDiff: createPreparedWorkspaceDiff({
      createdPaths: [],
      deletedPaths: [],
      modifiedPaths: [],
      patch: "",
    }),
  });
}

function screenshotEvidenceId(png: Buffer): string {
  return `prepared-screenshot:sha256:${sha256(png)}`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runGit(repository: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
