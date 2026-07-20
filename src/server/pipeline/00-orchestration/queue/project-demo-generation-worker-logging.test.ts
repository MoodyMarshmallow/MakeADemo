import { afterEach, describe, expect, it, vi } from "vitest";

import { createProjectDemoGenerationWorkerLogger } from "./project-demo-generation-worker-logging";

describe("createProjectDemoGenerationWorkerLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits parseable Pino JSONL to stdout by default", async () => {
    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    const logger = createProjectDemoGenerationWorkerLogger({
      timestamp: () => "2026-07-04T00:00:00.000Z",
    });

    await logger.workerStarted();
    await logger.flush();

    expect(stdoutLines).toHaveLength(1);
    expect(JSON.parse(stdoutLines[0] ?? "{}")).toMatchObject({
      component: "project-demo-generation-worker",
      event: "worker-started",
      level: "info",
      message: "MakeADemo demo generation worker started.",
      service: "makeademo",
      time: "2026-07-04T00:00:00.000Z",
    });
  });

  it("emits worker status and pipeline progress through the Pino logging seam", async () => {
    const lines: string[] = [];
    const logger = createProjectDemoGenerationWorkerLogger({
      sinks: [
        {
          write(line) {
            lines.push(line);
          },
        },
      ],
      timestamp: () => "2026-07-04T00:00:00.000Z",
    });

    await logger.workerStarted();
    await logger.pipelineProgress({
      stage: "repo-preparation",
      status: "started",
    });
    await logger.jobProcessed({
      projectId: "project_123",
      status: "completed",
    });
    await logger.flush();

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        component: "project-demo-generation-worker",
        event: "worker-started",
        level: "info",
        message: "MakeADemo demo generation worker started.",
        service: "makeademo",
        time: "2026-07-04T00:00:00.000Z",
      },
      {
        component: "project-demo-generation-worker",
        event: "stage-progress",
        level: "info",
        message: "repo-preparation started.",
        service: "makeademo",
        stage: "repo-preparation",
        status: "started",
        time: "2026-07-04T00:00:00.000Z",
      },
      {
        component: "project-demo-generation-worker",
        event: "job-processed",
        level: "info",
        message: "Project project_123 demo generation completed.",
        projectId: "project_123",
        service: "makeademo",
        status: "completed",
        time: "2026-07-04T00:00:00.000Z",
      },
    ]);
  });

  it("logs failed worker jobs at error level", async () => {
    const lines: string[] = [];
    const logger = createProjectDemoGenerationWorkerLogger({
      sinks: [
        {
          write(line) {
            lines.push(line);
          },
        },
      ],
      timestamp: () => "2026-07-04T00:00:00.000Z",
    });

    await logger.jobProcessed({ projectId: "project_123", status: "failed" });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "job-processed",
      level: "error",
      message: "Project project_123 demo generation failed.",
      projectId: "project_123",
      status: "failed",
    });
  });

  it("maps worker pipeline progress statuses to operational Pino levels", async () => {
    const lines: string[] = [];
    const logger = createProjectDemoGenerationWorkerLogger({
      sinks: [{ write: (line) => void lines.push(line) }],
      timestamp: () => "2026-07-04T00:00:00.000Z",
    });

    await logger.pipelineProgress({
      stage: "repo-preparation",
      status: "started",
    });
    await logger.pipelineProgress({
      stage: "repo-preparation",
      status: "retrying",
    });
    await logger.pipelineProgress({
      stage: "repo-preparation",
      status: "failed",
    });
    await logger.pipelineProgress({
      stage: "repo-preparation",
      status: "succeeded",
    });

    expect(lines.map((line) => JSON.parse(line).level)).toEqual([
      "info",
      "warn",
      "error",
      "info",
    ]);
  });

  it("creates child pipeline loggers for worker integration seams", async () => {
    const lines: string[] = [];
    const logger = createProjectDemoGenerationWorkerLogger({
      sinks: [
        {
          write(line) {
            lines.push(line);
          },
        },
      ],
      timestamp: () => "2026-07-04T00:00:00.000Z",
    });

    await logger
      .child({ component: "repo-security-screen" })
      .info(
        { event: "repo-security-screen.clone.started" },
        "Daytona clone started.",
      );

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      component: "repo-security-screen",
      event: "repo-security-screen.clone.started",
      level: "info",
      message: "Daytona clone started.",
    });
  });
});
