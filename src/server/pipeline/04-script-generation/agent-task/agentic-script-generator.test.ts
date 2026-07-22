import { describe, expect, it } from "vitest";

import type { BrowserToolController } from "../../../agent-harness/tools/browser/browser-tool-controller.interface";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../../shared/logging/pipeline-event-logger";
import {
  RecordingAgentTaskRunner,
  canonicalDemoScript,
  canonicalPreparationManifest,
  createAgentWorkspaceFixture,
  createNeverSettlingWarnLogger,
  createTestPipelineLogger,
} from "../../../test-support/agent-workspace-fixture";
import { createAgentSession } from "../../../test-support/create-agent-session";
import { AgenticScriptGenerator } from "./agentic-script-generator";

type ScriptGenerationAgentOptions = {
  browserToolControllerProvider?: {
    forWorkspace(input: {
      deadlineAt: number | undefined;
      localUrl: string;
      signal?: AbortSignal;
      workspace: unknown;
    }): BrowserToolController;
  };
  hardTimeoutMs?: number;
  logger?: PipelineEventLogger;
  maxAttempts?: number;
  timeoutMs?: number;
};

class ScriptGenerationAgentFixture {
  private readonly scriptGenerator: AgenticScriptGenerator;
  readonly runner: RecordingAgentTaskRunner;

  constructor(options: ScriptGenerationAgentOptions) {
    const logger = options.logger ?? createPipelineEventLogger({ sinks: [] });
    const runner = new RecordingAgentTaskRunner();
    this.runner = runner;
    this.scriptGenerator = new AgenticScriptGenerator({
      hardTimeoutMs: options.hardTimeoutMs ?? 1_800_000,
      logger,
      ...(options.maxAttempts === undefined
        ? {}
        : { maxAttempts: options.maxAttempts }),
      runner,
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.browserToolControllerProvider === undefined
        ? {}
        : {
            browserToolControllerProvider:
              options.browserToolControllerProvider,
          }),
    } as never);
  }

  generateDemoScript(
    ...input: Parameters<AgenticScriptGenerator["generateDemoScript"]>
  ) {
    return this.scriptGenerator.generateDemoScript(...input);
  }
}

