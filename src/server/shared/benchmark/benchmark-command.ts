export type BenchmarkCommandArgs = {
  concurrency?: number;
  identityEvaluation?: true;
  repoIds: string[];
};

/**
 * Parses the benchmark runner's own flags before it creates output or starts
 * any Pipeline Job. Repository ids may surround the provider flag; `--` is
 * accepted as the package-runner separator and is not a repository id.
 */
export function parseBenchmarkCommandArgs(
  args: readonly string[],
): BenchmarkCommandArgs {
  const repoIds: string[] = [];
  let concurrency: number | undefined;
  let concurrencyFlagSeen = false;
  let identityEvaluation = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--concurrency") {
      if (concurrencyFlagSeen) {
        throw new Error(
          "Duplicate --concurrency flag. Specify it at most once.",
        );
      }
      concurrencyFlagSeen = true;
      const value = args[index + 1];
      if (value === undefined || value === "--" || value.startsWith("--")) {
        throw new Error(
          "Missing value for --concurrency. Expected a positive integer.",
        );
      }
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(
          `Invalid --concurrency value "${value}". Expected a positive integer.`,
        );
      }
      concurrency = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--identity-evaluation") {
      if (identityEvaluation) {
        throw new Error(
          "Duplicate --identity-evaluation flag. Specify it at most once.",
        );
      }
      identityEvaluation = true;
      continue;
    }
    repoIds.push(argument as string);
  }

  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(identityEvaluation ? { identityEvaluation: true as const } : {}),
    repoIds,
  };
}
