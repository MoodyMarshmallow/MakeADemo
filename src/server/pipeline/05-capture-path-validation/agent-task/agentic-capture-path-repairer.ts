import type { AgentTaskRunner } from "../../../agent-harness/agent-session-runner.interface";
import type { BrowserToolControllerProvider } from "../../../agent-harness/tools/browser/browser-tool-controller-registry";
import { createBrowserStageTools } from "../../../agent-harness/tools/browser/browser-tool-definitions";
import type { PipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { throwIfPipelineDeadlineReached } from "../../00-orchestration/job/pipeline-cancellation";
import { createRepoPreparationAgentWorkspace } from "../../03-repo-preparation/agent-task/repo-preparation-agent-workspace";
import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import {
  boundedArtifactTimeout,
  readDemoScriptArtifact,
  readErrorMessage,
} from "../../04-script-generation/agent-task/demo-script-artifacts";
import { validateDemoScriptCandidate } from "../../04-script-generation/demo-script-candidate-validator";
import type {
  CapturePathRepairInput,
  CapturePathRepairResult,
} from "../capture-path-repairer.interface";
import {
  createCapturePathRepairPrompt,
  readPostRepairArtifact,
  readPreparationManifestArtifact,
  writeRepairSandboxLog,
} from "./capture-path-repair-artifacts";

export type AgenticCapturePathRepairerOptions = {
  /** Supplies stable workspace-scoped browser tools for this repair turn. */
  browserToolControllerProvider?: BrowserToolControllerProvider;
  hardTimeoutMs: number;
  logger: PipelineEventLogger;
  onStatus: (message: string) => void;
  runner: AgentTaskRunner;
  postRepairArtifactReadTimeoutMs: number;
  timeoutMs: number;
};

/** Repairs Capture Path failures in the prepared workspace using the shared session. */
export class AgenticCapturePathRepairer {
  private readonly browserToolControllerProvider:
    | BrowserToolControllerProvider
    | undefined;
  private readonly options: AgenticCapturePathRepairerOptions;

  constructor(options: AgenticCapturePathRepairerOptions) {
    this.browserToolControllerProvider = options.browserToolControllerProvider;
    this.options = options;
  }

  async repairCapturePathFailure(
    input: CapturePathRepairInput,
  ): Promise<CapturePathRepairResult> {
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (input.agentSession === undefined) {
      throw new Error("Capture Path repair requires an agent session ID.");
    }
    const agentSession = input.agentSession;
    if (input.preparationWorkspace === undefined) {
      throw new Error("Capture Path repair requires the prepared workspace.");
    }
    const preparationWorkspace = input.preparationWorkspace;
    const hardDeadlineAt = Math.min(
      Date.now() + this.options.hardTimeoutMs,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    await writeRepairSandboxLog(this.options.logger, input, {
      attempt: input.attempt,
      event: "capture-path-repair.agent-task.started",
      failedSceneId: input.failure.failedSceneId,
      agentSession: input.agentSession,
    });
    this.options.onStatus(
      `Capture Path repair attempt ${input.attempt} starting in the retained agent session.`,
    );
    const browserController = this.browserToolControllerProvider?.forWorkspace({
      deadlineAt: hardDeadlineAt,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      localUrl: input.preparationManifest.url,
      workspace: preparationWorkspace.workspace,
    });
    const result = await (async () => {
      try {
        return await this.options.runner.run({
          attempt: input.attempt,
          taskPrompt: createCapturePathRepairPrompt(
            input,
            browserController !== undefined,
          ),
          session: agentSession,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          stage: "capture-path-repair",
          hardDeadlineAt,
          inactivityTimeoutMs: this.options.timeoutMs,
          hardTimeoutMs: this.options.hardTimeoutMs,
          ...(browserController === undefined
            ? {}
            : { tools: createBrowserStageTools(browserController) }),
          workspace: createRepoPreparationAgentWorkspace(
            preparationWorkspace.workspace,
          ),
        });
      } finally {
        await resetBrowserController(browserController);
      }
    })();
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (result.exitCode !== 0) {
      const reason = `Capture Path repair agent task exited with ${result.exitCode}: ${result.failure?.message ?? "agent task failed before artifact validation."}`;
      await writeRepairSandboxLog(this.options.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.agent-task.failed",
        exitCode: result.exitCode,
        reason,
      });
      throw new Error(reason);
    }
    const readTimeoutMs = boundedArtifactTimeout(
      Math.min(
        this.options.postRepairArtifactReadTimeoutMs,
        this.options.timeoutMs,
      ),
      hardDeadlineAt,
    );
    const scriptArtifact = await readPostRepairArtifact({
      artifactName: "demo-script.json",
      input,
      logger: this.options.logger,
      read: () =>
        readDemoScriptArtifact(
          { preparationWorkspace },
          { timeoutMs: readTimeoutMs },
        ),
      timeoutMs: readTimeoutMs,
    });
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (scriptArtifact.status !== "succeeded") {
      await writeRepairSandboxLog(this.options.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.artifact.missing",
        reason:
          scriptArtifact.status === "failed"
            ? scriptArtifact.reason
            : "demo-script.json was not produced",
      });
      throw new Error(
        scriptArtifact.status === "failed"
          ? scriptArtifact.reason
          : "demo-script.json was not produced",
      );
    }
    const manifestArtifact = await readPostRepairArtifact({
      artifactName: "preparation-manifest.json",
      input,
      logger: this.options.logger,
      read: () =>
        readPreparationManifestArtifact(
          { preparationWorkspace },
          { timeoutMs: readTimeoutMs },
        ),
      timeoutMs: readTimeoutMs,
    });
    throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
    if (manifestArtifact.status === "failed")
      throw new Error(manifestArtifact.reason);
    const preparationManifest =
      manifestArtifact.status === "succeeded"
        ? (manifestArtifact.value as PreparationManifest)
        : input.preparationManifest;
    let demoScript: Awaited<ReturnType<typeof validateDemoScriptCandidate>>;
    try {
      demoScript = await validateDemoScriptCandidate(scriptArtifact.value);
    } catch (error) {
      const reason = readErrorMessage(error);
      await writeRepairSandboxLog(this.options.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.demo-script.invalid",
        reason,
      });
      throw new Error(reason);
    }
    await writeRepairSandboxLog(this.options.logger, input, {
      attempt: input.attempt,
      event: "capture-path-repair.demo-script.succeeded",
      scriptId: demoScript.scriptId,
    });
    this.options.onStatus(
      `Capture Path repair attempt ${input.attempt} produced a Demo Script for revalidation.`,
    );
    return {
      preparationManifest,
      demoScript,
    };
  }
}

async function resetBrowserController(
  controller:
    | ReturnType<BrowserToolControllerProvider["forWorkspace"]>
    | undefined,
): Promise<void> {
  try {
    await controller?.reset();
  } catch {
    // Browser cleanup is best effort and must not replace the repair result.
  }
}
