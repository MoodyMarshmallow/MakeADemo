import { describe, expect, it, vi } from "vitest";

import { canonicalizeReadOnlyCommand } from "../../../shared/repository-inspection-command";
import { createReadOnlyExecCommandTool } from "./read-only-exec-command";

describe("read-only exec_command", () => {
  it("runs a bounded repository search through structured argv", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "src/index.ts:4:dangerousCall()\n",
    }));
    const tool = createReadOnlyExecCommandTool({ execute });

    const result = await tool.execute({
      argv: ["rg", "-n", "-F", "dangerousCall", "src"],
    });

    expect(execute).toHaveBeenCalledWith(
      {
        argv: ["rg", "-n", "-F", "dangerousCall", "src"],
      },
      { timeoutMs: 15_000 },
    );
    expect(JSON.parse(result)).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "src/index.ts:4:dangerousCall()\n",
      truncated: false,
    });
  });

  it("keeps a dash-prefixed search pattern from becoming an rg option", () => {
    expect(
      canonicalizeReadOnlyCommand({
        argv: ["rg", "--", "--pre=sh", "scripts/install.sh"],
      }),
    ).toEqual({
      argv: [
        "rg",
        "--color=never",
        "--no-heading",
        "--max-count=2000",
        "--max-columns=1000",
        "--max-columns-preview",
        "--glob=!.git/**",
        "--glob=!.makeademo/**",
        "-e",
        "--pre=sh",
        "--",
        "scripts/install.sh",
      ],
    });
  });

  it("lists files with bounded rg globs without exposing internal paths", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "src/index.ts\n",
    }));
    const tool = createReadOnlyExecCommandTool({ execute });

    await tool.execute({
      argv: ["rg", "--files", "--hidden", "-g", "*.ts", "src"],
    });

    expect(execute).toHaveBeenCalledWith(
      {
        argv: ["rg", "--files", "--hidden", "-g", "*.ts", "src"],
      },
      { timeoutMs: 15_000 },
    );
  });

  it("reads at most four hundred lines with print-only sed", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "const safe = true;\n",
    }));
    const tool = createReadOnlyExecCommandTool({ execute });

    await tool.execute({ argv: ["sed", "-n", "20,40p", "--", "src/app.ts"] });

    expect(execute).toHaveBeenCalledWith(
      { argv: ["sed", "-n", "20,40p", "--", "src/app.ts"] },
      { timeoutMs: 15_000 },
    );
  });

  it("canonicalizes Git status to a non-locking tracked-file query", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: " M src/app.ts\n",
    }));
    const tool = createReadOnlyExecCommandTool({ execute });

    await tool.execute({ argv: ["git", "status", "--short"] });

    expect(execute).toHaveBeenCalledWith(
      { argv: ["git", "status", "--short"] },
      { timeoutMs: 15_000 },
    );
  });

  it("bounds command output before returning it to the agent", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "e".repeat(20 * 1_024),
      stdout: `${"line\n".repeat(2_100)}${"x".repeat(140 * 1_024)}`,
    }));
    const tool = createReadOnlyExecCommandTool({ execute });

    const result = JSON.parse(
      await tool.execute({ argv: ["rg", "needle", "."] }),
    ) as { stderr: string; stdout: string; truncated: boolean };

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128 * 1_024);
    expect(result.stdout.split("\n")).toHaveLength(2_001);
    expect(Buffer.byteLength(result.stderr)).toBe(16 * 1_024);
    expect(result.truncated).toBe(true);
  });

  it.each([
    ["shell", ["sh", "-c", "touch /tmp/pwned"]],
    ["rg preprocessor", ["rg", "--pre", "sh", "needle", "."]],
    ["sed execution", ["sed", "-n", "1e id", "--", "README.md"]],
    ["git configuration", ["git", "config", "core.pager", "id"]],
    ["absolute path", ["rg", "needle", "/etc/passwd"]],
    ["traversal", ["rg", "needle", "../outside"]],
    ["NUL byte", ["rg", "needle\0suffix", "."]],
    ["Git internals", ["sed", "-n", "1p", "--", ".git/config"]],
    [
      "MakeADemo internals",
      ["sed", "-n", "1p", "--", ".makeademo/audit.jsonl"],
    ],
  ])(
    "rejects %s escape attempts before provider execution",
    async (_name, argv) => {
      const execute = vi.fn(async () => ({
        exitCode: 0,
        stderr: "",
        stdout: "",
      }));
      const tool = createReadOnlyExecCommandTool({ execute });

      await expect(tool.execute({ argv })).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("stops after the per-review command budget is exhausted", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 1,
      stderr: "",
      stdout: "",
    }));
    const tool = createReadOnlyExecCommandTool({ execute });

    for (let call = 0; call < 32; call += 1) {
      await tool.execute({ argv: ["rg", "needle", "."] });
    }

    await expect(tool.execute({ argv: ["rg", "needle", "."] })).rejects.toThrow(
      "32-call",
    );
    expect(execute).toHaveBeenCalledTimes(32);
  });
});