describe("AgenticScriptGenerator", () => {
  it("authorizes refreshed browser tools only for the Script Generation agent turn", async () => {
    const controller = createRecordingBrowserToolController();
    const provider = {
      forWorkspace(input: {
        deadlineAt: number | undefined;
        localUrl: string;
        signal?: AbortSignal;
        workspace: unknown;
      }) {
        controller.updateContext(input);
        return controller;
      },
    };
    const agent = new ScriptGenerationAgentFixture({
      browserToolControllerProvider: provider,
    });
    const signal = new AbortController().signal;

    await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [canonicalDemoScript()],
      }).preparationWorkspace,
      signal,
    });

    expect(agent.runner.calls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "makeademo_browser_navigate",
      "makeademo_browser_inspect",
      "makeademo_browser_act",
      "makeademo_browser_screenshot",
      "makeademo_browser_reset",
    ]);
    expect(controller.contexts).toEqual([
      expect.objectContaining({ localUrl: "http://localhost:3000", signal }),
    ]);
    expect(controller.resets).toBe(1);
  });

  it("resumes the retained Agent Session and returns an interactive Demo Script", async () => {
    const session = createAgentSession();
    const controller = new AbortController();
    const deadlineAt = Date.now() + 30_000;
    const agent = new ScriptGenerationAgentFixture({});

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      deadlineAt,
      agentSession: session,
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [canonicalDemoScript()],
      }).preparationWorkspace,
      signal: controller.signal,
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(result.scenes[0]).toMatchObject({
      expectedVisibleOutcome: "Filtered demo articles are visible.",
      id: "scene_feed",
    });
    expect(result).not.toHaveProperty("demoPlan");
    expect(agent.runner.calls[0]).toMatchObject({
      session,
      signal: controller.signal,
      stage: "script-generation",
    });
    expect(agent.runner.calls[0]?.hardDeadlineAt).toBe(deadlineAt);
    expect(agent.runner.calls[0]?.taskPrompt.length).toBeLessThan(35_000);
  });

  it("retries a Demo Script candidate that uses Capture SDK context outside callbacks", async () => {
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 2,
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [outOfScopeContextDemoScript(), canonicalDemoScript()],
      }).preparationWorkspace,
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(agent.runner.calls).toHaveLength(2);
  });

  it("bounds Script Generation artifact reads by the public stage timeout", async () => {
    const agent = new ScriptGenerationAgentFixture({
      hardTimeoutMs: 100,
      maxAttempts: 1,
      timeoutMs: 5,
    });

    await expect(
      agent.generateDemoScript({
        ...scriptGenerationInput(),
        agentSession: createAgentSession(),
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [canonicalDemoScript()],
          faults: { neverSettleArtifactReads: ["demo-script.json"] },
        }).preparationWorkspace,
      }),
    ).rejects.toThrow(/Initial Script Generation artifact read .*timed out/);
  });

  it("retries transient Daytona socket closures while reading the initial Demo Script artifact", async () => {
    const events: unknown[] = [];
    const agent = new ScriptGenerationAgentFixture({});

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [canonicalDemoScript()],
        events,
        faults: {
          transientSocketClosureArtifactReads: { "demo-script.json": 2 },
        },
      }).preparationWorkspace,
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
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [staticPlaceholderDemoScript(), canonicalDemoScript()],
        events,
      }).preparationWorkspace,
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
    const agent = new ScriptGenerationAgentFixture({
      maxAttempts: 1,
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [canonicalDemoScript(), canonicalDemoScript()],
        faults: {
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
      }).preparationWorkspace,
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
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [missingSdkImportDemoScript(), canonicalDemoScript()],
        events,
      }).preparationWorkspace,
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
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [canonicalDemoScript()],
      }).preparationWorkspace,
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
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [canonicalDemoScript()],
        events,
        faults: {
          firstAgentFailure: {
            stderr:
              "very verbose stderr that should stay on the failed attempt",
            stdout:
              "very verbose stdout that should stay on the failed attempt",
          },
        },
      }).preparationWorkspace,
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
        preparationWorkspace: createAgentWorkspaceFixture({
          artifacts: [canonicalDemoScript()],
          events,
          faults: {
            firstAgentFailure: { stderr: "terminal stderr", stdout: "" },
          },
        }).preparationWorkspace,
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
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const agent = new ScriptGenerationAgentFixture({
      logger: createTestPipelineLogger({
        component: "script-generation-agent",
        logs: fallbackLogs,
      }),
    });

    const result = await agent.generateDemoScript({
      ...scriptGenerationInput(),
      agentSession: createAgentSession(),
      preparationWorkspace: createAgentWorkspaceFixture({
        artifacts: [canonicalDemoScript()],
        faults: {
          rejectSandboxLogEvents: ["script-generation.agent-task.started"],
        },
      }).preparationWorkspace,
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
    const agent = new ScriptGenerationAgentFixture({
      logger: createNeverSettlingWarnLogger(),
    });

    const result = await Promise.race([
      agent
        .generateDemoScript({
          ...scriptGenerationInput(),
          agentSession: createAgentSession(),
          preparationWorkspace: createAgentWorkspaceFixture({
            artifacts: [canonicalDemoScript()],
            faults: {
              rejectSandboxLogEvents: ["script-generation.agent-task.started"],
            },
          }).preparationWorkspace,
        })
        .then((script) => script.scriptId),
      delay(2_000).then(() => "timed-out"),
    ]);

    expect(result).toBe("script_conduit");
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scriptGenerationInput() {
  return {
    demoBrief: { keyProductFeatures: ["article feed"] },
    normalizedSupportingDocuments: [],
    preparationManifest: canonicalPreparationManifest(),
    repoUrl: "https://github.com/example/conduit",
  };
}

function createRecordingBrowserToolController(): BrowserToolController & {
  contexts: Array<{
    deadlineAt: number | undefined;
    localUrl: string;
    signal?: AbortSignal;
  }>;
  resets: number;
} {
  const contexts: Array<{
    deadlineAt: number | undefined;
    localUrl: string;
    signal?: AbortSignal;
  }> = [];
  let resets = 0;
  return {
    async act() {
      return { output: "" };
    },
    contexts,
    async inspect(input) {
      return { ...input, output: "" };
    },
    async navigate() {
      return { output: "", url: "http://localhost:3000" };
    },
    async reset() {
      resets += 1;
    },
    get resets() {
      return resets;
    },
    async screenshot() {
      return {
        path: "/workspace/.makeademo/browser-tools/latest.png",
        sizeBytes: 0,
      };
    },
    updateContext(input) {
      contexts.push(input);
    },
  };
}

function outOfScopeContextDemoScript() {
  return {
    ...canonicalDemoScript(),
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

function staticPlaceholderDemoScript() {
  return {
    ...canonicalDemoScript(),
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

function missingSdkImportDemoScript() {
  return {
    ...canonicalDemoScript(),
    demoPlaywrightScript: [
      "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });",
      "await scene('scene_feed', async ({ page, expect }) => {",
      "  await page.getByText('Global Feed').click();",
      "  await expect(page.getByText('demo')).toBeVisible();",
      "});",
    ].join("\n"),
  };
}
