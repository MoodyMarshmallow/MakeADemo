import { describe, expect, it } from "vitest";

import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createPipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import {
  type AgentWorkspaceFixtureFaults,
  RecordingAgentTaskRunner,
  canonicalDemoScript,
  canonicalPreparationManifest,
  createAgentWorkspaceFixture,
  createTestPipelineLogger,
} from "../../../test-support/agent-workspace-fixture";
import { createAgentSession } from "../../../test-support/create-agent-session";
import { AgenticCapturePathRepairer } from "./agentic-capture-path-repairer";

type CapturePathRepairAgentOptions = {
  logger?: PipelineEventLogger;
  postRepairArtifactReadTimeoutMs?: number;
};

class CapturePathRepairAgentFixture {
  private readonly repairer: AgenticCapturePathRepairer;
  readonly runner: RecordingAgentTaskRunner;

  constructor(options: CapturePathRepairAgentOptions) {
    const logger = options.logger ?? createPipelineEventLogger({ sinks: [] });
    const runner = new RecordingAgentTaskRunner();
    this.runner = runner;
    this.repairer = new AgenticCapturePathRepairer({
      hardTimeoutMs: 1_800_000,
      logger,
      onStatus: () => {},
      postRepairArtifactReadTimeoutMs:
        options.postRepairArtifactReadTimeoutMs ?? 60_000,
      runner,
      timeoutMs: 600_000,
    });
  }

  repairCapturePathFailure(
    ...input: Parameters<AgenticCapturePathRepairer["repairCapturePathFailure"]>
  ) {
    return this.repairer.repairCapturePathFailure(...input);
  }
}

