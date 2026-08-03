import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type {
  ContextGatheringStore,
  ContextGatheringStoreInput,
  ContextGatheringSubmitResult,
} from "../../pipeline/01-context-gathering/context-gathering-submission";
import { demoRequests, projects, users } from "./schema";

type Database = PostgresJsDatabase<Record<string, never>>;

export class NeonContextGatheringStore implements ContextGatheringStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async createQueuedProject(
    input: ContextGatheringStoreInput,
  ): Promise<ContextGatheringSubmitResult> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.user.email,
          name: input.user.name,
        })
        .onConflictDoUpdate({
          set: { name: input.user.name },
          target: users.email,
        })
        .returning({ id: users.id });

      if (!user) {
        throw new Error("Failed to upsert user");
      }

      const [project] = await tx
        .insert(projects)
        .values({
          commitSha: input.project.commitSha,
          context: input.project.context,
          githubInstallationId: input.project.githubInstallationId ?? null,
          repoUrl: input.project.repoUrl,
          repoVisibility: input.project.repoVisibility,
          status: "queued",
          supportingFiles: input.project.supportingFiles,
          userId: user.id,
        })
        .returning({ id: projects.id });

      if (!project) {
        throw new Error("Failed to create project");
      }

      const [demoRequest] = await tx
        .insert(demoRequests)
        .values({
          generatedDemoUrl: null,
          projectId: project.id,
          script: null,
        })
        .returning({ id: demoRequests.id });

      if (!demoRequest) {
        throw new Error("Failed to create demo request");
      }

      return {
        demoRequestId: demoRequest.id,
        projectId: project.id,
        status: "queued",
      };
    });
  }
}

export function createNeonContextGatheringStore(
  databaseUrl = readRequiredEnv("DATABASE_URL"),
): NeonContextGatheringStore {
  const client = postgres(databaseUrl, { max: 5 });
  return new NeonContextGatheringStore(drizzle(client));
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
