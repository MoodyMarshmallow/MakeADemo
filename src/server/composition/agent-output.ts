import { join } from "node:path";

import { createOpenCodeOutputStream } from "../agent-harness/opencode/opencode-output-stream";
import { createOpenCodeRawOutputLog } from "../agent-harness/opencode/opencode-raw-output-log";

export type AgentOutputRouter = {
  close: () => Promise<void>;
  primaryAuditLogPath: string;
  repoPreparation: AgentOutputRoute;
  agentTasks: AgentOutputRoute;
  scriptGenerationAuditLogPath: string;
};

type AgentOutputRoute = {
  onDiagnostic: (chunk: string) => void;
  onStandard: (chunk: string) => void;
};

/**
 * Keeps provider transport decoding and raw audit persistence inside Composition.
 * Pipeline callers only receive semantic diagnostic/standard output channels.
 */
export function createAgentOutputRouter(options: {
  runDirectory: string;
  writeDiagnostic: (chunk: string) => void;
  writeStandard: (text: string) => void;
}): AgentOutputRouter {
  const primaryAuditLog = createOpenCodeRawOutputLog({
    logPath: join(options.runDirectory, "opencode-raw-output.jsonl"),
  });
  const scriptGenerationAuditLog = createOpenCodeRawOutputLog({
    logPath: join(
      options.runDirectory,
      "script-generation-opencode-raw-output.jsonl",
    ),
  });
  const decodedOutput = createOpenCodeOutputStream({
    write: options.writeStandard,
  });

  const route = (includeScriptGenerationLog: boolean): AgentOutputRoute => ({
    onDiagnostic(chunk) {
      primaryAuditLog.write("stderr", chunk);
      if (includeScriptGenerationLog) {
        scriptGenerationAuditLog.write("stderr", chunk);
      }
      options.writeDiagnostic(chunk);
    },
    onStandard(chunk) {
      primaryAuditLog.write("stdout", chunk);
      if (includeScriptGenerationLog) {
        scriptGenerationAuditLog.write("stdout", chunk);
      }
      decodedOutput.write(chunk);
    },
  });

  return {
    close: async () => {
      await Promise.all([
        primaryAuditLog.close(),
        scriptGenerationAuditLog.close(),
      ]);
    },
    primaryAuditLogPath: primaryAuditLog.logPath,
    repoPreparation: route(false),
    agentTasks: route(true),
    scriptGenerationAuditLogPath: scriptGenerationAuditLog.logPath,
  };
}
