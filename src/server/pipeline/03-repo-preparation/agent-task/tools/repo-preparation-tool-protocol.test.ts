import { describe, expect, it } from "vitest";

import type { AgentToolCall } from "../../../../agent-harness/agent-session-runner.interface";
import {
  decodeRepoPreparationToolCall,
  repoPreparationToolNames,
} from "./repo-preparation-tool-protocol";

describe("Repo Preparation tool protocol", () => {
  it("owns the complete list of stage tool names", () => {
    expect(repoPreparationToolNames).toEqual([
      "makeademo_dependency_request_install",
      "makeademo_install_dependencies",
      "makeademo_validate_preparation",
    ]);
  });

  it.each([
    {
      call: {
        input: { command: "bun install" },
        name: "makeademo_dependency_request_install",
      },
      handoff: {
        input: { command: "bun install" },
        toolName: "makeademo_dependency_request_install",
      },
    },
    {
      call: {
        input: { command: "npm ci" },
        name: "makeademo_install_dependencies",
      },
      handoff: {
        input: { command: "npm ci" },
        toolName: "makeademo_install_dependencies",
      },
    },
    {
      call: {
        input: { manifestPath: "/tmp/makeademo/manifest.json" },
        name: "makeademo_validate_preparation",
      },
      handoff: {
        input: { manifestPath: "/tmp/makeademo/manifest.json" },
        toolName: "makeademo_validate_preparation",
      },
    },
  ] satisfies {
    call: AgentToolCall;
    handoff: ReturnType<typeof decodeRepoPreparationToolCall>["handoff"];
  }[])(
    "decodes $call.name with the stage-owned schema",
    ({ call, handoff }) => {
      expect(decodeRepoPreparationToolCall(call)).toEqual({ handoff });
    },
  );

  it.each([
    [
      { input: {}, name: "makeademo_dependency_request_install" },
      "input.command",
    ],
    [
      { input: {}, name: "makeademo_validate_preparation" },
      "input.manifestPath",
    ],
    [
      { input: { command: 42 }, name: "makeademo_install_dependencies" },
      "input.command",
    ],
  ] satisfies [AgentToolCall, string][])(
    "rejects malformed %s calls",
    (call, error) => {
      expect(decodeRepoPreparationToolCall(call)).toEqual({
        error: expect.stringContaining(error),
      });
    },
  );

  it("does not assign a Repo Preparation meaning to a different stage tool", () => {
    expect(
      decodeRepoPreparationToolCall({
        input: { command: "anything" },
        name: "script_generation_submit",
      }),
    ).toEqual({});
  });
});
