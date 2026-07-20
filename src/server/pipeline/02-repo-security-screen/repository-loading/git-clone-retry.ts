type GitCloneCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

const defaultCloneRetryDelaysMs = [100, 250];

export async function runGitCloneWithTransientRetry(input: {
  clone: () => Promise<GitCloneCommandResult>;
  retryDelaysMs?: number[];
  retryThrownErrors?: boolean;
}): Promise<GitCloneCommandResult> {
  const retryDelaysMs = input.retryDelaysMs ?? defaultCloneRetryDelaysMs;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await input.clone();
      if (
        result.exitCode === 0 ||
        attempt >= retryDelaysMs.length ||
        !isTransientGitCloneFailure(readCommandOutput(result))
      ) {
        return result;
      }
    } catch (error) {
      if (
        input.retryThrownErrors === false ||
        attempt >= retryDelaysMs.length ||
        !isTransientGitCloneFailure(readErrorMessage(error))
      ) {
        throw error;
      }
    }

    await delay(retryDelaysMs[attempt] ?? 0);
  }
}

function isTransientGitCloneFailure(output: string): boolean {
  return /could not resolve host|temporary failure in name resolution|name or service not known|econnrefused|connection refused|econnreset|connection reset|etimedout|timed out|operation timed out|the socket connection was closed unexpectedly/i.test(
    output,
  );
}

function readCommandOutput(result: GitCloneCommandResult): string {
  return [result.stderr, result.stdout]
    .filter((line) => line.length > 0)
    .join("\n");
}

function readErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return error.name === "Error"
    ? error.message
    : `${error.name}: ${error.message}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
