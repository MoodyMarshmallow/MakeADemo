import { isPipelineCancellationError } from "../pipeline/00-orchestration/job/pipeline-cancellation";

/** Adds provider provenance to every durable full-Pipeline terminal outcome. */
export function addSandboxProviderToTerminalOutput(input: {
  output: string;
  sandboxProvider: "daytona" | "railway";
}): string {
  const output = input.output.startsWith("\n")
    ? input.output.slice(1)
    : input.output;
  return `\nSandbox provider: ${input.sandboxProvider}\n${output}`;
}

/**
 * Owns pre-Pipeline input loading and turns its cooperative cancellation into
 * the same durable terminal result flow used after the Pipeline starts.
 */
export async function runFullPipelineCliOperation<Prepared, Result>(input: {
  materializeCancellation: (error: Error) => Promise<Result>;
  prepare: () => Promise<Prepared>;
  run: (prepared: Prepared) => Promise<Result>;
}): Promise<Result> {
  let pipelineStarted = false;
  try {
    const prepared = await input.prepare();
    pipelineStarted = true;
    return await input.run(prepared);
  } catch (error) {
    if (!pipelineStarted && isPipelineCancellationError(error)) {
      return await input.materializeCancellation(error);
    }
    throw error;
  }
}

/** Completes CLI-owned resources before exposing a terminal result marker. */
export async function finalizeFullPipelineCli(input: {
  cleanup: () => Promise<void>;
  removeSignalHandlers: () => void;
  terminalOutput?: string;
  write: (output: string) => void;
}): Promise<void> {
  await input.cleanup();
  input.removeSignalHandlers();
  if (input.terminalOutput !== undefined) input.write(input.terminalOutput);
}
