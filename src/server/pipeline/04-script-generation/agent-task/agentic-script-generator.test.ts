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
import { AgenticScriptGenerator } from "./agentic-script-generator";

type ScriptGenerationAgentOptions = {
  hardTimeoutMs?: number;
  logger?: PipelineEventLogger;
  maxAttempts?: number;
  timeoutMs?: number;
};

/** Small provider-neutral runner fake used to keep stage tests independent of providers. */
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

class ScriptGenerationAgentFixture {
  private readonly scriptGenerator: AgenticScriptGenerator;
  readonly runner: RecordingAgentSessionRunner;

  constructor(options: ScriptGenerationAgentOptions) {
    const logger = options.logger ?? createPipelineEventLogger({ sinks: [] });
    const runner = new RecordingAgentSessionRunner();
    this.runner = runner;
    this.scriptGenerator = new AgenticScriptGenerator({
      hardTimeoutMs: options.hardTimeoutMs ?? 1_800_000,
      logger,
      ...(options.maxAttempts === undefined
        ? {}
        : { maxAttempts: options.maxAttempts }),
      runner,
      timeoutMs: options.timeoutMs ?? 600_000,
    });
  }

  generateDemoScript(
    ...input: Parameters<AgenticScriptGenerator["generateDemoScript"]>
  ) {
    return this.scriptGenerator.generateDemoScript(...input);
  }
}

describe("AgenticScriptGenerator", () => {
  it("resumes the retained Agent Session and returns an interactive Demo Script", async () => {
    const events: unknown[] = [];
    const session = createAgentSession();
    const agent = new ScriptGenerationAgentFixture({});

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: session,
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(result.scenes[0]).toMatchObject({
      expectedVisibleOutcome: "Filtered demo articles are visible.",
      id: "scene_feed",
    });
    expect(result).not.toHaveProperty("demoPlan");
    expect(agent.runner.calls[0]).toMatchObject({
      session,
      stage: "script-generation",
    });
    expect(agent.runner.calls[0]?.taskPrompt.length).toBeLessThan(35_000);
  });

  it("retries a Demo Script candidate that uses Capture SDK context outside callbacks", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 2,
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(events, [
        outOfScopeContextPackage(),
        interactivePackage(),
      ]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(agent.runner.calls).toHaveLength(2);
  });

  it("bounds Script Generation artifact reads by the public stage timeout", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      hardTimeoutMs: 100,
      maxAttempts: 1,
      timeoutMs: 5,
    });

    await expect(
      agent.generateDemoScript({
        ...scriptGenerationInput(),
        agentSession: createAgentSession(),
        preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
          neverSettleArtifactReads: ["demo-script.json"],
        }),
      }),
    ).rejects.toThrow(/Initial Script Generation artifact read .*timed out/);
  });

  it("retries transient Daytona socket closures while reading the initial Demo Script artifact", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({});

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        transientSocketClosureArtifactReads: { "demo-script.json": 2 },
      }),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            artifact: "demo-script.json",
            delayMs: 250,
            event: "script-generation.artifact-read.retrying",
            nextAttempt: 2,
            stage: "script-generation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            artifact: "demo-script.json",
            delayMs: 500,
            event: "script-generation.artifact-read.retrying",
            nextAttempt: 3,
            stage: "script-generation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            artifact: "demo-script.json",
            event: "script-generation.artifact-read.succeeded",
            stage: "script-generation",
          }),
        },
      ]),
    );
  });

  it("repairs static placeholder Demo Scripts in the same Agent Session", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 2,
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(events, [
        staticPlaceholderPackage(),
        interactivePackage(),
      ]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(agent.runner.calls).toHaveLength(2);
    expect(agent.runner.calls[1]?.session).toBe(agent.runner.calls[0]?.session);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.retrying",
            nextAttempt: 2,
            reason: "demoPlaywrightScript contains placeholder actions",
            stage: "script-generation",
          }),
        },
      ]),
    );
  });

  it("leaves prepared-runtime validation to Capture Path Validation", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 1,
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(
        events,
        [interactivePackage(), interactivePackage()],
        {
          commandOutputScheduleByRun: [
            [
              {
                afterMs: 1,
                channel: "stdout",
                chunk: `${JSON.stringify({
                  input: {
                    demoScriptPath: "/workspace/.makeademo/demo-script.json",
                  },
                  state: { status: "completed" },
                  tool: "makeademo_validate_demo_script",
                })}\n`,
              },
            ],
          ],
        },
      ),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(agent.runner.calls).toHaveLength(1);
  });

  it("repairs Demo Scripts that violate the Capture SDK contract before returning a candidate", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 2,
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(events, [
        missingSdkImportPackage(),
        interactivePackage(),
      ]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.demo-script.invalid",
            reason: expect.stringContaining("must import { setup, scene }"),
            stage: "script-generation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.retrying",
            nextAttempt: 2,
            reason: expect.stringContaining("must import { setup, scene }"),
            stage: "script-generation",
          }),
        },
      ]),
    );
  });

  it("bounds oversized Script Generation context before sending the task", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({});

    await agent.generateDemoScript({
      ...scriptGenerationInput(),
      normalizedSupportingDocuments: [
        {
          normalizedText: `docs:${"x".repeat(50_000)}`,
          sourceArtifactId: "artifact_long_doc",
          sourceFileName: "long-context.md",
        },
      ],
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    expect(agent.runner.calls[0]?.taskPrompt.length).toBeLessThan(35_000);
  });

  it("keeps Script Generation retry reasons concise after agent task failures", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 2,
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        firstAgentFailure: {
          stderr: "very verbose stderr that should stay on the failed attempt",
          stdout: "very verbose stdout that should stay on the failed attempt",
        },
      }),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.agent-task.failed",
            level: "warn",
            reason: expect.stringContaining("very verbose stderr"),
            stage: "script-generation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.retrying",
            nextAttempt: 2,
            reason: "Script Generation agent task exited with 1.",
            stage: "script-generation",
          }),
        },
      ]),
    );
  });

  it("marks the final Script Generation attempt failure as an error", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 1,
    });

    await expect(
      agent.generateDemoScript({
        ...scriptGenerationInput(),
        agentSession: createAgentSession(),
        preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
          firstAgentFailure: { stderr: "terminal stderr", stdout: "" },
        }),
      }),
    ).rejects.toThrow("Script Generation agent task exited with 1");

    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.agent-task.failed",
            level: "error",
          }),
        },
      ]),
    );
  });

  it("continues Script Generation when the attempt-start sandbox log mirror fails", async () => {
    const events: unknown[] = [];
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const agent = new ScriptGenerationAgentFixture({
      logger: testLogger(fallbackLogs),
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        rejectSandboxLogEvents: ["script-generation.agent-task.started"],
      }),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(fallbackLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "script-generation-agent",
          error: "sandbox log mirror failed",
          event: "sandbox-log-write-failed",
          failedEvent: "script-generation.agent-task.started",
          level: "warn",
          stage: "script-generation",
          workspaceComponent: "sandbox-log",
        }),
      ]),
    );
  });

  it("does not wait on a hanging fallback logger after Script Generation sandbox log writes fail", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({
      logger: neverSettlingWarnLogger(),
    });

    const result = await Promise.race([
      agent
        .generateDemoScript({
          ...scriptGenerationInput(),
          agentSession: createAgentSession(),
          preparationWorkspace: workspaceHandle(
            events,
            [interactivePackage()],
            {
              rejectSandboxLogEvents: ["script-generation.agent-task.started"],
            },
          ),
        })
        .then((script) => script.scriptId),
      delay(2_000).then(() => "timed-out"),
    ]);

    expect(result).toBe("script_conduit");
  });
});

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
          stdout: JSON.stringify(scriptGenerationInput().preparationManifest),
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

