import { describe, expect, it } from "vitest";

import {
  createBoundedInstallEnvironment,
  runPlannedDependencyInstall,
} from "./planned-dependency-install";
import type { PreparationWorkspace } from "./preparation-workspace.interface";
import { submittedCodeKnownGoodNodeReleaseSnapshot } from "./submitted-code-node-release-catalog.interface";
import { resolveSubmittedCodeToolchain } from "./submitted-code-toolchain.schema";

describe("runPlannedDependencyInstall", () => {
  it("executes immutable catalog argv with the backend-owned bounded install profile", async () => {
    const events: unknown[] = [];
    const workspace: PreparationWorkspace = {
      async execute() {
        throw new Error(
          "outer workspace execution must not run submitted code",
        );
      },
      async executeSubmittedProject(request, options) {
        events.push({
          argv: request.argv,
          env: options?.env,
          executable: request.executable,
          installProfile: request.installProfile,
          projectRoot: request.plan.projectRoot,
        });
        return { exitCode: 0, stderr: "", stdout: "planned install completed" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async uploadFiles() {},
    };

    const result = await runPlannedDependencyInstall({
      toolchainPlan: resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                "package.json": JSON.stringify({
                  engines: { node: "22" },
                  packageManager: "pnpm@10.27.0",
                }),
                "pnpm-lock.yaml": "",
              },
              projectRoot: ".",
            },
          ],
        },
        submittedCodeKnownGoodNodeReleaseSnapshot,
      ),
      workspace,
    });

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "planned install completed",
    });
    expect(events).toEqual([
      {
        argv: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        env: {
          CHILD_CONCURRENCY: "2",
          CMAKE_BUILD_PARALLEL_LEVEL: "2",
          MAKEFLAGS: "-j2",
          TURBO_CONCURRENCY: "2",
        },
        executable: "pnpm",
        installProfile: "bounded",
        projectRoot: ".",
      },
    ]);
  });

  it("binds Yarn Berry's documented concurrency configuration", async () => {
    const requests: unknown[] = [];
    const workspace: PreparationWorkspace = {
      async execute() {
        throw new Error(
          "outer workspace execution must not run submitted code",
        );
      },
      async executeSubmittedProject(request, options) {
        requests.push({ ...request, env: options?.env });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test";
      },
      async uploadFiles() {},
    };
    const toolchainPlan = resolveSubmittedCodeToolchain(
      {
        candidates: [
          {
            files: {
              "package.json": JSON.stringify({
                engines: { node: "22" },
                packageManager: "yarn@4.12.0",
              }),
              "yarn.lock": "__metadata:\n  version: 8\n",
            },
            projectRoot: ".",
          },
        ],
      },
      submittedCodeKnownGoodNodeReleaseSnapshot,
    );

    await runPlannedDependencyInstall({
      toolchainPlan,
      workspace,
    });

    expect(requests).toEqual([
      expect.objectContaining({
        argv: ["install", "--immutable"],
        executable: "yarn",
        env: {
          CHILD_CONCURRENCY: "2",
          CMAKE_BUILD_PARALLEL_LEVEL: "2",
          MAKEFLAGS: "-j2",
          TURBO_CONCURRENCY: "2",
          YARN_NETWORK_CONCURRENCY: "4",
          YARN_TASK_POOL_CONCURRENCY: "2",
        },
        installProfile: "bounded",
      }),
    ]);
  });

  it("does not send Yarn 4's task-pool key to Yarn 2 or 3", () => {
    for (const version of ["2.4.2", "3.8.7"]) {
      const plan = resolveSubmittedCodeToolchain(
        {
          candidates: [
            {
              files: {
                "package.json": JSON.stringify({
                  packageManager: `yarn@${version}`,
                }),
                "yarn.lock": "__metadata:\n  version: 6\n",
              },
              projectRoot: ".",
            },
          ],
        },
        submittedCodeKnownGoodNodeReleaseSnapshot,
      );

      expect(createBoundedInstallEnvironment(plan)).toEqual({
        CHILD_CONCURRENCY: "2",
        CMAKE_BUILD_PARALLEL_LEVEL: "2",
        MAKEFLAGS: "-j2",
        TURBO_CONCURRENCY: "2",
        YARN_NETWORK_CONCURRENCY: "4",
      });
    }
  });

  it("puts verified manager controls in catalog-owned argv", () => {
    const cases = [
      {
        expected: ["ci", "--maxsockets=4"],
        files: {
          "package-lock.json": "{}",
          "package.json": JSON.stringify({ packageManager: "npm@9.9.4" }),
        },
      },
      {
        expected: [
          "install",
          "--frozen-lockfile",
          "--child-concurrency=2",
          "--network-concurrency=4",
        ],
        files: {
          "package.json": JSON.stringify({ packageManager: "pnpm@11.17.0" }),
          "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        },
      },
      {
        expected: [
          "install",
          "--frozen-lockfile",
          "--network-concurrency",
          "4",
        ],
        files: {
          "package.json": JSON.stringify({ packageManager: "yarn@1.22.22" }),
          "yarn.lock": "# yarn lockfile v1\n",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const plan = resolveSubmittedCodeToolchain(
        { candidates: [{ files: testCase.files, projectRoot: "." }] },
        submittedCodeKnownGoodNodeReleaseSnapshot,
      );
      expect(plan.install?.argv).toEqual(testCase.expected);
      expect(createBoundedInstallEnvironment(plan)).toEqual({
        CHILD_CONCURRENCY: "2",
        CMAKE_BUILD_PARALLEL_LEVEL: "2",
        MAKEFLAGS: "-j2",
        TURBO_CONCURRENCY: "2",
      });
    }
  });

  it("does not invent npm environment knobs", () => {
    const plan = resolveSubmittedCodeToolchain(
      {
        candidates: [
          {
            files: {
              "package-lock.json": "{}",
              "package.json": JSON.stringify({ packageManager: "npm@9.9.4" }),
            },
            projectRoot: ".",
          },
        ],
      },
      submittedCodeKnownGoodNodeReleaseSnapshot,
    );

    expect(createBoundedInstallEnvironment(plan)).toEqual({
      CHILD_CONCURRENCY: "2",
      CMAKE_BUILD_PARALLEL_LEVEL: "2",
      MAKEFLAGS: "-j2",
      TURBO_CONCURRENCY: "2",
    });
  });
});
