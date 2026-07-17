import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { writeDaytonaOpenCodeActivityLog } from "./daytona-opencode-activity-log";
import {
  createMeaningfulActivityTracker,
  runWithMeaningfulActivityTimeout,
} from "./opencode-meaningful-activity-timeout";
import { draftCompositeReviewOpenCodeModel } from "./opencode-model-defaults";

type DaytonaOpenCodeStage =
  | "capture-path-repair"
  | "draft-composite-review"
  | "script-generation";

export type DaytonaOpenCodeSessionOptions = {
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerID: string;
};

export type DaytonaOpenCodeSessionRunInput = {
  attempt: number;
  prompt: string;
  sessionID: string;
  stage: DaytonaOpenCodeStage;
  workspace: PreparationWorkspace;
  hardDeadlineAt: number;
  inactivityTimeoutMs: number;
  hardTimeoutMs: number;
};

/** Shared OpenCode execution seam preserving model selection, activity limits, and session continuity. */
export class DaytonaOpenCodeSession {
  private readonly options: DaytonaOpenCodeSessionOptions;

  constructor(options: DaytonaOpenCodeSessionOptions) {
    this.options = options;
  }

  async run(input: DaytonaOpenCodeSessionRunInput) {
    const model =
      input.stage === "draft-composite-review"
        ? draftCompositeReviewOpenCodeModel
        : {
            modelID: this.options.modelID,
            providerID: this.options.providerID,
          };
    const activity = createMeaningfulActivityTracker({
      countCompletedInspectionTools: input.stage === "script-generation",
    });
    return runWithMeaningfulActivityTimeout(
      () =>
        input.workspace.execute(
          createOpenCodeRunCommand({
            model: `${model.providerID}/${model.modelID}`,
            prompt: input.prompt,
            sessionID: input.sessionID,
          }),
          removeUndefinedOptions({
            env: createOpenCodeEnv(),
            onStderr: (chunk) => {
              activity.write("stderr", chunk);
              this.options.onStderr?.(chunk);
              void writeDaytonaOpenCodeActivityLog(input.workspace, {
                attempt: input.attempt,
                channel: "stderr",
                raw: chunk,
                stage: input.stage,
              });
            },
            onStdout: (chunk) => {
              activity.write("stdout", chunk);
              this.options.onStdout?.(chunk);
              void writeDaytonaOpenCodeActivityLog(input.workspace, {
                attempt: input.attempt,
                channel: "stdout",
                raw: chunk,
                stage: input.stage,
              });
            },
            timeoutMs: Math.max(
              1,
              input.hardDeadlineAt - Date.now() + openCodeHardCapGraceMs,
            ),
          }),
        ),
      {
        activity,
        hardDeadlineAt: input.hardDeadlineAt,
        hardTimeoutMs: input.hardTimeoutMs,
        inactivityTimeoutMs: input.inactivityTimeoutMs,
        label: `${stageLabel(input.stage)} agent`,
        onTimeout: () => input.workspace.cancelActiveCommands?.(),
      },
    );
  }
}

const openCodeHardCapGraceMs = 30_000;
const makeADemoOpenCodeConfigDirectory = "/tmp/makeademo/opencode";

function stageLabel(stage: DaytonaOpenCodeStage) {
  switch (stage) {
    case "capture-path-repair":
      return "Capture Path repair";
    case "draft-composite-review":
      return "Draft Composite review";
    default:
      return "Script Generation";
  }
}

function createOpenCodeRunCommand(input: {
  model: string;
  prompt: string;
  sessionID: string;
}): string {
  return [
    "opencode run",
    "--dangerously-skip-permissions",
    "--format json",
    "--dir /workspace",
    `--session ${shellQuote(input.sessionID)}`,
    `--model ${shellQuote(input.model)}`,
    shellQuote(input.prompt),
  ].join(" ");
}

function removeUndefinedOptions(input: {
  env: Record<string, string>;
  onStderr: ((chunk: string) => void) | undefined;
  onStdout: ((chunk: string) => void) | undefined;
  timeoutMs: number;
}) {
  return {
    env: input.env,
    timeoutMs: input.timeoutMs,
    ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
    ...(input.onStdout === undefined ? {} : { onStdout: input.onStdout }),
  };
}

function createOpenCodeEnv(): Record<string, string> {
  return {
    OPENCODE_CONFIG_DIR: makeADemoOpenCodeConfigDirectory,
    OPENCODE_ENABLE_EXA: "1",
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
