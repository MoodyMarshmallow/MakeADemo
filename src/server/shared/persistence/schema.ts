import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  email: text("email").notNull().unique(),
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
});

export const projects = pgTable("projects", {
  commitSha: text("commit_sha"),
  context: jsonb("context").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  githubInstallationId: text("github_installation_id"),
  failureReason: text("failure_reason"),
  id: uuid("id").defaultRandom().primaryKey(),
  repoUrl: text("repo_url").notNull(),
  repoVisibility: text("repo_visibility").notNull(),
  status: text("status").notNull().default("queued"),
  supportingFiles: text("supporting_files")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
});

export const demoRequests = pgTable("demo_requests", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  finalVideoEmailSentAt: timestamp("final_video_email_sent_at", {
    withTimezone: true,
  }),
  generatedDemoUrl: text("generated_demo_url"),
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  script: jsonb("script"),
});
