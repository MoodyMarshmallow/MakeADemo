import { describe, expect, it } from "vitest";

import type {
  AgentTaskRunInput,
  AgentTaskRunResult,
  AgentTaskRunner,
} from "../../../agent-harness/agent-session-runner.interface";
import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createPipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createAgentSession } from "../../../test-support/create-agent-session";
import type { PreparationWorkspace } from "../../03-repo-preparation/preparation-workspace.interface";
import { AgenticCapturePathRepairer } from "./agentic-capture-path-repairer";

type CapturePathRepairAgentOptions = {
  hardTimeoutMs?: number;
  logger?: PipelineEventLogger;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  postRepairArtifactReadTimeoutMs?: number;
  timeoutMs?: number;
};

/** Recording provider-neutral runner for Capture Path repair stage tests. */
class RecordingAgentSessionRunner implements AgentTaskRunner {
  readonly calls: Array<
    Pick<AgentTaskRunInput, "session" | "stage" | "taskPrompt">
  > = [];

  async run<T>(input: AgentTaskRunInput<T>): Promise<AgentTaskRunResult<T>> {
    this.calls.push({
      stage: input.stage,
      taskPrompt: input.taskPrompt,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
    const result = await input.workspace.execute("recording-agent-turn", {
      env: {},
      timeoutMs: Math.max(1, input.hardDeadlineAt - Date.now()),
    });
    return {
      exitCode: result.exitCode,
      ...(result.exitCode === 0
        ? {}
        : {
            failure: {
              category: "execution" as const,
              message: [result.stderr, result.stdout]
                .filter((line) => line.length > 0)
                .join("\n"),
            },
          }),
      session: input.session ?? createAgentSession(),
    };
  }
}

class CapturePathRepairAgentFixture {
  private readonly repairer: AgenticCapturePathRepairer;
  readonly runner: RecordingAgentSessionRunner;

  constructor(options: CapturePathRepairAgentOptions) {
    const logger = options.logger ?? createPipelineEventLogger({ sinks: [] });
    const runner = new RecordingAgentSessionRunner();
    this.runner = runner;
    this.repairer = new AgenticCapturePathRepairer({
      hardTimeoutMs: options.hardTimeoutMs ?? 1_800_000,
      logger,
      onStatus: options.onStdout ?? (() => {}),
      postRepairArtifactReadTimeoutMs:
        options.postRepairArtifactReadTimeoutMs ?? 60_000,
      runner,
      timeoutMs: options.timeoutMs ?? 600_000,
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
      attempt: 1,
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
      agentSession: session,
      preparationManifest: preparationManifest(),
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
      repoUrl: "https://github.com/example/conduit",
      demoScript: interactivePackage(),
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
        capturePathRepairInput(events, options),
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
    const events: unknown[] = [];
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const agent = new CapturePathRepairAgentFixture({
      logger: testLogger(fallbackLogs),
    });

    const result = await agent.repairCapturePathFailure({
      attempt: 1,
      failure: {
        blockedNetworkAttempts: [],
        failedSceneId: "scene_feed",
        failureReason:
          "Scene scene_feed failed during Capture Path Validation.",
        logs: ["locator failed"],
        status: "failed",
        warnings: [],
      },
      agentSession: createAgentSession(),
      preparationManifest: preparationManifest(),
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        rejectSandboxLogEvents: ["capture-path-repair.agent-task.started"],
      }),
      repoUrl: "https://github.com/example/conduit",
      demoScript: interactivePackage(),
    });

    expect(result.demoScript.scriptId).toBe("script_conduit");
    expect(fallbackLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "script-generation-agent",
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
        preparationManifest: preparationManifest(),
        preparationWorkspace: workspaceHandle(events, [
          {
            ...interactivePackage(),
            demoPlaywrightScript: [
              "import { setup, scene } from './makeademo-capture-sdk';",
              "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });",
              "await scene('scene_feed', async ({ page, expect }) => {",
              "  await page.getByText('Global Feed').click();",
              "  expect(await page.getByText('demo').innerText()).toBe('demo');",
              "});",
            ].join("\n"),
          },
        ]),
        repoUrl: "https://github.com/example/conduit",
        demoScript: interactivePackage(),
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
        ...capturePathRepairInput(events),
        preparationWorkspace: workspaceHandle(events, [
          {
            ...interactivePackage(),
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
        ]),
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

function preparationManifest() {
  return {
    assumptions: ["auth accepts demo credentials"],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: ["local article API"],
    modifiedFiles: [],
    nativeVisibleInterface: {
      nativeStartupAttempts: ["npm run dev"],
      sourceControlledUiPaths: ["src/App.tsx"],
    },
    repoUrl: "https://github.com/example/conduit",
    risks: [],
    scriptGenerationContext: ["Use hash routes and demo@example.com."],
    setupSummary: "Prepared Conduit with local articles.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId: "workspace_123",
  };
}

function workspaceHandle(
  events: unknown[],
  artifacts: unknown[],
  helperOptions: {
    commandOutputScheduleByRun?: Array<
      Array<{
        afterMs: number;
        channel: "stderr" | "stdout";
        chunk: string;
      }>
    >;
    firstAgentFailure?: { stderr: string; stdout: string };
    neverSettleArtifactReads?: string[];
    neverSettleSandboxLogEvents?: string[];
    neverSettleUploadFiles?: boolean;
    neverSettleUploadFileAttempts?: number;
    abortableUploadFileAttempts?: number;
    transientSocketClosureUploadFiles?: number;
    rejectArtifactReads?: string[];
    rejectSandboxLogEvents?: string[];
    transientSocketClosureArtifactReads?: Record<string, number>;
  } = {},
) {
  let latestArtifact: unknown;
  let agentAttempt = 0;
  let activeUploads = 0;
  const commandOutputScheduleByRun = [
    ...(helperOptions.commandOutputScheduleByRun ?? []),
  ];
  const workspace: PreparationWorkspace = {
    async executeAgentCommand(command, commandOptions) {
      expect(command).toBe("recording-agent-turn");
      agentAttempt += 1;
      if (agentAttempt === 1 && helperOptions.firstAgentFailure) {
        return {
          exitCode: 1,
          stderr: helperOptions.firstAgentFailure.stderr,
          stdout: helperOptions.firstAgentFailure.stdout,
        };
      }
      latestArtifact = artifacts.shift();
      const schedule = commandOutputScheduleByRun.shift();
      if (schedule !== undefined) {
        for (const output of schedule) {
          await new Promise((resolve) => setTimeout(resolve, output.afterMs));
          if (output.channel === "stdout") {
            commandOptions?.onStdout?.(output.chunk);
          } else {
            commandOptions?.onStderr?.(output.chunk);
          }
        }
      } else {
        commandOptions?.onStdout?.("script generation output");
        commandOptions?.onStderr?.("script generation warning");
      }
      return { exitCode: 0, stderr: "", stdout: "generated" };
    },
    async execute(command) {
      if (command.includes("preparation-manifest.json")) {
        const transientSocketClosures =
          helperOptions.transientSocketClosureArtifactReads;
        const remainingSocketClosures =
          transientSocketClosures?.["preparation-manifest.json"];
        if (
          transientSocketClosures !== undefined &&
          remainingSocketClosures !== undefined &&
          remainingSocketClosures > 0
        ) {
          transientSocketClosures["preparation-manifest.json"] =
            remainingSocketClosures - 1;
          throw new Error("The socket connection was closed unexpectedly");
        }
        if (
          helperOptions.rejectArtifactReads?.includes(
            "preparation-manifest.json",
          )
        ) {
          throw new Error("Daytona command did not finish within 600000ms");
        }
        if (
          helperOptions.neverSettleArtifactReads?.includes(
            "preparation-manifest.json",
          )
        ) {
          await new Promise(() => {});
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(preparationManifest()),
        };
      }

      if (command.startsWith("if test -f")) {
        const artifactName = command.includes("demo-script.json")
          ? "demo-script.json"
          : undefined;
        const transientSocketClosures =
          helperOptions.transientSocketClosureArtifactReads;
        const remainingSocketClosures =
          artifactName === undefined
            ? undefined
            : transientSocketClosures?.[artifactName];
        if (
          artifactName !== undefined &&
          transientSocketClosures !== undefined &&
          remainingSocketClosures !== undefined &&
          remainingSocketClosures > 0
        ) {
          transientSocketClosures[artifactName] = remainingSocketClosures - 1;
          throw new Error("The socket connection was closed unexpectedly");
        }
        if (
          command.includes("demo-script.json") &&
          helperOptions.rejectArtifactReads?.includes("demo-script.json")
        ) {
          throw new Error("Daytona command did not finish within 600000ms");
        }
        if (
          command.includes("demo-script.json") &&
          helperOptions.neverSettleArtifactReads?.includes("demo-script.json")
        ) {
          await new Promise(() => {});
        }
        return latestArtifact === undefined
          ? { exitCode: 1, stderr: "", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(latestArtifact) };
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles(files, uploadOptions?: { signal?: AbortSignal }) {
      events.push({ uploadFiles: files });
      activeUploads += 1;
      const settleUpload = () => {
        activeUploads -= 1;
        events.push({ uploadSettled: true, activeUploads });
      };
      if ((helperOptions.abortableUploadFileAttempts ?? 0) > 0) {
        helperOptions.abortableUploadFileAttempts =
          (helperOptions.abortableUploadFileAttempts ?? 0) - 1;
        await new Promise<void>((resolve) => {
          const signal = uploadOptions?.signal;
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            events.push({ uploadAborted: true });
            settleUpload();
            resolve();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) onAbort();
        });
        return;
      }
      if (
        helperOptions.neverSettleUploadFiles ||
        (helperOptions.neverSettleUploadFileAttempts ?? 0) > 0
      ) {
        if ((helperOptions.neverSettleUploadFileAttempts ?? 0) > 0) {
          helperOptions.neverSettleUploadFileAttempts =
            (helperOptions.neverSettleUploadFileAttempts ?? 0) - 1;
        }
        await new Promise<void>((resolve) => {
          const signal = uploadOptions?.signal;
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            events.push({ uploadAborted: true });
            resolve();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) onAbort();
        });
      }
      settleUpload();
      if ((helperOptions.transientSocketClosureUploadFiles ?? 0) > 0) {
        helperOptions.transientSocketClosureUploadFiles =
          (helperOptions.transientSocketClosureUploadFiles ?? 0) - 1;
        throw new Error("The socket connection was closed unexpectedly");
      }
    },
    async cancelActiveCommands() {},
    async writeSandboxLog(entry) {
      if (
        typeof entry.event === "string" &&
        helperOptions.neverSettleSandboxLogEvents?.includes(entry.event)
      ) {
        await new Promise(() => {});
      }
      if (
        typeof entry.event === "string" &&
        helperOptions.rejectSandboxLogEvents?.includes(entry.event)
      ) {
        throw new Error("sandbox log mirror failed");
      }
      events.push({ sandboxLog: entry });
    },
  };

  return {
    async release() {},
    id: "daytona_workspace",
    workspace,
  };
}

function capturePathRepairInput(
  events: unknown[],
  helperOptions: Parameters<typeof workspaceHandle>[2] = {},
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
    preparationManifest: preparationManifest(),
    preparationWorkspace: workspaceHandle(
      events,
      [interactivePackage()],
      helperOptions,
    ),
    repoUrl: "https://github.com/example/conduit",
    demoScript: interactivePackage(),
  };
}

function testLogger(logs: Array<Record<string, unknown>>) {
  return createPipelineEventLogger({
    base: { component: "script-generation-agent" },
    sinks: [
      {
        write(line) {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ],
    timestamp: () => "2026-01-01T00:00:00.000Z",
  });
}

function interactivePackage() {
  return {
    demoPlaywrightScript:
      "import { setup, scene } from './makeademo-capture-sdk';\nawait setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });\nawait scene('scene_feed', async ({ page, expect }) => {\n  await page.getByText('Global Feed').click();\n  await page.getByText('demo').click();\n  await expect(page.getByText('demo')).toBeVisible();\n});",
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "clean" as const },
      textOverlays: [
        {
          content: "Filter the global feed",
          font: "Inter" as const,
          position: "bottom-left" as const,
          sceneId: "scene_feed",
          size: "medium" as const,
        },
      ],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Filtered demo articles are visible.",
        humanReadableDescription: "Filter the global feed by a popular tag.",
        id: "scene_feed",
      },
    ],
    scriptId: "script_conduit",
    title: "Conduit article feed demo",
    version: 1,
  };
}
