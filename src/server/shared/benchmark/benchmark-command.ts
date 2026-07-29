import type { BenchmarkSandboxProvider } from "./benchmark-manifest";

export type BenchmarkCommandArgs = {
  repoIds: string[];
  sandboxProvider: BenchmarkSandboxProvider;
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
  let sandboxProvider: BenchmarkSandboxProvider = "daytona";
  let providerFlagSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument !== "--sandbox-provider") {
      repoIds.push(argument as string);
      continue;
    }

    if (providerFlagSeen) {
      throw new Error(
        "Duplicate --sandbox-provider flag. Specify it at most once.",
      );
    }
    providerFlagSeen = true;
    const value = args[index + 1];
    if (value === undefined || value === "--" || value.startsWith("--")) {
      throw new Error(
        "Missing value for --sandbox-provider. Expected daytona or railway.",
      );
    }
    if (value !== "daytona" && value !== "railway") {
      throw new Error(
        `Unsupported sandbox provider "${value}". Expected daytona or railway.`,
      );
    }
    sandboxProvider = value;
    index += 1;
  }

  return { repoIds, sandboxProvider };
}
