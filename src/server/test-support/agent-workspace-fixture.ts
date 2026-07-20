import type {
  AgentTaskRunInput,
  AgentTaskRunResult,
  AgentTaskRunner,
} from "../agent-harness/agent-session-runner.interface";
import type { PreparationManifest } from "../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../pipeline/03-repo-preparation/preparation-workspace.interface";
import type { DemoScript } from "../pipeline/04-script-generation/demo-script/demo-script.schema";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../shared/logging/pipeline-event-logger";
import { createAgentSession } from "./create-agent-session";

type ScheduledCommandOutput = {
  afterMs: number;
  channel: "stderr" | "stdout";
  chunk: string;
};

export type AgentWorkspaceFixtureFaults = {
  abortableUploadFileAttempts?: number;
  commandOutputScheduleByRun?: ScheduledCommandOutput[][];
  firstAgentFailure?: { stderr: string; stdout: string };
  neverSettleArtifactReads?: string[];
  neverSettleUploadFileAttempts?: number;
  neverSettleUploadFiles?: boolean;
  rejectArtifactReads?: string[];
  rejectSandboxLogEvents?: string[];
  transientSocketClosureArtifactReads?: Record<string, number>;
  transientSocketClosureUploadFiles?: number;
};

type AgentWorkspaceFixture = {
  preparationWorkspace: PreparationWorkspaceHandle;
};

/**
 * Records provider-neutral agent turns while advancing the fixture workspace's
 * queued artifacts. Tests may inspect calls without depending on a provider.
 */
export class RecordingAgentTaskRunner implements AgentTaskRunner {
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

/** Returns the standard Preparation Manifest used by agent-stage tests. */
export function canonicalPreparationManifest(): PreparationManifest {
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
    status: "created-new-demo",
    url: "http://localhost:3000",
    workspaceId: "workspace_123",
  };
}

