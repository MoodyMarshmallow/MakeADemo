import { and, asc, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ProjectDemoGenerationQueueStore } from "../../pipeline/00-orchestration/queue/project-demo-generation-queue";
import type { NormalizedSupportingDocument } from "../../pipeline/01-context-gathering/supporting-documents";
import { demoRequests, projects } from "./schema";

export type QueuedSupportingDocumentUpload = {
  fileName: string;
  mimeType: string;
  r2Key: string;
  r2Url: string;
  sizeBytes: number;
};

type SupportingDocumentLoader = {
  loadSupportingDocuments(
    input: QueuedSupportingDocumentUpload[],
  ): Promise<NormalizedSupportingDocument[]>;
};

type ProjectQueueDatabase = {
  select(selection: unknown): unknown;
  update(table: unknown): unknown;
};

type SelectQueuedProjectQuery = {
  from(table: unknown): {
    innerJoin(
      table: unknown,
      condition: unknown,
    ): {
      where(condition: unknown): {
        orderBy(ordering: unknown): {
          limit(count: number): Promise<Array<Record<string, unknown>>>;
        };
      };
    };
  };
};

type UpdateReturningQuery = {
  set(values: Record<string, unknown>): {
    where(condition: unknown): {
      returning(selection: unknown): Promise<Array<Record<string, unknown>>>;
    };
  };
};

export class NeonProjectDemoGenerationQueueStore
  implements ProjectDemoGenerationQueueStore
{
  private readonly db: ProjectQueueDatabase;
  private readonly supportingDocumentLoader:
    | SupportingDocumentLoader
    | undefined;

  constructor(
    db: ProjectQueueDatabase,
    supportingDocumentLoader?: SupportingDocumentLoader,
  ) {
    this.db = db;
    this.supportingDocumentLoader = supportingDocumentLoader;
  }

  async claimNextQueuedProject() {
    const query = this.db.select({
      commitSha: projects.commitSha,
      context: projects.context,
      demoRequestId: demoRequests.id,
      repoVisibility: projects.repoVisibility,
      githubInstallationId: projects.githubInstallationId,
      projectId: projects.id,
      repoUrl: projects.repoUrl,
      supportingFiles: projects.supportingFiles,
    }) as SelectQueuedProjectQuery;
    const [row] = await query
      .from(projects)
      .innerJoin(demoRequests, eq(demoRequests.projectId, projects.id))
      .where(eq(projects.status, "queued"))
      .orderBy(asc(projects.createdAt))
      .limit(1);

    if (!row) {
      return undefined;
    }

    const projectId = readString(row, "projectId");
    const updateQuery = this.db.update(projects) as UpdateReturningQuery;
    const [claimed] = await updateQuery
      .set({ status: "processing" })
      .where(and(eq(projects.id, projectId), eq(projects.status, "queued")))
      .returning({ id: projects.id });

    if (!claimed) {
      return undefined;
    }

    try {
      return {
        commitSha: readCommitSha(row.commitSha),
        demoBrief: readDemoBriefFromProjectContext(row.context),
        demoRequestId: readString(row, "demoRequestId"),
        ...(typeof row.githubInstallationId === "string" &&
        row.githubInstallationId.length > 0
          ? { githubInstallationId: row.githubInstallationId }
          : {}),
        normalizedSupportingDocuments: await this.loadSupportingDocuments(row),
        projectId,
        repoUrl: readString(row, "repoUrl"),
        repoVisibility: readRepoVisibility(row.repoVisibility),
        workspaceId: projectId,
      };
    } catch (error) {
      const failureReason =
        error instanceof Error
          ? error.message
          : "Queued Project could not be loaded.";
      await this.markProjectFailed({
        error: failureReason,
        projectId,
      });
      return {
        claimStatus: "failed" as const,
        demoRequestId: readString(row, "demoRequestId"),
        error: failureReason,
        projectId,
        workspaceId: projectId,
      };
    }
  }

  async markProjectCompleted(input: {
    generatedDemoUrl: string;
    projectId: string;
  }): Promise<void> {
    void input.generatedDemoUrl;
    await this.updateProjectStatus(input.projectId, "completed");
  }

  async markProjectFailed(input: {
    error: string;
    projectId: string;
  }): Promise<void> {
    await this.updateProjectStatus(input.projectId, "failed", input.error);
  }

  private async updateProjectStatus(
    projectId: string,
    status: "completed" | "failed",
    failureReason?: string,
  ) {
    const updateQuery = this.db.update(projects) as UpdateReturningQuery;
    const [project] = await updateQuery
      .set({
        failureReason: status === "failed" ? failureReason : null,
        status,
      })
      .where(eq(projects.id, projectId))
      .returning({ id: projects.id });

    if (!project) {
      throw new Error(`Failed to mark Project ${status}`);
    }
  }

  private async loadSupportingDocuments(
    row: Record<string, unknown>,
  ): Promise<NormalizedSupportingDocument[]> {
    const uploads = readQueuedSupportingDocumentUploads(row.supportingFiles);
    if (uploads.length === 0 || this.supportingDocumentLoader === undefined) {
      return [];
    }

    return this.supportingDocumentLoader.loadSupportingDocuments(uploads);
  }
}

function readCommitSha(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(
      "Queued Project has no valid pinned source revision; legacy Projects must be resubmitted.",
    );
  }
  return value.toLowerCase();
}

function readRepoVisibility(value: unknown): "private" | "public" {
  if (value !== "private" && value !== "public") {
    throw new Error("Queued Project has invalid repository visibility.");
  }
  return value;
}

export function createNeonProjectDemoGenerationQueueStore(
  databaseUrl = readRequiredEnv("DATABASE_URL"),
): NeonProjectDemoGenerationQueueStore {
  const client = postgres(databaseUrl, { max: 5 });
  return new NeonProjectDemoGenerationQueueStore(
    drizzle(client) as PostgresJsDatabase<Record<string, never>>,
  );
}

function readDemoBriefFromProjectContext(value: unknown) {
  const context = readRecord(value, "Project context");
  const structuredContext = readRecord(
    context.structuredContext,
    "Project context.structuredContext",
  );
  const targetUsers = readOptionalString(structuredContext, "targetUsers");

  return {
    ...(targetUsers ? { audience: targetUsers } : {}),
    keyProductFeatures: splitFeatures(
      readString(structuredContext, "importantFeatures"),
    ),
  };
}

function splitFeatures(value: string) {
  const features = value
    .split(/[\n,]/g)
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);

  return features.length > 0 ? features : [value.trim()];
}

function readQueuedSupportingDocumentUploads(
  value: unknown,
): QueuedSupportingDocumentUpload[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry, index) => {
    const record = readRecord(
      typeof entry === "string" ? JSON.parse(entry) : entry,
      `supportingFiles[${index}]`,
    );

    return {
      fileName: readString(record, "fileName"),
      mimeType: readString(record, "mimeType"),
      r2Key: readString(record, "r2Key"),
      r2Url: readString(record, "r2Url"),
      sizeBytes: readNumber(record, "sizeBytes"),
    };
  });
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }

  return value;
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string when provided`);
  }

  return value;
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
