import { describe, expect, it } from "vitest";

import { classifyDependencyInstallFailure } from "./dependency-install-failure-classifier";
import type { SubmittedCodeToolchainPlan } from "./submitted-code-toolchain.schema";

const yarnClassicPlan = {
  node: { family: 18, lifecycle: "legacy-eol", version: "18.20.8" },
  packageManager: {
    generation: "yarn-classic",
    name: "yarn",
    version: "1.22.22",
  },
} as SubmittedCodeToolchainPlan;

describe("classifyDependencyInstallFailure", () => {
  it("recognizes Yarn Classic's bounded Node engine incompatibility diagnostic", () => {
    expect(
      classifyDependencyInstallFailure({
        plan: yarnClassicPlan,
        result: {
          exitCode: 1,
          stderr: "",
          stdout: [
            "yarn install v1.22.22",
            '\u001b[31merror @excalidraw/excalidraw@0.18.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.8".\u001b[0m',
            "error Found incompatible module.",
          ].join("\n"),
        },
      }),
    ).toEqual({
      actualNodeVersion: "18.20.8",
      dependency: "@excalidraw/excalidraw@0.18.0",
      expectedNodeRange: ">=20",
      failureKind: "repository_node_dependency_incompatible",
    });
  });

  it.each([
    {
      name: "successful installs",
      plan: yarnClassicPlan,
      result: {
        exitCode: 0,
        stderr: "",
        stdout:
          'error package@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.8".\nerror Found incompatible module.',
      },
    },
    {
      name: "Yarn Berry output",
      plan: {
        ...yarnClassicPlan,
        packageManager: {
          generation: "yarn-berry",
          name: "yarn",
          version: "4.12.0",
        },
      } as SubmittedCodeToolchainPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout:
          'error package@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.8".\nerror Found incompatible module.',
      },
    },
    {
      name: "generic engine-like application output",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "The engine node is incompatible",
        stdout: "",
      },
    },
    {
      name: "multiple canonical diagnostics",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout: [
          'error first@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.8".',
          'error second@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.8".',
          "error Found incompatible module.",
        ].join("\n"),
      },
    },
    {
      name: "a diagnostic Node version that differs from the plan",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout:
          'error package@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.7".\nerror Found incompatible module.',
      },
    },
    {
      name: "a satisfying expected range",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout:
          'error package@1.0.0: The engine "node" is incompatible with this module. Expected version ">=18". Got "18.20.8".\nerror Found incompatible module.',
      },
    },
    {
      name: "an invalid dependency package name",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout:
          'error BAD PACKAGE@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.8".\nerror Found incompatible module.',
      },
    },
    {
      name: "a URL expected range",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout:
          'error package@1.0.0: The engine "node" is incompatible with this module. Expected version "https://evil.test/node". Got "18.20.8".\nerror Found incompatible module.',
      },
    },
    {
      name: "a prerelease expected range",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout:
          'error package@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20.0.0-beta.1". Got "18.20.8".\nerror Found incompatible module.',
      },
    },
    {
      name: "an oversized expected range",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout: `error package@1.0.0: The engine "node" is incompatible with this module. Expected version "${">=20 || ".repeat(20)}>=20". Got "18.20.8".\nerror Found incompatible module.`,
      },
    },
    {
      name: "diagnostics outside the bounded tail",
      plan: yarnClassicPlan,
      result: {
        exitCode: 1,
        stderr: "",
        stdout: `${'error package@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "18.20.8".\nerror Found incompatible module.\n'}${"x".repeat(9_000)}`,
      },
    },
  ])("does not classify $name", ({ plan, result }) => {
    expect(classifyDependencyInstallFailure({ plan, result })).toBeUndefined();
  });
});
