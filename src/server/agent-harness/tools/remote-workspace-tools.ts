import { posix } from "node:path";

import {
  type ToolDefinition,
  createCodingTools,
} from "@earendil-works/pi-coding-agent";

import type { AgentSessionWorkspace } from "../agent-session-runner.interface";

const defaultToolTimeoutMs = 120_000;

/**
 * Builds Pi's normal coding tools with all filesystem and shell operations
 * delegated to the active Daytona workspace. No local Pi built-in is exposed.
 */
export function createRemoteCodingToolDefinitions(input: {
  cwd: string;
  workspace: AgentSessionWorkspace;
  timeoutMs?: number;
}): ToolDefinition[] {
  const root = posix.resolve(input.cwd);
  const timeoutMs = input.timeoutMs ?? defaultToolTimeoutMs;
  const remote = createRemoteOperations(input.workspace, root, timeoutMs);
  return createCodingTools(root, {
    bash: { operations: remote.bash },
    edit: { operations: remote.edit },
    read: { operations: remote.read },
    write: { operations: remote.write },
  }).map(toToolDefinition);
}

function createRemoteOperations(
  workspace: AgentSessionWorkspace,
  root: string,
  timeoutMs: number,
) {
  const resolveLexicalPath = (path: string): string => {
    const absolutePath = posix.resolve(root, path);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
      throw new Error(
        "Pi workspace tool path must remain inside the Daytona workspace.",
      );
    }
    return absolutePath;
  };

  const execute = async (
    command: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    } = {},
  ) => {
    if (options.signal?.aborted === true) {
      throw new DOMException(
        "The Pi workspace tool was aborted.",
        "AbortError",
      );
    }
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      try {
        void Promise.resolve(workspace.cancelActiveCommands?.()).catch(
          () => undefined,
        );
      } catch {
        // Cancellation is best effort; preserve the tool's original error.
      }
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await workspace.execute(command, {
        env: {},
        timeoutMs: options.timeoutMs ?? timeoutMs,
        ...(options.onStdout === undefined
          ? {}
          : { onStdout: options.onStdout }),
        ...(options.onStderr === undefined
          ? {}
          : { onStderr: options.onStderr }),
      });
      if (result.exitCode !== 0) {
        throw new Error(
          [result.stderr, result.stdout].filter(Boolean).join("\n") ||
            `Remote workspace command exited with code ${result.exitCode}.`,
        );
      }
      return result;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  };

  const resolveRemotePath = async (
    inputPath: string,
    mode: "existing" | "writable",
    signal?: AbortSignal,
  ): Promise<string> => {
    const lexicalPath = resolveLexicalPath(inputPath);
    const flag = mode === "existing" ? "-e" : "-m";
    const result = await execute(
      `realpath ${flag} -- ${shellQuote(lexicalPath)}`,
      signal === undefined ? {} : { signal },
    );
    const canonicalPath = result.stdout.trim();
    if (
      canonicalPath.length === 0 ||
      canonicalPath !== lexicalPath ||
      (canonicalPath !== root && !canonicalPath.startsWith(`${root}/`))
    ) {
      throw new Error(
        "Pi workspace file paths must remain inside /workspace without symlinks.",
      );
    }
    return canonicalPath;
  };

  const readFile = async (absolutePath: string): Promise<Buffer> => {
    const path = await resolveRemotePath(absolutePath, "existing");
    const result = await execute(`base64 < ${shellQuote(path)}`);
    return Buffer.from(result.stdout.replaceAll(/\s/g, ""), "base64");
  };
  const writeFile = async (
    absolutePath: string,
    content: string,
  ): Promise<void> => {
    const path = await resolveRemotePath(absolutePath, "writable");
    const encoded = Buffer.from(content, "utf8").toString("base64");
    await execute(
      `mkdir -p ${shellQuote(posix.dirname(path))} && printf %s ${shellQuote(encoded)} | base64 --decode > ${shellQuote(path)}`,
    );
  };
  const readAccess = async (absolutePath: string): Promise<void> => {
    const path = await resolveRemotePath(absolutePath, "existing");
    await execute(`test -r ${shellQuote(path)}`);
  };
  const editAccess = async (absolutePath: string): Promise<void> => {
    const path = await resolveRemotePath(absolutePath, "existing");
    await execute(`test -r ${shellQuote(path)} && test -w ${shellQuote(path)}`);
  };
  const mkdir = async (directory: string): Promise<void> => {
    const path = await resolveRemotePath(directory, "writable");
    await execute(`mkdir -p ${shellQuote(path)}`);
  };

  return {
    bash: {
      exec: async (
        command: string,
        cwd: string,
        options: {
          onData: (data: Buffer) => void;
          signal?: AbortSignal;
          timeout?: number;
          env?: NodeJS.ProcessEnv;
        },
      ) => {
        const cwdPath = await resolveRemotePath(
          cwd,
          "existing",
          options.signal,
        );
        const result = await execute(
          `cd ${shellQuote(cwdPath)} && ${command}`,
          {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.timeout === undefined
              ? {}
              : { timeoutMs: options.timeout }),
            onStdout: (chunk) => options.onData(Buffer.from(chunk)),
            onStderr: (chunk) => options.onData(Buffer.from(chunk)),
          },
        );
        return { exitCode: result.exitCode };
      },
    },
    edit: { access: editAccess, readFile, writeFile },
    read: {
      access: readAccess,
      detectImageMimeType: async (absolutePath: string) =>
        supportedImageMimeType(resolveLexicalPath(absolutePath)),
      readFile,
    },
    write: { mkdir, writeFile },
  };
}

function supportedImageMimeType(path: string): string | null {
  const extension = posix.extname(path).toLowerCase();
  return (
    {
      ".bmp": "image/bmp",
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[extension] ?? null
  );
}

function toToolDefinition(
  tool: ReturnType<typeof createCodingTools>[number],
): ToolDefinition {
  return {
    description: tool.description,
    execute: async (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate),
    label: tool.label,
    name: tool.name,
    parameters: tool.parameters,
    ...(tool.executionMode === undefined
      ? {}
      : { executionMode: tool.executionMode }),
    ...(tool.prepareArguments === undefined
      ? {}
      : { prepareArguments: tool.prepareArguments }),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