/** Returns the standard valid Demo Script used by agent-stage tests. */
export function canonicalDemoScript(): DemoScript {
  return {
    demoPlaywrightScript:
      "import { setup, scene } from './makeademo-capture-sdk';\nawait setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });\nawait scene('scene_feed', async ({ page, expect }) => {\n  await page.getByText('Global Feed').click();\n  await page.getByText('demo').click();\n  await expect(page.getByText('demo')).toBeVisible();\n});",
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "clean" },
      textOverlays: [
        {
          content: "Filter the global feed",
          font: "Inter",
          position: "bottom-left",
          sceneId: "scene_feed",
          size: "medium",
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

/**
 * Creates a programmable Preparation Workspace whose artifact queue advances
 * once for each recorded agent turn. Faults model external-seam behavior,
 * including hangs, transient socket closures, and abortable uploads.
 */
export function createAgentWorkspaceFixture(input: {
  artifacts: unknown[];
  events?: unknown[];
  faults?: AgentWorkspaceFixtureFaults;
}): AgentWorkspaceFixture {
  const artifacts = [...input.artifacts];
  const events = input.events ?? [];
  const faults = input.faults ?? {};
  const commandOutputScheduleByRun = [
    ...(faults.commandOutputScheduleByRun ?? []),
  ];
  const neverSettleArtifactReads = new Set(faults.neverSettleArtifactReads);
  const rejectArtifactReads = new Set(faults.rejectArtifactReads);
  const rejectSandboxLogEvents = new Set(faults.rejectSandboxLogEvents);
  const transientSocketClosureArtifactReads = {
    ...faults.transientSocketClosureArtifactReads,
  };
  const preparationManifest = canonicalPreparationManifest();
  let latestArtifact: unknown;
  let agentAttempt = 0;
  let activeUploads = 0;
  let abortableUploadFileAttempts = faults.abortableUploadFileAttempts ?? 0;
  let neverSettleUploadFileAttempts = faults.neverSettleUploadFileAttempts ?? 0;
  let transientSocketClosureUploadFiles =
    faults.transientSocketClosureUploadFiles ?? 0;

  const readArtifact = async (artifactName: string) => {
    const remainingSocketClosures =
      transientSocketClosureArtifactReads[artifactName];
    if (remainingSocketClosures !== undefined && remainingSocketClosures > 0) {
      transientSocketClosureArtifactReads[artifactName] =
        remainingSocketClosures - 1;
      throw new Error("The socket connection was closed unexpectedly");
    }
    if (rejectArtifactReads.has(artifactName)) {
      throw new Error("Daytona command did not finish within 600000ms");
    }
    if (neverSettleArtifactReads.has(artifactName)) {
      await new Promise<never>(() => undefined);
    }
  };

  const workspace: PreparationWorkspace = {
    async cancelActiveCommands() {},
    async execute(command, options) {
      if (command.includes("preparation-manifest.json")) {
        await readArtifact("preparation-manifest.json");
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(preparationManifest),
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
        if (artifactName !== undefined) await readArtifact(artifactName);
        return latestArtifact === undefined
          ? { exitCode: 1, stderr: "", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(latestArtifact) };
      }
      options?.onStdout?.("");
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async executeAgentCommand(command, commandOptions) {
      if (command !== "recording-agent-turn") {
        throw new Error(`Unexpected agent fixture command: ${command}`);
      }
      agentAttempt += 1;
      if (agentAttempt === 1 && faults.firstAgentFailure !== undefined) {
        return {
          exitCode: 1,
          stderr: faults.firstAgentFailure.stderr,
          stdout: faults.firstAgentFailure.stdout,
        };
      }
      latestArtifact = artifacts.shift();
      const schedule = commandOutputScheduleByRun.shift();
      if (schedule === undefined) {
        commandOptions?.onStdout?.("agent task output");
        commandOptions?.onStderr?.("agent task warning");
      } else {
        for (const output of schedule) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, output.afterMs),
          );
          if (output.channel === "stdout") {
            commandOptions?.onStdout?.(output.chunk);
          } else {
            commandOptions?.onStderr?.(output.chunk);
          }
        }
      }
      return { exitCode: 0, stderr: "", stdout: "generated" };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles(files, options) {
      events.push({ uploadFiles: files });
      activeUploads += 1;
      const settleUpload = () => {
        activeUploads -= 1;
        events.push({ uploadSettled: true, activeUploads });
      };
      if (abortableUploadFileAttempts > 0) {
        abortableUploadFileAttempts -= 1;
        await waitForAbort(options?.signal, () => {
          events.push({ uploadAborted: true });
          settleUpload();
        });
        return;
      }
      if (faults.neverSettleUploadFiles || neverSettleUploadFileAttempts > 0) {
        if (neverSettleUploadFileAttempts > 0)
          neverSettleUploadFileAttempts -= 1;
        await waitForAbort(options?.signal, () => {
          events.push({ uploadAborted: true });
        });
      }
      settleUpload();
      if (transientSocketClosureUploadFiles > 0) {
        transientSocketClosureUploadFiles -= 1;
        throw new Error("The socket connection was closed unexpectedly");
      }
    },
    async writeSandboxLog(entry) {
      const event = typeof entry.event === "string" ? entry.event : undefined;
      if (event !== undefined && rejectSandboxLogEvents.has(event)) {
        throw new Error("sandbox log mirror failed");
      }
      events.push({ sandboxLog: entry });
    },
  };

  return {
    preparationWorkspace: {
      async release() {},
      id: "daytona_workspace",
      workspace,
    },
  };
}

/** Creates a JSON-capturing Pipeline logger with deterministic timestamps. */
export function createTestPipelineLogger(input: {
  component?: string;
  logs: Array<Record<string, unknown>>;
}): PipelineEventLogger {
  return createPipelineEventLogger({
    base: input.component === undefined ? {} : { component: input.component },
    sinks: [
      {
        write(line) {
          input.logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ],
    timestamp: () => "2026-01-01T00:00:00.000Z",
  });
}

/** A logger fake whose warning writes never settle. */
export function createNeverSettlingWarnLogger(): PipelineEventLogger {
  return {
    child: () => createNeverSettlingWarnLogger(),
    debug: async () => {},
    error: async () => {},
    flush: async () => {},
    info: async () => {},
    warn: () => new Promise<void>(() => undefined),
  };
}

function waitForAbort(signal: AbortSignal | undefined, onAbort: () => void) {
  return new Promise<void>((resolve) => {
    const abort = () => {
      signal?.removeEventListener("abort", abort);
      onAbort();
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}
