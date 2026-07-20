import { describe, expect, it } from "vitest";

import { createJsonPipelineObserver } from "./pipeline-observer";

describe("createJsonPipelineObserver", () => {
  it("writes sanitized newline-delimited JSON observability events", async () => {
    const lines: string[] = [];
    const observer = createJsonPipelineObserver({
      now: () => "2026-06-14T00:00:00.000Z",
      service: "makeademo-worker",
      write: (line) => {
        lines.push(line);
      },
    });

    observer.record({
      demoRequestId: "demo-request-1",
      durationMs: 42,
      event: "stage.succeeded",
      projectId: "project-1",
      sceneCount: 3,
      stage: "compositing",
      status: "succeeded",
      workspaceId: "workspace-1",
    });
    await Promise.resolve();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      demoRequestId: "demo-request-1",
      durationMs: 42,
      event: "stage.succeeded",
      level: "info",
      projectId: "project-1",
      sceneCount: 3,
      service: "makeademo-worker",
      stage: "compositing",
      status: "succeeded",
      time: "2026-06-14T00:00:00.000Z",
      workspaceId: "workspace-1",
    });
  });

  it("maps Pipeline Job status to operational Pino severity", async () => {
    const lines: string[] = [];
    const observer = createJsonPipelineObserver({
      write: (line) => {
        lines.push(line);
      },
    });

    observer.record({ event: "stage.started", status: "started" });
    observer.record({ event: "stage.retrying", status: "retrying" });
    observer.record({ event: "stage.failed", status: "failed" });
    observer.record({ event: "stage.succeeded", status: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lines.map((line) => JSON.parse(line).level)).toEqual([
      "info",
      "warn",
      "error",
      "info",
    ]);
  });

  it("contains asynchronous Pino sink failures", async () => {
    let writes = 0;
    const observer = createJsonPipelineObserver({
      async write() {
        writes += 1;
        throw new Error("sink unavailable");
      },
    });

    observer.record({ event: "stage.succeeded", status: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writes).toBe(1);
  });
});
