import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentToolDefinition,
  AgentToolResult,
} from "../../agent-harness/agent-session-runner.interface";
import type { PreparationWorkspace } from "../03-repo-preparation/preparation-workspace.interface";
import type {
  PreparedApplicationIdentityEvidence,
  PreparedApplicationIdentityEvidenceLedger,
} from "./prepared-application-identity-evidence";

const maxSourceCharacters = 16 * 1024;
const maxPathSearchResults = 40;
const maxScreenshotBytes = 10 * 1024 * 1024;
const screenshotDownloadTimeoutMs = 10_000;
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Successful, stage-owned evidence inspection recorded during one review turn. */
export type PreparedApplicationIdentityInspection =
  | {
      evidenceId: string;
      evidenceKind: PreparedApplicationIdentityEvidence["kind"];
      kind: "evidence";
    }
  | { endLine: number; kind: "source"; path: string; startLine: number };

/** Creates the identity review's complete read-only Stage Agent Tool surface. */
export function createPreparedApplicationIdentityStageTools(input: {
  evidenceLedger: PreparedApplicationIdentityEvidenceLedger;
  onInspection?: (inspection: PreparedApplicationIdentityInspection) => void;
  workspace: PreparationWorkspace;
}): readonly AgentToolDefinition<AgentToolResult>[] {
  return [
    {
      args: {
        endLine: {
          description: "Last pinned source line to read, inclusive.",
          optional: true,
          type: "string",
        },
        path: {
          description: "Source-controlled path at the pinned commit.",
          type: "string",
        },
        startLine: {
          description: "First pinned source line to read, inclusive.",
          optional: true,
          type: "string",
        },
      },
      description:
        "Read a bounded range from a source-controlled file at the backend-pinned commit.",
      async execute(args) {
        const path = readArgument(args.path, "path");
        if (!input.evidenceLedger.hasSourcePath(path)) {
          throw new Error("Pinned source path is outside the evidence ledger.");
        }
        if (input.workspace.executeReadOnlyCommand === undefined) {
          throw new Error("Pinned source inspection is unavailable.");
        }
        const result = await input.workspace.executeReadOnlyCommand(
          {
            argv: [
              "git",
              "show",
              `${input.evidenceLedger.applicationIdentityBaseline.sourceTreeObjectId}:${path}`,
            ],
          },
          { timeoutMs: 10_000 },
        );
        if (result.exitCode !== 0) {
          throw new Error("Pinned source inspection failed.");
        }
        const source = result.stdout.endsWith("\n")
          ? result.stdout.slice(0, -1)
          : result.stdout;
        const lines = result.stdout.length === 0 ? [] : source.split("\n");
        const startLine = readLine(args.startLine, "startLine", 1);
        const endLine = readLine(
          args.endLine,
          "endLine",
          Math.min(lines.length, startLine + 399),
        );
        if (endLine < startLine || endLine - startLine + 1 > 400) {
          throw new Error(
            "Pinned source inspection may read at most 400 lines.",
          );
        }
        if (startLine > lines.length || endLine > lines.length) {
          throw new Error("Pinned source inspection range exceeds the file.");
        }
        const content = lines.slice(startLine - 1, endLine).join("\n");
        if (Buffer.byteLength(content, "utf8") > maxSourceCharacters) {
          throw new Error(
            "Pinned source inspection range exceeds its content bound.",
          );
        }
        input.onInspection?.({
          endLine,
          kind: "source",
          path,
          startLine,
        });
        return content;
      },
      name: "inspect_pinned_source",
    },
    {
      args: {
        offset: {
          description: "Optional zero-based match offset for this page.",
          optional: true,
          type: "string",
        },
        query: {
          description:
            "Optional case-insensitive substring used to find pinned source paths.",
          optional: true,
          type: "string",
        },
      },
      description:
        "Search or page through the backend-pinned source path inventory without loading it all into context.",
      async execute(args) {
        const query = readOptionalQuery(args.query);
        const offset = readOffset(args.offset);
        const normalizedQuery = query.toLowerCase();
        const matches = input.evidenceLedger.sourceControlledPaths.filter(
          (path) => path.toLowerCase().includes(normalizedQuery),
        );
        if (offset > matches.length) {
          throw new Error("Pinned source path offset exceeds match count.");
        }
        const page = matches.slice(offset, offset + maxPathSearchResults);
        return JSON.stringify({
          matches: page,
          offset,
          omittedMatches: Math.max(0, matches.length - offset - page.length),
          totalMatches: matches.length,
        });
      },
      name: "search_pinned_source_paths",
    },
    {
      args: {
        offset: {
          description: "Optional zero-based UI identity match offset.",
          optional: true,
          type: "string",
        },
        query: {
          description:
            "Optional case-insensitive substring used to find indexed UI source paths.",
          optional: true,
          type: "string",
        },
        role: {
          description:
            "Optional deterministic UI identity evidence role to match.",
          optional: true,
          type: "enum",
          values: [
            "feature-root",
            "layout",
            "navigation-shell",
            "route",
            "source-path",
            "ui-root",
            "ui-source",
          ],
        },
      },
      description:
        "Search bounded backend-indexed pre-mutation UI identity evidence without loading the full index into context.",
      async execute(args) {
        const query = readOptionalQuery(args.query).toLowerCase();
        const role = readOptionalUiIdentityRole(args.role);
        const offset = readOffset(args.offset);
        const entries =
          input.evidenceLedger.applicationIdentityBaseline.uiIdentityIndex
            .entries;
        const matches = entries.filter(
          (entry) =>
            entry.path.toLowerCase().includes(query) &&
            (role === undefined || entry.roles.includes(role)),
        );
        if (offset > matches.length) {
          throw new Error("UI identity offset exceeds match count.");
        }
        const page = matches.slice(offset, offset + maxPathSearchResults);
        return JSON.stringify({
          matches: page,
          offset,
          omittedMatches: Math.max(0, matches.length - offset - page.length),
          totalMatches: matches.length,
        });
      },
      name: "search_pinned_ui_identity",
    },
    {
      args: {
        evidenceId: {
          description: "Backend-owned prepared evidence identifier.",
          type: "enum",
          values: input.evidenceLedger.evidence.map((item) => item.id),
        },
        offset: {
          description: "Optional zero-based character offset for this page.",
          optional: true,
          type: "string",
        },
      },
      description:
        "Read one bounded backend-owned prepared screenshot, accessibility, or change record.",
      async execute(args) {
        const evidenceId = readArgument(args.evidenceId, "evidenceId");
        const evidence = input.evidenceLedger.readEvidence(evidenceId);
        if (evidence === undefined) {
          throw new Error("Prepared evidence is outside the evidence ledger.");
        }
        if (evidence.kind === "prepared-screenshot") {
          const result = await readVerifiedScreenshot({
            evidence,
            workspace: input.workspace,
          });
          input.onInspection?.({
            evidenceId: evidence.id,
            evidenceKind: evidence.kind,
            kind: "evidence",
          });
          return result;
        }
        const offset = readOffset(args.offset);
        if (offset > evidence.content.length) {
          throw new Error(
            "Prepared evidence offset exceeds its content length.",
          );
        }
        const content = evidence.content.slice(
          offset,
          offset + maxSourceCharacters,
        );
        input.onInspection?.({
          evidenceId: evidence.id,
          evidenceKind: evidence.kind,
          kind: "evidence",
        });
        return JSON.stringify({
          content,
          id: evidence.id,
          kind: evidence.kind,
          offset,
          omittedCharacters: Math.max(
            0,
            evidence.content.length - offset - content.length,
          ),
        });
      },
      name: "read_prepared_identity_evidence",
    },
  ];
}

