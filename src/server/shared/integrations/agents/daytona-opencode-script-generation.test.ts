import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";
import { createPipelineEventLogger } from "../../logging/pipeline-event-logger";
import {
  DaytonaOpenCodeScriptGeneration,
  type DraftCompositeReviewInput,
} from "./daytona-opencode-script-generation";

describe("DaytonaOpenCodeScriptGeneration", () => {
  it("resumes the Repo Preparation OpenCode session and returns an interactive Demo Script", async () => {
    const events: unknown[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      onStdout: (chunk) => stdout.push(chunk),
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(result.scenes[0]).toMatchObject({
      expectedVisibleOutcome: "Filtered demo articles are visible.",
      id: "scene_feed",
    });
    expect(result.demoPlan.featureOrder).toEqual(["article feed"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          timeoutMs: expect.any(Number),
        }),
      ]),
    );
    const openCodeTimeout = events.find(
      (event): event is { timeoutMs: number; execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "timeoutMs" in event &&
        typeof event.timeoutMs === "number" &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.timeoutMs;
    expect(openCodeTimeout).toBeGreaterThan(1_800_000);
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configDir: "/workspace/.makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
    const openCodeCommand = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(openCodeCommand).toContain("--session 'session_prepare_123'");
    expect(openCodeCommand).toContain("Do not use real-time network access");
    expect(openCodeCommand).toContain("fetch");
    expect(openCodeCommand).toContain("waitForResponse");
    expect(openCodeCommand).toContain("Only use the MakeADemo Capture SDK");
    expect(openCodeCommand).not.toContain("OPENAI_API_KEY");
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 1 starting in session session_prepare_123.",
    );
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 1 produced a Demo Script candidate.",
    );
  });

  it("retries a Demo Script candidate that uses Capture SDK context outside callbacks", async () => {
    const events: unknown[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      maxAttempts: 2,
      modelID: "gpt-5.5",
      onStdout: (chunk) => stdout.push(chunk),
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [
        outOfScopeContextPackage(),
        interactivePackage(),
      ]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(
      events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(2);
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 1 produced an invalid artifact",
    );
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 2 produced a Demo Script candidate.",
    );
  });

  it("times out inactive Script Generation without extending for step_start and cancels active commands", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      hardTimeoutMs: 1_000,
      maxAttempts: 1,
      modelID: "gpt-5.5",
      providerID: "openai",
      timeoutMs: 100,
    });

    const pending = agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        commandOutputScheduleByRun: [
          [
            {
              afterMs: 40,
              channel: "stdout",
              chunk: '{"type":"step_start"}\n',
            },
            {
              afterMs: 40,
              channel: "stdout",
              chunk: '{"type":"step_start"}\n',
            },
          ],
        ],
        openCodeWaitsForCancellation: true,
      }),
    });

    await expect(pending).rejects.toThrow(
      "Script Generation agent timed out after 100ms of inactivity.",
    );
    expect(events).toEqual(
      expect.arrayContaining([{ cancelActiveCommands: true }]),
    );
  });

  it("extends Script Generation inactivity for structured text and completed editor tools", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      hardTimeoutMs: 1_000,
      modelID: "gpt-5.5",
      providerID: "openai",
      timeoutMs: 100,
    });

    const pending = agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        commandOutputScheduleByRun: [
          [
            {
              afterMs: 80,
              channel: "stdout",
              chunk: '{"type":"text","part":{"text":"working"}}\n',
            },
            {
              afterMs: 80,
              channel: "stdout",
              chunk: '{"state":{"status":"completed"},"tool":"write"}\n',
            },
          ],
        ],
      }),
    });

    await expect(pending).resolves.toMatchObject({
      scriptId: "script_conduit",
    });
  });

  it("extends Script Generation inactivity for completed inspection tools", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      hardTimeoutMs: 1_000,
      modelID: "gpt-5.5",
      providerID: "openai",
      timeoutMs: 100,
    });

    const pending = agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        commandOutputScheduleByRun: [
          [
            {
              afterMs: 10,
              channel: "stdout",
              chunk: '{"type":"text","part":{"text":"working"}}\n',
            },
            {
              afterMs: 80,
              channel: "stdout",
              chunk:
                '{"part":{"state":{"status":"completed"},"tool":"read"},"type":"tool_use"}\n',
            },
            {
              afterMs: 80,
              channel: "stdout",
              chunk: '{"type":"step_start"}\n',
            },
          ],
        ],
      }),
    });

    await expect(pending).resolves.toMatchObject({
      scriptId: "script_conduit",
    });
  });

  it.each(["running", "failed"] as const)(
    "does not extend Script Generation inactivity for %s inspection tools",
    async (status) => {
      const events: unknown[] = [];
      const agent = new DaytonaOpenCodeScriptGeneration({
        hardTimeoutMs: 1_000,
        maxAttempts: 1,
        modelID: "gpt-5.5",
        providerID: "openai",
        timeoutMs: 100,
      });

      const pending = agent.generateScriptPackage({
        ...scriptGenerationInput(),
        opencodeSessionID: "session_prepare_123",
        preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
          commandOutputScheduleByRun: [
            [
              {
                afterMs: 10,
                channel: "stdout",
                chunk: '{"type":"text","part":{"text":"working"}}\n',
              },
              {
                afterMs: 80,
                channel: "stdout",
                chunk: `{"part":{"state":{"status":"${status}"},"tool":"read"},"type":"tool_use"}\n`,
              },
              {
                afterMs: 80,
                channel: "stdout",
                chunk: '{"type":"step_start"}\n',
              },
            ],
          ],
        }),
      });

      await expect(pending).rejects.toThrow(
        "Script Generation agent timed out after 100ms of inactivity.",
      );
    },
  );

  it("bounds Script Generation artifact reads by the public stage timeout", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      hardTimeoutMs: 100,
      maxAttempts: 1,
      modelID: "gpt-5.5",
      providerID: "openai",
      timeoutMs: 5,
    });

    await expect(
      agent.generateScriptPackage({
        ...scriptGenerationInput(),
        opencodeSessionID: "session_prepare_123",
        preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
          neverSettleArtifactReads: ["demo-script.json"],
        }),
      }),
    ).rejects.toThrow(/Initial Script Generation artifact read .*timed out/);
  });

  it("mirrors bounded Script Generation stderr into the sandbox Pino log seam", async () => {
    const events: unknown[] = [];
    const stderr: string[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      onStderr: (chunk) => stderr.push(chunk),
      onStdout: (chunk) => stdout.push(chunk),
      providerID: "openai",
    });

    await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    expect(stdout).toEqual(
      expect.arrayContaining([
        expect.stringContaining("script generation output"),
      ]),
    );
    expect(stderr).toEqual(["script generation warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            channel: "stderr",
            event: "opencode.stderr",
            message: "script generation warning",
            stage: "script-generation",
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        { execute: expect.stringContaining("opencode-activity.jsonl") },
      ]),
    );
  });

  it("continues Script Generation when streamed OpenCode activity log writes fail", async () => {
    const events: unknown[] = [];
    const stderr: string[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      onStderr: (chunk) => stderr.push(chunk),
      onStdout: (chunk) => stdout.push(chunk),
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        rejectSandboxLogEvents: ["opencode.stderr"],
      }),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(stdout).toEqual(
      expect.arrayContaining([
        expect.stringContaining("script generation output"),
      ]),
    );
    expect(stderr).toEqual(["script generation warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
  });

  it("continues Script Generation when streamed OpenCode activity log writes never settle", async () => {
    const events: unknown[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      onStdout: (chunk) => stdout.push(chunk),
      providerID: "openai",
    });

    const result = await Promise.race([
      agent.generateScriptPackage({
        ...scriptGenerationInput(),
        opencodeSessionID: "session_prepare_123",
        preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
          neverSettleSandboxLogEvents: ["opencode.stderr"],
        }),
      }),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 2_000),
      ),
    ]);

    expect(result).toMatchObject({ scriptId: "script_conduit" });
    expect(stdout).toEqual(
      expect.arrayContaining([
        expect.stringContaining("script generation output"),
      ]),
    );
  });

  it("retries transient Daytona socket closures while reading the initial Demo Script artifact", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
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

  it("repairs static placeholder Demo Scripts in the same OpenCode session", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      maxAttempts: 2,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [
        staticPlaceholderPackage(),
        interactivePackage(),
      ]),
    });

    expect(result.scriptId).toBe("script_conduit");
    const openCodeCommands = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      )
      .map((event) => event.execute);
    expect(openCodeCommands).toHaveLength(2);
    expect(openCodeCommands[1]).toContain("--session 'session_prepare_123'");
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
    const agent = new DaytonaOpenCodeScriptGeneration({
      maxAttempts: 1,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
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
    const openCodeCommands = events.filter(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    );
    expect(openCodeCommands).toHaveLength(1);
    expect(openCodeCommands[0]?.execute).toContain(
      "--session 'session_prepare_123'",
    );
  });

  it("repairs Demo Scripts that violate the Capture SDK contract before returning a candidate", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      maxAttempts: 2,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
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
            event: "script-generation.script-package.invalid",
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

  it("bounds oversized Script Generation context before sending the OpenCode prompt", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      normalizedSupportingDocuments: [
        {
          normalizedText: `docs:${"x".repeat(50_000)}`,
          sourceArtifactId: "artifact_long_doc",
          sourceFileName: "long-context.md",
        },
      ],
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    const openCodeCommand = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(openCodeCommand).toContain("long-context.md");
    expect(openCodeCommand).toContain("truncated");
    expect(openCodeCommand?.length).toBeLessThan(35_000);
  });

  it("keeps Script Generation retry reasons concise after OpenCode failures", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      maxAttempts: 2,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        firstOpenCodeFailure: {
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
            event: "script-generation.opencode-attempt.failed",
            reason: expect.stringContaining("very verbose stderr"),
            stage: "script-generation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.retrying",
            nextAttempt: 2,
            reason: "OpenCode Script Generation exited with 1.",
            stage: "script-generation",
          }),
        },
      ]),
    );
  });

  it("continues Script Generation when the attempt-start sandbox log mirror fails", async () => {
    const events: unknown[] = [];
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      logger: testLogger(fallbackLogs),
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        rejectSandboxLogEvents: ["script-generation.opencode-attempt.started"],
      }),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
    expect(fallbackLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "script-generation-agent",
          error: "sandbox log mirror failed",
          event: "sandbox-log-write-failed",
          failedEvent: "script-generation.opencode-attempt.started",
          level: "warn",
          stage: "script-generation",
          workspaceComponent: "sandbox-log",
        }),
      ]),
    );
  });

  it("does not wait on a hanging fallback logger after Script Generation sandbox log writes fail", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      logger: neverSettlingWarnLogger(),
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await Promise.race([
      agent
        .generateScriptPackage({
          ...scriptGenerationInput(),
          opencodeSessionID: "session_prepare_123",
          preparationWorkspace: workspaceHandle(
            events,
            [interactivePackage()],
            {
              rejectSandboxLogEvents: [
                "script-generation.opencode-attempt.started",
              ],
            },
          ),
        })
        .then((script) => script.scriptId),
      delay(2_000).then(() => "timed-out"),
    ]);

    expect(result).toBe("script_conduit");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
  });

  it("sends Capture Path Validation failure evidence back to the same OpenCode session for repair", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

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
      opencodeSessionID: "session_prepare_123",
      preparationManifest: scriptGenerationInput().preparationManifest,
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
      repoUrl: "https://github.com/example/conduit",
      demoScriptPackage: {
        ...interactivePackage(),
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Conduit article feed demo",
          risks: [],
        },
        exploration: {
          assumptions: [],
          productSurfaces: [],
          summary: "Prepared Conduit with local articles.",
        },
      },
    });

    expect(result.demoScriptPackage.scriptId).toBe("script_conduit");
    const openCodeCommand = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(openCodeCommand).toContain("--session 'session_prepare_123'");
    expect(openCodeCommand).toContain("Do not use real-time network access");
    expect(openCodeCommand).toContain("Only use the MakeADemo Capture SDK");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.opencode-attempt.started",
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
      const agent = new DaytonaOpenCodeScriptGeneration({
        modelID: "gpt-5.5",
        ...(mode === "timeout" ? { postRepairArtifactReadTimeoutMs: 5 } : {}),
        providerID: "openai",
      });
      const operation = agent.repairCapturePathFailure(
        capturePathRepairInput(events, options),
      );

      if (mode === "transient") {
        const result = await operation;
        expect(result.demoScriptPackage.scriptId).toBe("script_conduit");
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
    const agent = new DaytonaOpenCodeScriptGeneration({
      logger: testLogger(fallbackLogs),
      modelID: "gpt-5.5",
      providerID: "openai",
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
      opencodeSessionID: "session_prepare_123",
      preparationManifest: scriptGenerationInput().preparationManifest,
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        rejectSandboxLogEvents: [
          "capture-path-repair.opencode-attempt.started",
        ],
      }),
      repoUrl: "https://github.com/example/conduit",
      demoScriptPackage: {
        ...interactivePackage(),
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Conduit article feed demo",
          risks: [],
        },
        exploration: {
          assumptions: [],
          productSurfaces: [],
          summary: "Prepared Conduit with local articles.",
        },
      },
    });

    expect(result.demoScriptPackage.scriptId).toBe("script_conduit");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
    expect(fallbackLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "script-generation-agent",
          error: "sandbox log mirror failed",
          event: "sandbox-log-write-failed",
          failedEvent: "capture-path-repair.opencode-attempt.started",
          level: "warn",
          stage: "capture-path-repair",
          workspaceComponent: "sandbox-log",
        }),
      ]),
    );
  });

  it("rejects repaired Demo Scripts that still lack visible Playwright assertions", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

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
        opencodeSessionID: "session_prepare_123",
        preparationManifest: scriptGenerationInput().preparationManifest,
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
        demoScriptPackage: {
          ...interactivePackage(),
          assumptions: [],
          demoPlan: {
            featureOrder: ["article feed"],
            narrative: "Conduit article feed demo",
            risks: [],
          },
          exploration: {
            assumptions: [],
            productSurfaces: [],
            summary: "Prepared Conduit with local articles.",
          },
        },
      }),
    ).rejects.toThrow(
      "Scene scene_feed must include a visible Playwright assertion before it ends.",
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.script-package.invalid",
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
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

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
            event: "capture-path-repair.script-package.invalid",
            stage: "capture-path-repair",
            reason: expect.stringMatching(/TS7034|TS7005/),
          }),
        },
      ]),
    );
  });

  it("reviews Draft Composites in the same OpenCode session with uploaded evidence", async () => {
    const events: unknown[] = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const draftPath = join(reviewDirectory, "draft.mp4");
    const rawTakePath = join(reviewDirectory, "raw.webm");
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    const sampledFramePath = join(reviewDirectory, "sample-001.jpg");
    await writeFile(draftPath, "draft video");
    await writeFile(rawTakePath, "raw take");
    await writeFile(contactSheetPath, "contact sheet");
    await writeFile(sampledFramePath, "sampled frame");
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const decision = await agent.reviewDraftComposite({
      attempt: 1,
      captureManifest: {
        baseUrl: "https://preview.example.test/",
        createdAt: "2026-01-01T00:00:00.000Z",
        keepTemp: true,
        manifestPath: join(reviewDirectory, "capture-manifest.json"),
        qualityFindings: [],
        rawTakePath,
        runDirectory: reviewDirectory,
        runId: "capture-1",
        scenes: [
          {
            durationSeconds: 5,
            sceneId: "scene_feed",
            sectionId: "demo-script",
            videoPath: join(reviewDirectory, "scene-feed.webm"),
          },
        ],
        scriptId: "script_conduit",
        temporary: true,
        title: "Conduit article feed demo",
      },
      derivedEvidence: {
        contactSheetPaths: [contactSheetPath],
        draftDurationSeconds: 5,
        ffmpegFindings: ["ffprobe audio probe found no audio stream"],
        markerSummary: [{ durationSeconds: 5, sceneId: "scene_feed" }],
        qualityFindings: [],
        rawDraftCompositePath: draftPath,
        rawTakePath,
        sampledFramePaths: [sampledFramePath],
      },
      draftComposite: {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 150,
        fps: 30,
        manifestPath: join(reviewDirectory, "composite-manifest.json"),
        outputVideoPath: draftPath,
        renderPlanPath: join(reviewDirectory, "render-plan.json"),
        runDirectory: reviewDirectory,
        runId: "composite-1",
        scriptId: "script_conduit",
        title: "Conduit article feed demo",
        viewUrl: "file:///tmp/draft.mp4",
      },
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [
        {
          decision: "repair",
          reason: "Missing payoff.",
          repairScope: "demo-script",
        },
      ]),
      scriptPackage: {
        ...interactivePackage(),
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Conduit article feed demo",
          risks: [],
        },
        exploration: {
          assumptions: [],
          productSurfaces: [],
          summary: "Prepared Conduit with local articles.",
        },
      },
    });

    expect(decision).toEqual({
      decision: "repair",
      reason: "Missing payoff.",
      repairScope: "demo-script",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          uploadFiles: [
            {
              destinationPath:
                "/workspace/.makeademo/draft-review/contact-sheet.jpg",
              sourcePath: contactSheetPath,
            },
            {
              destinationPath:
                "/workspace/.makeademo/draft-review/sample-001.jpg",
              sourcePath: sampledFramePath,
            },
            {
              destinationPath: "/workspace/.makeademo/draft-review/draft.mp4",
              sourcePath: draftPath,
            },
          ],
        },
        expect.objectContaining({
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
    const uploadEventIndex = events.findIndex(
      (event) =>
        typeof event === "object" && event !== null && "uploadFiles" in event,
    );
    const openCodeEventIndex = events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    );
    expect(uploadEventIndex).toBeGreaterThanOrEqual(0);
    expect(openCodeEventIndex).toBeGreaterThan(uploadEventIndex);
    const uploadedFiles = (
      events[uploadEventIndex] as { uploadFiles: Array<{ sourcePath: string }> }
    ).uploadFiles;
    expect(uploadedFiles).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: rawTakePath }),
      ]),
    );
    expect(uploadedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: draftPath }),
      ]),
    );
    const openCodeCommand = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(openCodeCommand).toContain("--session 'session_prepare_123'");
    expect(openCodeCommand).toContain("--model 'openai/gpt-5.6-sol'");
    expect(openCodeCommand).not.toContain("--variant");
    expect(openCodeCommand).toContain("Draft Composite Review");
    expect(openCodeCommand).toContain("/workspace/.makeademo/draft-review");
    expect(openCodeCommand).toContain("ffmpeg/ffprobe");
    expect(openCodeCommand).toContain("markerSummary");
    expect(openCodeCommand).toContain("scene_feed");
    expect(openCodeCommand).toContain(
      "ffprobe audio probe found no audio stream",
    );
    expect(openCodeCommand).toContain(draftPath);
    expect(openCodeCommand).toContain(rawTakePath);
    expect(openCodeCommand).toContain(contactSheetPath);
    expect(openCodeCommand).toContain(sampledFramePath);
    expect(openCodeCommand).toContain("rawDraftCompositePath");
    expect(openCodeCommand).toContain("contactSheetPaths");
    expect(openCodeCommand).toContain("sampledFramePaths");
    expect(openCodeCommand).toContain("ffmpegFindings");
  });

  it("retries a transient Daytona socket closure while uploading Draft Composite evidence", async () => {
    const events: unknown[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    const agent = new DaytonaOpenCodeScriptGeneration({
      logger: testLogger(logs),
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [],
        }),
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          { transientSocketClosureUploadFiles: 1 },
        ),
      }),
    ).resolves.toEqual({ decision: "accept", reason: "Looks good." });

    expect(
      events.filter(
        (event) =>
          typeof event === "object" && event !== null && "uploadFiles" in event,
      ),
    ).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "draft-composite-review.evidence-upload.retrying",
          uploadAttempt: 1,
          nextAttempt: 2,
          delayMs: 250,
          reason: expect.stringContaining("Transient Daytona socket closure"),
          stage: "draft-composite-review",
        }),
      ]),
    );
  });

  it("times out hanging Draft Composite review evidence uploads before OpenCode", async () => {
    const events: unknown[] = [];
    const fallbackLogs: Array<Record<string, unknown>> = [];
    const logger = testLogger(fallbackLogs);
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    const sampledFramePath = join(reviewDirectory, "sample-001.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    await writeFile(sampledFramePath, "sampled frame");
    const agent = new DaytonaOpenCodeScriptGeneration({
      draftReviewEvidenceUploadTimeoutMs: 5,
      logger,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [sampledFramePath],
        }),
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          {
            neverSettleUploadFiles: true,
          },
        ),
      }),
    ).rejects.toThrow(
      "Draft Composite review evidence upload timed out after 5ms.",
    );

    await logger.flush();
    expect(fallbackLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bytes: 26,
          event: "draft-composite-review.evidence-upload.failed",
          fileCount: 2,
          reason: "Draft Composite review evidence upload timed out after 5ms.",
          stage: "draft-composite-review",
        }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
  });

  it("retries a timed-out Draft Composite evidence upload once", async () => {
    const events: unknown[] = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    const agent = new DaytonaOpenCodeScriptGeneration({
      draftReviewEvidenceUploadAttemptTimeoutMs: 5,
      draftReviewEvidenceUploadTimeoutMs: 300,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [],
        }),
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          { neverSettleUploadFileAttempts: 1 },
        ),
      }),
    ).resolves.toEqual({ decision: "accept", reason: "Looks good." });

    expect(
      events.filter(
        (event) =>
          typeof event === "object" && event !== null && "uploadFiles" in event,
      ),
    ).toHaveLength(2);
  });

  it("aborts and settles a timed-out evidence upload before retrying", async () => {
    const events: unknown[] = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    await writeFile(contactSheetPath, "contact sheet");
    const agent = new DaytonaOpenCodeScriptGeneration({
      draftReviewEvidenceUploadAttemptTimeoutMs: 5,
      draftReviewEvidenceUploadTimeoutMs: 300,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    await expect(
      agent.reviewDraftComposite({
        ...draftCompositeReviewInput(reviewDirectory, {
          contactSheetPaths: [contactSheetPath],
          sampledFramePaths: [],
        }),
        preparationWorkspace: workspaceHandle(
          events,
          [{ decision: "accept", reason: "Looks good." }],
          { abortableUploadFileAttempts: 1 },
        ),
      }),
    ).resolves.toEqual({ decision: "accept", reason: "Looks good." });

    expect(events).toEqual(
      expect.arrayContaining([
        { uploadAborted: true },
        { uploadSettled: true, activeUploads: 0 },
      ]),
    );
    const uploadEvents = events.filter(
      (event): event is { uploadFiles: unknown[] } =>
        typeof event === "object" && event !== null && "uploadFiles" in event,
    );
    expect(uploadEvents).toHaveLength(2);
    const firstRetryUploadIndex = events.findIndex(
      (event, index) =>
        index >
          events.findIndex(
            (candidate) =>
              typeof candidate === "object" &&
              candidate !== null &&
              "uploadFiles" in candidate,
          ) &&
        typeof event === "object" &&
        event !== null &&
        "uploadFiles" in event,
    );
    const uploadSettledIndex = events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "uploadSettled" in event &&
        (event as { activeUploads?: number }).activeUploads === 0,
    );
    expect(uploadSettledIndex).toBeGreaterThanOrEqual(0);
    expect(uploadSettledIndex).toBeLessThan(firstRetryUploadIndex);
  });
});

