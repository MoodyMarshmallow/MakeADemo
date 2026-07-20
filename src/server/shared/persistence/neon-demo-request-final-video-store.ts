import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type {
  DemoRequestScriptStore,
  SaveGeneratedScriptInput,
} from "../../pipeline/04-script-generation/demo-request-script-store.interface";
import type {
  DemoRequestFinalVideoStore,
  LinkFinalVideoInput,
  LinkedFinalVideoDemoRequest,
  MarkFinalVideoEmailSentInput,
} from "../../pipeline/07-compositing/final-video-storage.interface";
import type {
  DemoRequestStatus,
  DemoRequestStatusStore,
} from "../../pipeline/final-output/demo-request-status.interface";
import { demoRequests, projects, users } from "./schema";

type DemoRequestUpdateDatabase = {
  select(selection: unknown): unknown;
  update(table: unknown): unknown;
};

type UpdateReturningQuery = {
  set(values: Record<string, unknown>): {
    where(condition: unknown): {
      returning(selection: unknown): Promise<Array<Record<string, unknown>>>;
    };
  };
};

type SelectStatusQuery = {
  from(table: unknown): {
    innerJoin(
      table: unknown,
      condition: unknown,
    ): {
      where(condition: unknown): {
        limit(count: number): Promise<Array<Record<string, unknown>>>;
      };
    };
  };
};

type SelectMakerEmailQuery = {
  from(table: unknown): {
    innerJoin(
      table: unknown,
      condition: unknown,
    ): {
      innerJoin(
        table: unknown,
        condition: unknown,
      ): {
        where(condition: unknown): {
          limit(count: number): Promise<Array<Record<string, unknown>>>;
        };
      };
    };
  };
};

export class NeonDemoRequestFinalVideoStore
  implements
    DemoRequestFinalVideoStore,
    DemoRequestScriptStore,
    DemoRequestStatusStore
{
  private readonly db: DemoRequestUpdateDatabase;

  constructor(db: DemoRequestUpdateDatabase) {
    this.db = db;
  }

  async saveGeneratedScript(input: SaveGeneratedScriptInput): Promise<void> {
    const updateQuery = this.db.update(demoRequests) as UpdateReturningQuery;
    const [demoRequest] = await updateQuery
      .set({
        script: input.script,
      })
      .where(eq(demoRequests.id, input.demoRequestId))
      .returning({ id: demoRequests.id });

    if (!demoRequest) {
      throw new Error("Failed to save generated script to Demo Request");
    }
  }

  async linkFinalVideo(
    input: LinkFinalVideoInput,
  ): Promise<LinkedFinalVideoDemoRequest> {
    const updateQuery = this.db.update(demoRequests) as UpdateReturningQuery;
    const [demoRequest] = await updateQuery
      .set({
        generatedDemoUrl: input.generatedDemoUrl,
      })
      .where(eq(demoRequests.id, input.demoRequestId))
      .returning({
        finalVideoEmailSentAt: demoRequests.finalVideoEmailSentAt,
        id: demoRequests.id,
      });

    if (!demoRequest) {
      throw new Error("Failed to link final video to Demo Request");
    }

    const makerEmailQuery = this.db.select({
      email: users.email,
    }) as SelectMakerEmailQuery;
    const [maker] = await makerEmailQuery
      .from(demoRequests)
      .innerJoin(projects, eq(demoRequests.projectId, projects.id))
      .innerJoin(users, eq(projects.userId, users.id))
      .where(eq(demoRequests.id, input.demoRequestId))
      .limit(1);

    if (typeof maker?.email !== "string") {
      throw new Error("Failed to read Demo Request maker email");
    }

    return {
      finalVideoEmailSentAt: formatNullableDate(
        demoRequest.finalVideoEmailSentAt,
      ),
      makerEmail: maker.email,
    };
  }

  async markFinalVideoEmailSent(
    input: MarkFinalVideoEmailSentInput,
  ): Promise<void> {
    const updateQuery = this.db.update(demoRequests) as UpdateReturningQuery;
    const [demoRequest] = await updateQuery
      .set({
        finalVideoEmailSentAt: new Date(input.sentAt),
      })
      .where(eq(demoRequests.id, input.demoRequestId))
      .returning({ id: demoRequests.id });

    if (!demoRequest) {
      throw new Error("Failed to mark final video email as sent");
    }
  }

  async readDemoRequestStatus(
    demoRequestId: string,
  ): Promise<DemoRequestStatus | undefined> {
    const statusQuery = this.db.select({
      generatedDemoUrl: demoRequests.generatedDemoUrl,
      status: projects.status,
    }) as SelectStatusQuery;
    const [demoRequest] = await statusQuery
      .from(demoRequests)
      .innerJoin(projects, eq(demoRequests.projectId, projects.id))
      .where(eq(demoRequests.id, demoRequestId))
      .limit(1);

    if (!demoRequest) {
      return undefined;
    }

    const status = demoRequest.status;
    const generatedDemoUrl = demoRequest.generatedDemoUrl;
    if (
      status === "completed" &&
      typeof generatedDemoUrl === "string" &&
      generatedDemoUrl.length > 0
    ) {
      return {
        generatedDemoUrl,
        status: "completed",
      };
    }

    if (status === "failed") {
      return { status: "failed" };
    }

    return { status: "processing" };
  }
}

export function createNeonDemoRequestFinalVideoStore(
  databaseUrl = readRequiredEnv("DATABASE_URL"),
): NeonDemoRequestFinalVideoStore {
  const client = postgres(databaseUrl, { max: 5 });
  return new NeonDemoRequestFinalVideoStore(
    drizzle(client) as PostgresJsDatabase<Record<string, never>>,
  );
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function formatNullableDate(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return null;
}