async function readVerifiedScreenshot(input: {
  evidence: PreparedApplicationIdentityEvidence;
  workspace: PreparationWorkspace;
}) {
  const metadata = readScreenshotMetadata(input.evidence.content);
  if (input.workspace.downloadFiles === undefined) {
    throw new Error("Prepared screenshot inspection is unavailable.");
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "makeademo-identity-review-"));
    const destinationPath = join(directory, "prepared-screenshot.png");
    await input.workspace.downloadFiles(
      [{ destinationPath, sourcePath: metadata.path }],
      {
        maxBytes: maxScreenshotBytes,
        timeoutMs: screenshotDownloadTimeoutMs,
      },
    );
    const [fileStat, bytes] = await Promise.all([
      stat(destinationPath),
      readFile(destinationPath),
    ]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      fileStat.size !== bytes.length ||
      bytes.length !== metadata.sizeBytes ||
      bytes.length < pngSignature.length ||
      bytes.length > maxScreenshotBytes ||
      !bytes.subarray(0, pngSignature.length).equals(pngSignature) ||
      sha256 !== metadata.sha256
    ) {
      throw new Error("Prepared screenshot proof failed verification.");
    }
    return [
      {
        text: JSON.stringify({
          id: input.evidence.id,
          kind: input.evidence.kind,
          sha256,
          sizeBytes: bytes.length,
        }),
        type: "text" as const,
      },
      {
        data: bytes.toString("base64"),
        mimeType: "image/png" as const,
        type: "image" as const,
      },
    ];
  } finally {
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true }).catch(() => {});
    }
  }
}

function readScreenshotMetadata(value: string): {
  path: string;
  sha256: string;
  sizeBytes: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Prepared screenshot metadata is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Prepared screenshot metadata is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.mimeType !== "image/png" ||
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    !Number.isSafeInteger(record.sizeBytes) ||
    (record.sizeBytes as number) < pngSignature.length ||
    (record.sizeBytes as number) > maxScreenshotBytes
  ) {
    throw new Error("Prepared screenshot metadata is invalid.");
  }
  return {
    path: record.path,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes as number,
  };
}

function readArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a nonempty string.`);
  }
  return value.trim();
}

function readLine(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  const normalized = readArgument(value, field);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${field} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function readOptionalQuery(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 500) {
    throw new Error("query must be a string of at most 500 characters.");
  }
  return value;
}

function readOptionalUiIdentityRole(value: unknown) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    ![
      "feature-root",
      "layout",
      "navigation-shell",
      "route",
      "source-path",
      "ui-root",
      "ui-source",
    ].includes(value)
  ) {
    throw new Error("role must be a known UI identity evidence role.");
  }
  return value as
    | "feature-root"
    | "layout"
    | "navigation-shell"
    | "route"
    | "source-path"
    | "ui-root"
    | "ui-source";
}

function readOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("offset must be a non-negative integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("offset must be a non-negative integer.");
  }
  return parsed;
}