describe("AgenticCapturePathRepairer", () => {
  it("sends Capture Path Validation failure evidence back to the same Agent Session for repair", async () => {
    const events: unknown[] = [];
    const session = createAgentSession();
    const agent = new CapturePathRepairAgentFixture({});

    const result = await agent.repairCapturePathFailure({
      ...capturePathRepairInput({}, events),
      agentSession: session,
      failure: {
        blockedNetworkAttempts: [],
        diagnosticsLogPath: "/workspace/.makeademo/sandbox-log.jsonl",
        failedSceneId: "scene_feed",
        failureReason:
          "Scene scene_feed failed during Capture Path Validation.",
        logs: ["locator failed: getByRole('button', { name: /react/i })"],
        scriptPath: ".makeademo-capture-path-validation-runs/run/scene_feed.ts",
        stderrPath:
          ".makeademo-capture-path-validation-runs/run/scene_feed.stderr.log",
        status: "failed",
        warnings: [],
      },
    });

    expect(result.demoScript.scriptId).toBe("script_conduit");
    expect(result.demoScript).not.toHaveProperty("demoPlan");
    expect(agent.runner.calls[0]).toMatchObject({
      session,
      stage: "capture-path-repair",
    });
    expect(agent.runner.calls[0]?.taskPrompt.length).toBeLessThan(35_000);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.agent-task.started",
            stage: "capture-path-repair",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            artifact: "demo-script.json",
            event: "capture-path-repair.artifact-read.started",
            stage: "capture-path-repair",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            artifact: "demo-script.json",
            durationMs: expect.any(Number),
            event: "capture-path-repair.artifact-read.succeeded",
            stage: "capture-path-repair",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.demo-script.succeeded",
            stage: "capture-path-repair",
          }),
        },
      ]),
    );
  });

  it.each([
    ["Demo Script timeout", "demo-script.json", "timeout"],
    ["Demo Script failure", "demo-script.json", "failure"],
    ["Preparation Manifest timeout", "preparation-manifest.json", "timeout"],
    ["Preparation Manifest failure", "preparation-manifest.json", "failure"],
    ["transient Demo Script socket closures", "demo-script.json", "transient"],
  ])(
    "handles post-repair %s while preserving artifact context",
    async (_label, artifact, mode) => {
      const events: unknown[] = [];
      const options =
        mode === "timeout"
          ? {
              neverSettleArtifactReads: [artifact],
              postRepairArtifactReadTimeoutMs: 5,
            }
          : mode === "failure"
            ? { rejectArtifactReads: [artifact] }
            : { transientSocketClosureArtifactReads: { [artifact]: 2 } };
      const agent = new CapturePathRepairAgentFixture({
        ...(mode === "timeout" ? { postRepairArtifactReadTimeoutMs: 5 } : {}),
      });
      const operation = agent.repairCapturePathFailure(
        capturePathRepairInput(options, events),
      );

      if (mode === "transient") {
        const result = await operation;
        expect(result.demoScript.scriptId).toBe("script_conduit");
        expect(
          events.filter(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "sandboxLog" in event &&
              (event as { sandboxLog?: { event?: unknown } }).sandboxLog
                ?.event === "capture-path-repair.artifact-read.retrying",
          ),
        ).toHaveLength(2);
        const started = events
          .filter(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "sandboxLog" in event,
          )
          .map(
            (event) =>
              (
                event as {
                  sandboxLog?: { artifact?: unknown; event?: unknown };
                }
              ).sandboxLog,
          )
          .filter(
            (log) => log?.event === "capture-path-repair.artifact-read.started",
          )
          .map((log) => log?.artifact);
        expect(started.indexOf("demo-script.json")).toBeLessThan(
          started.indexOf("preparation-manifest.json"),
        );
        return;
      }

      const expected = `Post-repair artifact read ${artifact} ${mode === "timeout" ? "timed out" : "failed: Daytona command did not finish within 600000ms"}`;
      await expect(operation).rejects.toThrow(expected);
      expect(events).toEqual(
        expect.arrayContaining([
          {
            sandboxLog: expect.objectContaining({
              artifact,
              event: `capture-path-repair.artifact-read.${mode === "timeout" ? "timeout" : "failed"}`,
              reason: expect.stringContaining(expected),
              stage: "capture-path-repair",
            }),
          },
        ]),
      );
    },
  );

  it("continues Capture Path repair when the attempt-start sandbox log mirror fails", async () => {
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const agent = new CapturePathRepairAgentFixture({
      logger: createTestPipelineLogger({
        component: "capture-path-repair-agent",
        logs: fallbackLogs,
      }),
    });

    const result = await agent.repairCapturePathFailure(
      capturePathRepairInput({
        rejectSandboxLogEvents: ["capture-path-repair.agent-task.started"],
      }),
    );

    expect(result.demoScript.scriptId).toBe("script_conduit");
    expect(fallbackLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "capture-path-repair-agent",
          error: "sandbox log mirror failed",
          event: "sandbox-log-write-failed",
          failedEvent: "capture-path-repair.agent-task.started",
          level: "warn",
          stage: "capture-path-repair",
          workspaceComponent: "sandbox-log",
        }),
      ]),
    );
  });

  it("rejects repaired Demo Scripts that still lack visible Playwright assertions", async () => {
    const events: unknown[] = [];
    const agent = new CapturePathRepairAgentFixture({});

    await expect(
      agent.repairCapturePathFailure({
        attempt: 1,
        failure: {
          blockedNetworkAttempts: [],
          failedSceneId: "scene_feed",
          failureReason:
            "Scene scene_feed must include a visible Playwright assertion before it ends.",
          logs: [
            "Scene scene_feed must include a visible Playwright assertion before it ends.",
          ],
          status: "failed",
          warnings: [],
        },
        agentSession: createAgentSession(),
        preparationManifest: canonicalPreparationManifest(),
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [
            {
              ...canonicalDemoScript(),
              demoPlaywrightScript: [
                "import { setup, scene } from './makeademo-capture-sdk';",
                "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });",
                "await scene('scene_feed', async ({ page, expect }) => {",
                "  await page.getByText('Global Feed').click();",
                "  expect(await page.getByText('demo').innerText()).toBe('demo');",
                "});",
              ].join("\n"),
            },
          ],
          events,
        }).preparationWorkspace,
        repoUrl: "https://github.com/example/conduit",
        demoScript: canonicalDemoScript(),
      }),
    ).rejects.toThrow(
      "Scene scene_feed must include a visible Playwright assertion before it ends.",
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.demo-script.invalid",
            reason:
              "Scene scene_feed must include a visible Playwright assertion before it ends.",
            stage: "capture-path-repair",
          }),
        },
      ]),
    );
  });

  it("rejects repaired Demo Scripts whose untyped app base URL fails strict Capture SDK TypeScript validation", async () => {
    const events: unknown[] = [];
    const agent = new CapturePathRepairAgentFixture({});

    await expect(
      agent.repairCapturePathFailure({
        ...capturePathRepairInput({}, events),
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [
            {
              ...canonicalDemoScript(),
              demoPlaywrightScript: [
                "import { setup, scene } from './makeademo-capture-sdk';",
                "let appBaseUrl;",
                "await setup(async ({ baseUrl }) => {",
                "  appBaseUrl = baseUrl;",
                "});",
                "await scene('scene_feed', async ({ page, expect }) => {",
                "  await page.goto(appBaseUrl + '#/');",
                "  await page.getByText('Global Feed').click();",
                "  await expect(page.getByText('demo')).toBeVisible();",
                "});",
              ].join("\n"),
            },
          ],
          events,
        }).preparationWorkspace,
      }),
    ).rejects.toThrow(/TS7034|TS7005/);

    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.demo-script.invalid",
            stage: "capture-path-repair",
            reason: expect.stringMatching(/TS7034|TS7005/),
          }),
        },
      ]),
    );
  });
});

function capturePathRepairInput(
  faults: AgentWorkspaceFixtureFaults = {},
  events?: unknown[],
) {
  return {
    attempt: 1,
    failure: {
      blockedNetworkAttempts: [],
      failedSceneId: "scene_feed",
      failureReason: "Scene scene_feed failed during Capture Path Validation.",
      logs: ["locator failed"],
      status: "failed" as const,
      warnings: [],
    },
    agentSession: createAgentSession(),
    preparationManifest: canonicalPreparationManifest(),
    preparationWorkspace: createAgentWorkspaceFixture({
      artifacts: [canonicalDemoScript()],
      faults,
      ...(events === undefined ? {} : { events }),
    }).preparationWorkspace,
    repoUrl: "https://github.com/example/conduit",
    demoScript: canonicalDemoScript(),
  };
}