function neverSettlingWarnLogger(): PipelineEventLogger {
  return {
    child: () => neverSettlingWarnLogger(),
    debug: async () => {},
    error: async () => {},
    flush: async () => {},
    info: async () => {},
    warn: () => new Promise(() => undefined),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scriptGenerationInput() {
  return {
    demoBrief: { keyProductFeatures: ["article feed"] },
    normalizedSupportingDocuments: [],
    preparationManifest: {
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
    },
    repoUrl: "https://github.com/example/conduit",
  };
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

function outOfScopeContextPackage() {
  return {
    ...interactivePackage(),
    demoPlaywrightScript: [
      "import { setup, scene } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });",
      "await scene('scene_feed', async ({ page, expect }) => {",
      "  await page.getByText('Global Feed').click();",
      "  await expect(page.getByText('demo')).toBeVisible();",
      "});",
      "await expect(page.locator('body')).toBeVisible();",
    ].join("\n"),
  };
}

function staticPlaceholderPackage() {
  return {
    ...interactivePackage(),
    demoPlaywrightScript: [
      "import { setup, scene } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl); });",
      "await scene('scene_feed', async ({ page, expect }) => {",
      "  await expect(page.locator('body')).toBeVisible();",
      "  await page.waitForTimeout(2500);",
      "});",
    ].join("\n"),
  };
}

function missingSdkImportPackage() {
  return {
    ...interactivePackage(),
    demoPlaywrightScript: [
      "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });",
      "await scene('scene_feed', async ({ page, expect }) => {",
      "  await page.getByText('Global Feed').click();",
      "  await expect(page.getByText('demo')).toBeVisible();",
      "});",
    ].join("\n"),
  };
}
