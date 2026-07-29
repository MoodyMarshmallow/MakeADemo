import {
  runSettledPipelineOperation,
  throwIfPipelineDeadlineReached,
} from "../../../pipeline/00-orchestration/job/pipeline-cancellation";
import type { RepoSecurityInput } from "../../../pipeline/02-repo-security-screen/repo-security-screen";
import { createGitCloneCommand } from "../../../pipeline/02-repo-security-screen/repository-loading/git-clone-command";
import { runGitCloneWithTransientRetry } from "../../../pipeline/02-repo-security-screen/repository-loading/git-clone-retry";
import type {
  RepoSecurityInputLoadInput,
  RepoSecurityInputLoader,
} from "../../../pipeline/02-repo-security-screen/repository-loading/repo-security-input-loader.interface";
import type {
  RailwaySandboxGateway,
  RailwaySandboxGatewayCommand,
  RailwaySandboxGatewaySandbox,
} from "./railway-sandbox-gateway.interface";

const workspacePath = "/workspace";
const cloneTimeoutMs = 120_000;

/**
 * Railway implementation of the static Repo Security Screen loading seam.
 * It only clones and inventories files; it never installs or executes
 * submitted project code.
 */
export class RailwayRepoSecurityInputLoader implements RepoSecurityInputLoader {
  constructor(private readonly gateway: RailwaySandboxGateway) {}

  async load(input: RepoSecurityInputLoadInput): Promise<RepoSecurityInput> {
    let workspace: RailwayRepositoryLoadingWorkspace | undefined;
    return await runSettledPipelineOperation({
      deadlineAt: input.deadlineAt,
      onCancel: async () => workspace?.cancelActiveCommands(),
      operation: (async () => {
        throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
        const created = await RailwayRepositoryLoadingWorkspace.create(
          this.gateway,
          input.signal,
        );
        workspace = created;
        try {
          const clone = await runGitCloneWithTransientRetry({
            clone: () => created.execute(createCloneCommand(input)),
            retryThrownErrors: false,
          });
          if (clone.exitCode !== 0) {
            throw new Error(
              `Railway git clone failed: ${[clone.stderr, clone.stdout].filter(Boolean).join("\n")}`,
            );
          }
          throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
          return await inventoryWorkspace(created, input);
        } finally {
          await created.release();
          workspace = undefined;
        }
      })(),
      signal: input.signal,
    });
  }
}

class RailwayRepositoryLoadingWorkspace {
  private active: RailwaySandboxGatewayCommand | undefined;
  private releasing = false;
  private releasePromise: Promise<void> | undefined;

  private constructor(
    private readonly gateway: RailwaySandboxGateway,
    private readonly sandbox: RailwaySandboxGatewaySandbox,
  ) {}

  static async create(
    gateway: RailwaySandboxGateway,
    signal: AbortSignal | undefined,
  ): Promise<RailwayRepositoryLoadingWorkspace> {
    const sandbox = await gateway.createSandbox({
      env: {},
      idleTimeoutMinutes: 15,
      networkIsolation: "ISOLATED",
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 630_000,
    });
    return new RailwayRepositoryLoadingWorkspace(gateway, sandbox);
  }

  async execute(
    command: string,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    if (this.releasing)
      throw new Error("Railway repository workspace is releasing.");
    const active = await this.gateway.execute(this.sandbox, command, {
      cwd: workspacePath,
      env: {},
      timeoutMs: cloneTimeoutMs,
    });
    this.active = active;
    try {
      const result = await active.result();
      if (result.timedOut || result.truncated) {
        throw new Error(
          "Railway repository loading failed closed because provider output was timed out or truncated.",
        );
      }
      return {
        exitCode: result.exitCode ?? -1,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  async cancelActiveCommands(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    await Promise.allSettled([active.kill(), active.result()]);
  }

  release(): Promise<void> {
    this.releasePromise ??= (async () => {
      this.releasing = true;
      await this.cancelActiveCommands();
      await this.gateway.destroySandbox(this.sandbox);
    })();
    return this.releasePromise;
  }
}

async function inventoryWorkspace(
  workspace: RailwayRepositoryLoadingWorkspace,
  input: RepoSecurityInputLoadInput,
): Promise<RepoSecurityInput> {
  const stats = await workspace.execute(
    `find ${shellQuote(workspacePath)} -path ${shellQuote(`${workspacePath}/.git`)} -prune -o -path ${shellQuote(`${workspacePath}/node_modules`)} -prune -o -type f -printf '%P\\t%s\\n'`,
  );
  if (stats.exitCode !== 0)
    throw new Error("Railway repository file inventory failed.");
  const files = await Promise.all(
    stats.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map(async (line) => {
        const [path = "", size = "0"] = line.split("\t");
        throwIfPipelineDeadlineReached(input.signal, input.deadlineAt);
        if (!input.shouldReadText(path))
          return { path, sizeBytes: Number(size) };
        const content = await workspace.execute(
          `cat ${shellQuote(`${workspacePath}/${path}`)}`,
        );
        if (content.exitCode !== 0)
          throw new Error(`Railway repository text read failed for ${path}.`);
        return { path, sizeBytes: Number(size), text: content.stdout };
      }),
  );
  return {
    files: files.map(({ path, text }) =>
      text === undefined ? { path } : { path, text },
    ),
    repoStats: {
      fileCount: files.length,
      sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    },
  };
}

function createCloneCommand(input: RepoSecurityInputLoadInput): string {
  return createGitCloneCommand({
    caBundleCandidates: ["/etc/ssl/certs/ca-certificates.crt"],
    ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
    destinationPath: workspacePath,
    repoUrl: input.repoUrl,
    resetCommand: `mkdir -p ${shellQuote(workspacePath)} && find ${shellQuote(workspacePath)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