function draftCompositeReviewInput(
  reviewDirectory: string,
  evidence: {
    contactSheetPaths: string[];
    sampledFramePaths: string[];
  },
): Omit<DraftCompositeReviewInput, "preparationWorkspace"> {
  const draftPath = join(reviewDirectory, "draft.mp4");
  const rawTakePath = join(reviewDirectory, "raw.webm");

  return {
    attempt: 1,
    captureManifest: {
      baseUrl: "https://preview.example.test/",
      createdAt: "2026-01-01T00:00:00.000Z",
      keepTemp: true,
      manifestPath: join(reviewDirectory, "capture-manifest.json"),
      qualityFindings: [],
      rawTakePath,
      runDirectory: reviewDirectory,
      runId: "capture-1",
      scenes: [
        {
          durationSeconds: 5,
          sceneId: "scene_feed",
          sectionId: "demo-script",
          videoPath: join(reviewDirectory, "scene-feed.webm"),
        },
      ],
      scriptId: "script_conduit",
      temporary: true,
      title: "Conduit article feed demo",
    },
    derivedEvidence: {
      ...evidence,
      draftDurationSeconds: 5,
      ffmpegFindings: ["ffprobe audio probe found no audio stream"],
      markerSummary: [{ durationSeconds: 5, sceneId: "scene_feed" }],
      qualityFindings: [],
      rawDraftCompositePath: draftPath,
      rawTakePath,
    },
    draftComposite: {
      createdAt: "2026-01-01T00:00:00.000Z",
      durationInFrames: 150,
      fps: 30,
      manifestPath: join(reviewDirectory, "composite-manifest.json"),
      outputVideoPath: draftPath,
      renderPlanPath: join(reviewDirectory, "render-plan.json"),
      runDirectory: reviewDirectory,
      runId: "composite-1",
      scriptId: "script_conduit",
      title: "Conduit article feed demo",
      viewUrl: "file:///tmp/draft.mp4",
    },
    opencodeSessionID: "session_prepare_123",
    scriptPackage: {
      ...interactivePackage(),
      assumptions: [],
      demoPlan: {
        featureOrder: ["article feed"],
        narrative: "Conduit article feed demo",
        risks: [],
      },
      exploration: {
        assumptions: [],
        productSurfaces: [],
        summary: "Prepared Conduit with local articles.",
      },
    },
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
    firstOpenCodeFailure?: { stderr: string; stdout: string };
    openCodeWaitsForCancellation?: boolean;
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
  let openCodeAttempt = 0;
  let activeUploads = 0;
  const commandOutputScheduleByRun = [
    ...(helperOptions.commandOutputScheduleByRun ?? []),
  ];
  let releaseOpenCode: (() => void) | undefined;
  const workspace: PreparationWorkspace = {
    async execute(command, commandOptions) {
      events.push({
        execute: command,
        ...(commandOptions?.env?.OPENCODE_CONFIG_DIR === undefined
          ? {}
          : { configDir: commandOptions.env.OPENCODE_CONFIG_DIR }),
        ...(commandOptions?.onStdout === undefined ? {} : { streaming: true }),
        ...(commandOptions?.timeoutMs === undefined
          ? {}
          : { timeoutMs: commandOptions.timeoutMs }),
      });

      if (command.includes("opencode run")) {
        openCodeAttempt += 1;
        if (openCodeAttempt === 1 && helperOptions.firstOpenCodeFailure) {
          return {
            exitCode: 1,
            stderr: helperOptions.firstOpenCodeFailure.stderr,
            stdout: helperOptions.firstOpenCodeFailure.stdout,
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
        if (helperOptions.openCodeWaitsForCancellation) {
          await new Promise<void>((resolve) => {
            releaseOpenCode = resolve;
          });
        }
        return { exitCode: 0, stderr: "", stdout: "generated" };
      }

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

      if (command.includes("draft-composite-review.json")) {
        return latestArtifact === undefined
          ? { exitCode: 1, stderr: "missing review", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(latestArtifact) };
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
    async cancelActiveCommands() {
      events.push({ cancelActiveCommands: true });
      releaseOpenCode?.();
      releaseOpenCode = undefined;
    },
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
    opencodeSessionID: "session_prepare_123",
    preparationManifest: scriptGenerationInput().preparationManifest,
    preparationWorkspace: workspaceHandle(
      events,
      [interactivePackage()],
      helperOptions,
    ),
    repoUrl: "https://github.com/example/conduit",
    demoScriptPackage: {
      ...interactivePackage(),
      assumptions: [],
      demoPlan: {
        featureOrder: ["article feed"],
        narrative: "Conduit article feed demo",
        risks: [],
      },
      exploration: {
        assumptions: [],
        productSurfaces: [],
        summary: "Prepared Conduit with local articles.",
      },
    },
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
    audio: { enabled: true, music: { id: "clean" as const } },
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
