import { describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../../../agent-harness/agent-session";
import type {
  AgentSessionWorkspace,
  AgentTaskRunInput,
  AgentTaskRunResult,
  AgentTaskRunner,
} from "../../../agent-harness/agent-session-runner.interface";
import { createPipelineEventLogger } from "../../../shared/logging/pipeline-event-logger";
import { createAgentSession } from "../../../test-support/create-agent-session";
import type { PreparationWorkspaceProvider } from "../preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  SubmittedProjectExecutionRequest,
} from "../preparation-workspace.interface";
import {
  AgenticRepoPreparation,
  type AgenticRepoPreparationOptions,
} from "./agentic-repo-preparation";
import type { RepoPreparationToolHandoff } from "./tools/repo-preparation-tool-protocol";

type RepoPreparationTestOptions = Omit<
  AgenticRepoPreparationOptions,
  "runner"
> & {
  runner?: AgenticRepoPreparationOptions["runner"];
};

class RecordingAgentTaskRunner implements AgentTaskRunner {
  nextSession?: AgentSession;
  readonly calls: Array<{
    attempt: number;
    hardDeadlineAt: number;
    session?: unknown;
    stage: string;
    taskPrompt: string;
    toolProtocol?: unknown;
    tools?: readonly string[];
  }> = [];

  async run<T>(input: AgentTaskRunInput<T>): Promise<AgentTaskRunResult<T>> {
    this.calls.push({
      attempt: input.attempt,
      stage: input.stage,
      taskPrompt: input.taskPrompt,
      hardDeadlineAt: input.hardDeadlineAt,
      ...(input.toolProtocol === undefined
        ? {}
        : { toolProtocol: input.toolProtocol }),
      ...(input.tools === undefined
        ? {}
        : { tools: input.tools.map((tool) => tool.name) }),
      ...(input.session === undefined ? {} : { session: input.session }),
    });
    const planned = plannedAgentResultsByWorkspace
      .get(
        (input.workspace as AgentSessionWorkspace & { baseWorkspace?: object })
          .baseWorkspace ?? input.workspace,
      )
      ?.shift();
    if (planned instanceof Error) throw planned;
    const session = input.session ?? this.nextSession ?? createAgentSession();
    this.nextSession = session;
    return {
      ...(planned === undefined
        ? { exitCode: 0, structuredOutput: successResult() }
        : planned),
      session,
    } as AgentTaskRunResult<T>;
  }
}

const plannedAgentResultsByWorkspace = new WeakMap<
  object,
  Array<AgentTaskRunResult<RepoPreparationToolHandoff> | Error>
>();

function createRepoPreparationAgent(options: RepoPreparationTestOptions) {
  const { ...agentOptions } = options;
  return new AgenticRepoPreparation({
    ...agentOptions,
    runner: agentOptions.runner ?? new RecordingAgentTaskRunner(),
    validatePreparation:
      agentOptions.validatePreparation ??
      (async () => validationArtifact().validation),
  });
}

describe("AgenticRepoPreparation", () => {
  it("clones the submitted repo and runs Agent Task inside Daytona", async () => {
    const events: unknown[] = [];
    const runner = new RecordingAgentTaskRunner();
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      runner,
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      status: "succeeded",
      workspace: { id: "daytona_workspace" },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        {
          execute: expect.stringContaining(
            "checkout --detach '0123456789abcdef0123456789abcdef01234567'",
          ),
        },
        { network: false },
        { prepareForAgent: true },
      ]),
    );

    const cloneCommands = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("git clone"),
      )
      .map((event) => event.execute);
    expect(cloneCommands).toHaveLength(1);
    expect(cloneCommands[0]).toContain(
      `test "$(git -C '/workspace' rev-parse HEAD)" = '0123456789abcdef0123456789abcdef01234567'`,
    );
    expect(cloneCommands[0]).toContain("/etc/ssl/certs/ca-certificates.crt");
    expect(cloneCommands[0]).toContain("/etc/pki/tls/certs/ca-bundle.crt");
    expect(cloneCommands[0]).toContain("/etc/openshell-tls/ca-bundle.pem");
    expect(cloneCommands[0]).toMatch(/export GIT_SSL_CAINFO=.*git clone/s);
    expect(cloneCommands[0]).not.toContain("GIT_SSL_NO_VERIFY");
    expect(cloneCommands[0]).not.toContain("sslVerify=false");
    expect(runner.calls[0]).toMatchObject({
      hardDeadlineAt: expect.any(Number),
      toolProtocol: expect.objectContaining({
        trackedNames: expect.arrayContaining([
          "makeademo_validate_preparation",
        ]),
      }),
      tools: expect.arrayContaining([
        "makeademo_dependency_request_install",
        "makeademo_install_dependencies",
        "makeademo_validate_preparation",
        "makeademo_submit_preparation_result",
      ]),
    });
  });

  it("continues Repo Preparation when sandbox progress logging fails", async () => {
    const events: unknown[] = [];
    const pipelineLogs: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = createRepoPreparationAgent({
      logger: createPipelineEventLogger({
        base: { component: "repo-preparation-agent" },
        sinks: [
          {
            write(line) {
              pipelineLogs.push(JSON.parse(line) as Record<string, unknown>);
            },
          },
        ],
      }),
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "workspace-created",
        validationResult: validationArtifact(),
      }),
      timeoutMs: 1_000,
    });

    try {
      const result = await agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      });

      expect(result).toMatchObject({
        manifest: { demoCommand: "npm run demo:makeademo" },
        status: "succeeded",
      });
      expect(warn).not.toHaveBeenCalled();
      expect(pipelineLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            component: "repo-preparation-agent",
            error: "sandbox log sink failed",
            event: "sandbox-log-write-failed",
            failedEvent: "workspace-created",
            level: "warn",
            stage: "repo-preparation",
            workspaceComponent: "sandbox-log",
          }),
        ]),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("continues Repo Preparation when sandbox progress logging fails and fallback warning logging hangs", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      logger: {
        child() {
          return this;
        },
        debug: vi.fn(async () => {}),
        error: vi.fn(async () => {}),
        flush: vi.fn(async () => {}),
        info: vi.fn(async () => {}),
        warn: vi.fn(() => new Promise<void>(() => {})),
      },
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "workspace-created",
        validationResult: validationArtifact(),
      }),
      timeoutMs: 1_000,
    });

    const result = await Promise.race([
      agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      }),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      status: "succeeded",
    });
  });

  it("retries transient Daytona clone connection failures before starting Agent Task", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        cloneResults: [
          new Error(
            "DaytonaConnectionError: connect ECONNREFUSED 127.0.0.1:443",
          ),
          { exitCode: 0, stderr: "", stdout: "cloned" },
        ],
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("git clone"),
      ),
    ).toHaveLength(2);
  });

  it("retries Daytona socket-closed clone failures before starting Agent Task", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        captureCloneTimeouts: true,
        cloneResults: [
          new Error("The socket connection was closed unexpectedly..."),
          { exitCode: 0, stderr: "", stdout: "cloned" },
        ],
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(
      events.filter(
        (event): event is { cloneTimeoutMs: number } =>
          typeof event === "object" &&
          event !== null &&
          "cloneTimeoutMs" in event,
      ),
    ).toEqual([{ cloneTimeoutMs: 120_000 }, { cloneTimeoutMs: 120_000 }]);
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("git clone"),
      ),
    ).toHaveLength(2);
  });

  it("does not retry Agent Task execution errors from the Repo Preparation agent", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        agentResults: [new Error("PTY connection timeout")],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["PTY connection timeout"],
      status: "failed",
    });
  });

  it("does not retry a generic nonzero Agent Task result without a handoff artifact", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: [
          {
            exitCode: 1,
            failure: { category: "execution", message: "agent failed" },
          },
        ],
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["agent failed"],
      status: "failed",
    });
    expect(events.filter(isReleaseEvent)).toHaveLength(1);
  });

  it("returns a provider-neutral invalid-credential blocker without retrying", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: [providerInvalidApiKeyFailure("sk-proj-********test")],
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        "Agent provider authentication failed because the provider rejected the configured API key.",
      ],
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("sk-proj");
    expect(events.filter(isReleaseEvent)).toHaveLength(1);
  });

  it("reports pre-Agent Task git clone failures as Repo Preparation clone blockers", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        cloneResults: [
          {
            exitCode: 128,
            stderr:
              "fatal: unable to access 'https://github.com/example/app/': server certificate verification failed. CAfile: none CRLfile: none",
            stdout: "",
          },
        ],
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        expect.stringMatching(
          /Repo Preparation could not clone the submitted repository in the parent agent workspace[\s\S]*server certificate verification failed/,
        ),
      ],
      status: "failed",
      suggestedChanges: [
        "Retry Repo Preparation after the submitted repository can be cloned from the Daytona workspace.",
      ],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        { network: false },
        { release: "daytona_workspace" },
      ]),
    );
  });

  it("writes bounded CA and tool diagnostics when the pre-Agent Task clone fails", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      cloneFailureDiagnosticsContext: {
        daytonaSnapshot: "makeademo-agent-snapshot",
        daytonaSubmittedCodeSnapshot: "makeademo-submitted-code-browser",
      },
      provider: fakeProvider(events, {
        cloneDiagnosticsStdout: [
          "caCertificatesCrtExists=true",
          "openshellCaBundleExists=true",
          "openshellCaBundleReadable=true",
          "openshellCaBundlePath=/etc/openshell-tls/ca-bundle.pem",
          "openshellCaCertExists=true",
          "openshellCaCertReadable=true",
          "openshellCaCertPath=/etc/openshell-tls/openshell-ca.pem",
          "caEnvPath_GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem",
          "gitSslCAInfo=file:/root/.gitconfig\t/etc/openshell-tls/ca-bundle.pem",
          "gitVersion=git version 2.45.2",
          "opensslVersion=OpenSSL 3.3.1 4 Jun 2024",
        ].join("\n"),
        cloneResults: [
          {
            exitCode: 128,
            stderr: "server certificate verification failed. CAfile: none",
            stdout: "",
          },
        ],
      }),
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        {
          execute: expect.stringContaining("makeademo_clone_diagnostics"),
        },
        {
          sandboxLog: expect.objectContaining({
            caCertificatesCrtExists: true,
            daytonaSnapshot: "makeademo-agent-snapshot",
            daytonaSubmittedCodeSnapshot: "makeademo-submitted-code-browser",
            event: "clone-failure-diagnostics",
            caEnvPath_GIT_SSL_CAINFO: "/etc/openshell-tls/ca-bundle.pem",
            gitVersion: "git version 2.45.2",
            gitSslCAInfo:
              "file:/root/.gitconfig\t/etc/openshell-tls/ca-bundle.pem",
            openshellCaBundleExists: true,
            openshellCaBundlePath: "/etc/openshell-tls/ca-bundle.pem",
            openshellCaBundleReadable: true,
            openshellCaCertExists: true,
            openshellCaCertPath: "/etc/openshell-tls/openshell-ca.pem",
            openshellCaCertReadable: true,
            opensslVersion: "OpenSSL 3.3.1 4 Jun 2024",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
  });

  it("reports linked submitted-code clone failures with workspace context", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        submittedCodeCloneResult: {
          exitCode: 128,
          stderr:
            "fatal: unable to access 'https://github.com/example/app/': server certificate verification failed. CAfile: none CRLfile: none",
          stdout: "",
        },
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        expect.stringMatching(
          /Repo Preparation could not clone the submitted repository in the linked submitted-code workspace[\s\S]*server certificate verification failed/,
        ),
      ],
      status: "failed",
      suggestedChanges: [
        "Retry Repo Preparation after the submitted repository can be cloned from the Daytona workspace.",
      ],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        { network: false },
        { submittedCodeNetwork: true },
        { submittedCodeNetwork: false },
        { release: "daytona_workspace" },
      ]),
    );
  });

  it("writes linked submitted-code clone diagnostics before skipping Agent Task", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      cloneFailureDiagnosticsContext: {
        daytonaSnapshot: "makeademo-agent-snapshot",
        daytonaSubmittedCodeSnapshot: "makeademo-submitted-code-browser",
      },
      provider: fakeProvider(events, {
        cloneDiagnosticsStdout: [
          "caCertificatesCrtExists=true",
          "openshellCaBundleExists=false",
          "openshellCaBundleReadable=false",
          "openshellCaCertExists=true",
          "openshellCaCertReadable=false",
          `caEnvPath_SSL_CERT_FILE=/etc/openshell-tls/${"x".repeat(1_000)}`,
          "gitVersion=git version 2.45.2",
          `opensslVersion=OpenSSL 3.3.1 ${"x".repeat(1_000)}`,
        ].join("\n"),
        submittedCodeCloneResult: {
          exitCode: 128,
          stderr: "server certificate verification failed. CAfile: none",
          stdout: "",
        },
      }),
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        {
          submittedCodeExecute: expect.stringContaining(
            "makeademo_clone_diagnostics",
          ),
        },
        {
          sandboxLog: expect.objectContaining({
            caCertificatesCrtExists: true,
            caEnvPath_SSL_CERT_FILE: expect.stringContaining("truncated"),
            cloneFailureWorkspace: "linked submitted-code workspace",
            daytonaSubmittedCodeSnapshot: "makeademo-submitted-code-browser",
            event: "clone-failure-diagnostics",
            gitVersion: "git version 2.45.2",
            openshellCaBundleExists: false,
            openshellCaBundleReadable: false,
            openshellCaCertExists: true,
            openshellCaCertReadable: false,
            opensslVersion: expect.stringContaining("truncated"),
            stage: "repo-preparation",
          }),
        },
      ]),
    );
  });

  it("waits for clone-failure diagnostics to reach sandbox log sinks before releasing the workspace", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        cloneDiagnosticsStdout: "gitVersion=git version 2.45.2",
        cloneResults: [{ exitCode: 128, stderr: "clone failed", stdout: "" }],
        sandboxLogDelayMs: 10,
      }),
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    const diagnosticLogIndex = events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "sandboxLog" in event &&
        (event as { sandboxLog?: { event?: unknown } }).sandboxLog?.event ===
          "clone-failure-diagnostics",
    );
    const releaseIndex = events.findIndex(
      (event) =>
        typeof event === "object" && event !== null && "release" in event,
    );

    expect(diagnosticLogIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(diagnosticLogIndex);
  });

  it("redacts credentials and bounds clone failure output in blockers", async () => {
    const noisyOutput = "x".repeat(8_000);
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        cloneResults: [
          {
            exitCode: 128,
            stderr: `fatal: unable to access 'https://token:secret@github.com/example/app/?access_token=query-secret&password=pw-secret': authentication failed ${noisyOutput}`,
            stdout: `remote: https://oauth2:another-secret@gitlab.com/example/app?api_key=key-secret&client_secret=client-secret&safe=visible ${noisyOutput}`,
          },
        ],
      }),
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://token:secret@github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected clone failure");
    }
    const blocker = result.blockers[0] ?? "";
    expect(blocker).toContain(
      "https://***@github.com/example/app/?access_token=***&password=***",
    );
    expect(blocker).toContain(
      "https://***@gitlab.com/example/app?api_key=***&client_secret=***&safe=visible",
    );
    expect(blocker).not.toContain("token:secret");
    expect(blocker).not.toContain("another-secret");
    expect(blocker).not.toContain("query-secret");
    expect(blocker).not.toContain("pw-secret");
    expect(blocker).not.toContain("key-secret");
    expect(blocker).not.toContain("client-secret");
    expect(blocker.length).toBeLessThan(2_500);
    expect(blocker).toContain("truncated");
  });

  it("uses all validation-repair capacity after dependency installation", async () => {
    const events: unknown[] = [];
    const runner = new RecordingAgentTaskRunner();
    const validationFailures = Array.from({ length: 8 }, () => ({
      blockedNetworkAttempts: [],
      failureReason: "Preview requested https://api.example.test/articles.",
      logs: ["external runtime request blocked"],
      status: "failed" as const,
      warnings: ["network mock needed"],
    }));
    const validationResults = [
      ...validationFailures,
      validationArtifact().validation,
    ];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: [
          {
            exitCode: 0,
            handoff: {
              input: { command: "bun install" },
              toolName: "makeademo_dependency_request_install" as const,
            },
          },
          ...Array.from({ length: 9 }, () => ({
            exitCode: 0,
            handoff: {
              input: {
                manifestPath: "/workspace/.makeademo/preparation-manifest.json",
              },
              toolName: "makeademo_validate_preparation" as const,
            },
          })),
        ],
      }),
      runner,
      timeoutMs: 1_000,
      validatePreparation: async () =>
        validationResults.shift() ?? validationArtifact().validation,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(runner.calls).toHaveLength(10);
    expect(runner.calls.map((call) => call.attempt)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    const retries = events
      .filter(
        (
          event,
        ): event is {
          sandboxLog: { event: string; nextAttempt: number; reason?: string };
        } =>
          typeof event === "object" &&
          event !== null &&
          "sandboxLog" in event &&
          typeof (event as { sandboxLog?: unknown }).sandboxLog === "object" &&
          (event as { sandboxLog: { event?: unknown } }).sandboxLog.event ===
            "repo-preparation.retrying",
      )
      .map((event) => event.sandboxLog);
    expect(retries.map((entry) => entry.nextAttempt)).toEqual(
      Array.from({ length: 9 }, (_, index) => index + 2),
    );
    expect(retries[0]).toMatchObject({
      nextAttempt: 2,
      reason: "dependency-install-completed",
    });
    expect(
      retries
        .slice(1)
        .every(
          (entry) =>
            entry.reason ===
            "Preview requested https://api.example.test/articles.",
        ),
    ).toBe(true);
  });

  it("allows repeated meaningful turns but stops at the final retry boundary", async () => {
    const events: unknown[] = [];
    const runner = new RecordingAgentTaskRunner();
    const finalValidation = {
      blockedNetworkAttempts: [],
      evidence: {
        browser: {
          text: "The settings panel remains unavailable after the repair.",
        },
      },
      failureKind: "browser-not-interactable" as const,
      failureReason: "The settings panel is not interactable.",
      logs: ["Settings panel did not become interactable."],
      status: "failed" as const,
      warnings: ["Repair the settings panel interaction state."],
    };
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: Array.from({ length: 9 }, (_, index) => ({
          exitCode: 0,
          handoff: {
            input: {
              manifestPath: "/workspace/.makeademo/preparation-manifest.json",
            },
            toolName: "makeademo_validate_preparation" as const,
          },
          lastMeaningfulActivity: {
            at: index + 1,
            kind: "tool-call",
            tool: "makeademo_validate_preparation",
          },
        })),
      }),
      hardTimeoutMs: 1_800_000,
      runner,
      timeoutMs: 1_000,
      validatePreparation: async () => finalValidation,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["The settings panel is not interactable."],
      status: "failed",
      suggestedChanges: ["Repair the settings panel interaction state."],
      validation: finalValidation,
    });
    expect(runner.calls).toHaveLength(9);
    expect(new Set(runner.calls.map((call) => call.hardDeadlineAt)).size).toBe(
      1,
    );
    const retries = events
      .filter(
        (
          event,
        ): event is {
          sandboxLog: { event: string; level?: string; nextAttempt: number };
        } =>
          typeof event === "object" &&
          event !== null &&
          "sandboxLog" in event &&
          typeof (event as { sandboxLog?: unknown }).sandboxLog === "object" &&
          (event as { sandboxLog: { event?: unknown } }).sandboxLog.event ===
            "repo-preparation.retrying",
      )
      .map((event) => event.sandboxLog);
    expect(retries.map((entry) => entry.nextAttempt)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(retries.every((entry) => entry.level === "warn")).toBe(true);
    expect(
      events.filter(
        (
          event,
        ): event is { sandboxLog: { event?: unknown; level?: unknown } } =>
          typeof event === "object" &&
          event !== null &&
          "sandboxLog" in event &&
          typeof (event as { sandboxLog?: unknown }).sandboxLog === "object" &&
          (event as { sandboxLog: { event?: unknown } }).sandboxLog.event ===
            "preparation-preflight.finished" &&
          (event as { sandboxLog: { level?: unknown } }).sandboxLog.level ===
            "warn",
      ),
    ).toHaveLength(9);
  });

  it("stops repeated meaningful turns at the overall hard cap before another turn", async () => {
    const events: unknown[] = [];
    const runner = new RecordingAgentTaskRunner();
    const initialTime = Date.now();
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() =>
        runner.calls.length >= 3 ? initialTime + 1_001 : initialTime,
      );
    try {
      const agent = createRepoPreparationAgent({
        provider: fakeProvider(events, {
          agentResults: Array.from({ length: 16 }, (_, index) => ({
            exitCode: 0,
            handoff: {
              input: { command: "bun install" },
              toolName: "makeademo_dependency_request_install" as const,
            },
            lastMeaningfulActivity: {
              at: index + 1,
              kind: "stage-tool",
              tool: "makeademo_dependency_request_install",
            },
          })),
        }),
        hardTimeoutMs: 1_000,
        runner,
        timeoutMs: 10_000,
      });

      const result = await agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      });

      expect(result).toMatchObject({
        blockers: ["Repo Preparation exceeded its hard cap of 1000ms."],
        status: "failed",
      });
      expect(runner.calls).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([{ cancelActiveCommands: true }]),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stops dependency turns at the maximum task-turn boundary", async () => {
    const events: unknown[] = [];
    const runner = new RecordingAgentTaskRunner();
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: Array.from({ length: 16 }, () => ({
          exitCode: 0,
          handoff: {
            input: { command: "bun install" },
            toolName: "makeademo_dependency_request_install" as const,
          },
        })),
      }),
      hardTimeoutMs: 1_800_000,
      runner,
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        "Repo Preparation reached its total agent-task turn limit after dependency installation.",
      ],
      status: "failed",
    });
    expect(runner.calls).toHaveLength(16);
  });

  it("fails fast when preparation preflight cannot restore submitted-code files", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        failureKind: "submitted-code-workspace-sync-failed",
        failureReason:
          "Failed to sync prepared files to submitted-code workspace.",
        logs: ["Failed to sync prepared files to submitted-code workspace."],
        status: "failed",
        warnings: [],
      }),
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        expect.stringContaining(
          "non-retryable MakeADemo infrastructure failure",
        ),
      ],
      status: "failed",
    });
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
          }),
        },
      ]),
    );
  });

  it("does not accept a structured final result outside backend control state", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: [
          {
            exitCode: 0,
            handoff: {
              input: {
                manifestPath: "/workspace/.makeademo/preparation-manifest.json",
              },
              toolName: "makeademo_validate_preparation",
            },
          },
          {
            exitCode: 0,
            structuredOutput: {
              assumptions: [],
              blockers: ["Agent received validation feedback."],
              status: "failed",
              suggestedChanges: [],
            },
          },
        ],
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        failureReason:
          'Failed to restore prepared files in submitted-code sandbox (exit code 2). stderr: sh: 1: Syntax error: "(" unexpected',
        logs: [
          'Failed to restore prepared files in submitted-code sandbox (exit code 2). stderr: sh: 1: Syntax error: "(" unexpected',
        ],
        status: "failed",
        warnings: [],
      }),
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["Agent task failed."],
      status: "failed",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
            reason:
              'Failed to restore prepared files in submitted-code sandbox (exit code 2). stderr: sh: 1: Syntax error: "(" unexpected',
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-preflight.non-retryable-failure",
          }),
        },
      ]),
    );
  });

  it("reseals submitted-code network when dependency installation times out", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        dependencyInstallRequest: { command: "bun install" },
        submittedCodeNeverSettles: true,
      }),
      timeoutMs: 150,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(events).toEqual(
      expect.arrayContaining([
        { submittedCodeNetwork: true },
        {
          submittedProjectExecute: {
            argv: ["i", "--frozen-lockfile"],
            executable: "pnpm",
            nodeVersion: "22.23.1",
          },
        },
        { cancelActiveCommands: true },
        { submittedCodeNetwork: false },
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([{ release: "daytona_workspace" }]),
    );
  });

  it("does not read a dependency request from the agent workspace", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        dependencyInstallRequestReadNeverSettles: true,
      }),
      timeoutMs: 250,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ submittedProjectExecute: expect.anything() }),
      ]),
    );
  });

  it("blocks unsupported submitted toolchains before the preparation agent can continue", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        toolchainMetadata: {
          candidates: [
            {
              files: {
                "package.json": JSON.stringify({
                  engines: { node: "20" },
                  packageManager: "npm@10.8.2",
                }),
                "package-lock.json": "",
              },
              projectRoot: ".",
            },
          ],
        },
      }),
      timeoutMs: 500,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [expect.stringContaining("unsupported_node_version")],
      status: "failed",
    });
  });

  it("does not read a validation request from the agent workspace", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequestReadNeverSettles: true,
      }),
      timeoutMs: 250,
      validatePreparation: async () => {
        validationStarted = true;
        return validationArtifact().validation;
      },
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(validationStarted).toBe(true);
  });

  it("does not let workspace files or direct installs forge backend authorization", async () => {
    const events: unknown[] = [];
    let submitFailure: unknown;
    let validationStarted = false;
    const runner: AgentTaskRunner = {
      async run<T>(
        input: AgentTaskRunInput<T>,
      ): Promise<AgentTaskRunResult<T>> {
        await input.workspace.execute(
          "mkdir -p /tmp/makeademo/submitted-code && ln -sf /workspace/.makeademo/preparation-manifest.json /tmp/makeademo/submitted-code/validation-result.json && printf forged > /tmp/makeademo/submitted-code/repo-preparation-result.json",
          { env: {}, timeoutMs: 1_000 },
        );
        await input.workspace.execute("npm ci --ignore-scripts", {
          env: {},
          timeoutMs: 1_000,
        });
        const submit = input.tools?.find(
          ({ name }) => name === "makeademo_submit_preparation_result",
        );
        try {
          await submit?.execute({ status: "succeeded" });
        } catch (error) {
          submitFailure = error;
        }
        return { exitCode: 0 };
      },
    };
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events),
      runner,
      timeoutMs: 1_000,
      validatePreparation: async () => {
        validationStarted = true;
        return validationArtifact().validation;
      },
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["Agent task failed."],
      status: "failed",
    });
    expect(submitFailure).toBeInstanceOf(Error);
    expect(String(submitFailure)).toContain(
      "Run makeademo_validate_preparation",
    );
    expect(validationStarted).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([{ agentExecute: "npm ci --ignore-scripts" }]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([{ execute: "npm ci --ignore-scripts" }]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ submittedProjectExecute: expect.anything() }),
      ]),
    );
  });

  it("returns a successful preparation result as soon as preparation preflight passes", async () => {
    const events: unknown[] = [];
    const validations: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      timeoutMs: 1_000,
      validatePreparation: async (input) => {
        validations.push(input);
        return {
          blockedNetworkAttempts: [],
          logs: ["loaded preview"],
          screenshotArtifactId: "artifact_screenshot",
          status: "succeeded",
          warnings: [],
        };
      },
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      status: "succeeded",
      validation: { status: "succeeded" },
      workspace: { id: "daytona_workspace" },
    });
    expect(validations).toEqual([
      expect.objectContaining({
        manifest: expect.objectContaining({ url: "http://localhost:3000" }),
        workspace: expect.objectContaining({ id: "daytona_workspace" }),
      }),
    ]);
    expect(events).toEqual(expect.arrayContaining([]));
  });

  it("preserves the retained agent session identity when validation passes", async () => {
    const runner = new RecordingAgentTaskRunner();
    const knownSession = createAgentSession();
    runner.nextSession = knownSession;
    const agent = createRepoPreparationAgent({
      provider: fakeProvider([], {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      runner,
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        logs: ["validated"],
        status: "succeeded",
        warnings: [],
      }),
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    if (result.status !== "succeeded") {
      throw new Error("Expected Repo Preparation to succeed.");
    }
    if (!result.agentSession) {
      throw new Error("Expected Repo Preparation to return an Agent Session.");
    }
    expect(result.agentSession).toBe(knownSession);
    expect(
      runner.calls.slice(1).every((call) => call.session === knownSession),
    ).toBe(true);
  });

  it("returns malformed manifest handoff failures to the agent as preparation preflight feedback", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: [
          {
            exitCode: 0,
            handoff: {
              input: {
                manifestPath: "/workspace/.makeademo/preparation-manifest.json",
              },
              toolName: "makeademo_validate_preparation",
            },
          },
          {
            exitCode: 0,
            structuredOutput: {
              assumptions: [],
              blockers: ["Agent received validation feedback."],
              status: "failed",
              suggestedChanges: [],
            },
          },
        ],
        manifestPayload: { demoCommand: "npm run demo" },
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      timeoutMs: 1_000,
      validatePreparation: async () => {
        validationStarted = true;
        return validationArtifact().validation;
      },
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["Agent task failed."],
      status: "failed",
    });
    expect(validationStarted).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-preflight.finished",
            failureReason:
              "Preparation manifest handoff is invalid: status must be a non-empty string",
            stage: "repo-preparation",
            status: "failed",
          }),
        },
      ]),
    );
  });

  it("clones the submitted repo into the submitted-code workspace when available", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, [JSON.stringify(successResult())]),
      timeoutMs: 1_000,
    });

    await agent.prepare({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        {
          submittedCodeExecute: expect.stringContaining(
            "sudo mkdir -p '/workspace'",
          ),
        },
        {
          submittedCodeExecute: expect.stringContaining(
            "checkout --detach '0123456789abcdef0123456789abcdef01234567'",
          ),
        },
      ]),
    );
    const submittedCodeClone = events.find(
      (event): event is { submittedCodeExecute: string } =>
        typeof event === "object" &&
        event !== null &&
        "submittedCodeExecute" in event &&
        typeof event.submittedCodeExecute === "string" &&
        event.submittedCodeExecute.includes("git clone"),
    )?.submittedCodeExecute;
    expect(submittedCodeClone).toContain("/etc/ssl/certs/ca-certificates.crt");
    expect(submittedCodeClone).toContain(
      `test "$(git -C '/workspace' rev-parse HEAD)" = '0123456789abcdef0123456789abcdef01234567'`,
    );
    expect(submittedCodeClone).toContain("/etc/pki/tls/certs/ca-bundle.crt");
    expect(submittedCodeClone).toContain("/etc/openshell-tls/ca-bundle.pem");
    expect(submittedCodeClone).toMatch(/export GIT_SSL_CAINFO=.*git clone/s);
    expect(submittedCodeClone).not.toContain("GIT_SSL_NO_VERIFY");
    expect(submittedCodeClone).not.toContain("sslVerify=false");
    expect(events).toEqual(
      expect.arrayContaining([
        { submittedCodeNetwork: true },
        { submittedCodeNetwork: false },
      ]),
    );
  });

  it("writes Repo Preparation lifecycle events to the sandbox Pino log seam", async () => {
    const events: unknown[] = [];
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "agent-task.started",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-auto-succeeded-after-preflight",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        { execute: expect.stringContaining("repo-preparation-debug.jsonl") },
      ]),
    );
  });

  it("fails fast instead of starting preparation preflight when the preparation deadline is nearly exhausted", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = createRepoPreparationAgent({
      provider: fakeProvider(events, {
        agentResults: [
          {
            exitCode: -1,
            failure: {
              category: "timeout",
              message:
                "Repo Preparation ran out of time before preparation preflight could start.",
            },
          },
        ],
      }),
      timeoutMs: 1_000,
      validatePreparation: async () => {
        validationStarted = true;
        return validationArtifact().validation;
      },
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        "Repo Preparation ran out of time before preparation preflight could start.",
      ],
      status: "failed",
    });
    expect(validationStarted).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-timeout",
            hardTimeoutMs: 1_800_000,
            inactivityTimeoutMs: 1_000,
            timeoutKind: "inactivity",
          }),
        },
      ]),
    );
  });
});

function fakeProvider(
  events: unknown[],
  input:
    | string[]
    | {
        commandStdout?: string[];
        dependencyInstallRequestReadNeverSettles?: boolean;
        cloneDiagnosticsStdout?: string;
        captureCloneTimeouts?: boolean;
        cloneResults?: Array<PreparationWorkspaceCommandResult | Error>;
        dependencyInstallRequest?: { command: string };
        manifestPayload?: unknown;
        agentResults?: Array<
          AgentTaskRunResult<RepoPreparationToolHandoff> | Error
        >;
        preparationResult?: ReturnType<typeof successResult>;
        queuedSandboxLogWrites?: boolean;
        sandboxLogFailureEvent?: string;
        sandboxLogDelayMs?: number;
        sandboxLogNeverSettlesEvent?: string;
        submittedCodeCloneResult?: PreparationWorkspaceCommandResult;
        submittedCodeInstallResult?: PreparationWorkspaceCommandResult;
        submittedCodeNeverSettles?: boolean;
        submittedCodeInstallDelayMs?: number;
        validationRequest?: {
          manifestPath: string;
        };
        validationRequestReadNeverSettles?: boolean;
        validationResult?: ReturnType<typeof validationArtifact>;
        toolchainMetadata?: unknown;
      } = [JSON.stringify(successResult())],
): PreparationWorkspaceProvider {
  const workspaceInput = Array.isArray(input)
    ? { commandStdout: input }
    : input;

  return {
    async create() {
      const workspace = fakeWorkspace(events, workspaceInput);
      plannedAgentResultsByWorkspace.set(workspace, [
        ...(workspaceInput.agentResults ?? [
          workspaceInput.dependencyInstallRequest === undefined
            ? {
                exitCode: 0,
                handoff: {
                  input: {
                    manifestPath:
                      "/workspace/.makeademo/preparation-manifest.json",
                  },
                  toolName: "makeademo_validate_preparation" as const,
                },
              }
            : {
                exitCode: 0,
                handoff: {
                  input: workspaceInput.dependencyInstallRequest,
                  toolName: "makeademo_dependency_request_install" as const,
                },
              },
        ]),
      ]);
      return {
        async release() {
          events.push({ release: "daytona_workspace" });
        },
        id: "daytona_workspace",
        workspace,
      };
    },
  };
}

function fakeWorkspace(
  events: unknown[],
  input: {
    commandStdout?: string[];
    dependencyInstallRequestReadNeverSettles?: boolean;
    cloneDiagnosticsStdout?: string;
    captureCloneTimeouts?: boolean;
    cloneResults?: Array<PreparationWorkspaceCommandResult | Error>;
    dependencyInstallRequest?: { command: string };
    manifestPayload?: unknown;
    agentResults?: Array<
      AgentTaskRunResult<RepoPreparationToolHandoff> | Error
    >;
    preparationResult?: ReturnType<typeof successResult>;
    queuedSandboxLogWrites?: boolean;
    sandboxLogFailureEvent?: string;
    sandboxLogDelayMs?: number;
    sandboxLogNeverSettlesEvent?: string;
    submittedCodeCloneResult?: PreparationWorkspaceCommandResult;
    submittedCodeInstallResult?: PreparationWorkspaceCommandResult;
    submittedCodeNeverSettles?: boolean;
    submittedCodeInstallDelayMs?: number;
    validationRequest?: {
      manifestPath: string;
    };
    validationRequestReadNeverSettles?: boolean;
    validationResult?: ReturnType<typeof validationArtifact>;
    toolchainMetadata?: unknown;
  },
): PreparationWorkspace {
  const commandStdout = input.commandStdout ?? [
    JSON.stringify(successResult()),
  ];
  const cloneResults = [...(input.cloneResults ?? [])];
  let dependencyInstallRequest = input.dependencyInstallRequest;
  let sandboxLogChain = Promise.resolve();
  let validationRequest = input.validationRequest;
  let validationResult = input.validationResult;

  return {
    async executeAgentCommand(command) {
      events.push({ agentExecute: command });
      if (/\b(?:npm|pnpm|yarn|bun)\b/.test(command)) {
        return {
          exitCode: 126,
          stderr:
            "Package runtimes are unavailable in the parent agent workspace.",
          stdout: "",
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async prepareForAgent() {
      events.push({ prepareForAgent: true });
    },
    async execute(command, options) {
      if (command !== "git -C /workspace ls-files -z")
        events.push({ execute: command });
      if (
        command.includes("git clone") &&
        input.captureCloneTimeouts === true
      ) {
        events.push({ cloneTimeoutMs: options?.timeoutMs });
      }
      if (command === "makeademo-inspect-submitted-code-toolchain") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            input.toolchainMetadata ?? {
              candidates: [
                {
                  files: {
                    "package.json": JSON.stringify({
                      engines: { node: "22" },
                      packageManager: "pnpm@11.13.0",
                    }),
                    "pnpm-lock.yaml": "",
                  },
                  projectRoot: ".",
                },
              ],
            },
          ),
        };
      }
      if (command === "git -C /workspace ls-files -z") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "src/App.tsx\0src/styles.css\0",
        };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("dependency-install-request.json")
      ) {
        if (input.dependencyInstallRequestReadNeverSettles === true) {
          await new Promise(() => {});
        }
        return {
          exitCode: dependencyInstallRequest === undefined ? 1 : 0,
          stderr: "",
          stdout:
            dependencyInstallRequest === undefined
              ? ""
              : JSON.stringify(dependencyInstallRequest),
        };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("validation-request.json")
      ) {
        if (input.validationRequestReadNeverSettles === true) {
          await new Promise(() => {});
        }
        return {
          exitCode: validationRequest === undefined ? 1 : 0,
          stderr: "",
          stdout:
            validationRequest === undefined
              ? ""
              : JSON.stringify(validationRequest),
        };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("preparation-manifest.json")
      ) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            input.manifestPayload ?? successResult().manifest,
          ),
        };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("validation-result.json")
      ) {
        return {
          exitCode: validationResult === undefined ? 1 : 0,
          stderr: "",
          stdout:
            validationResult === undefined
              ? ""
              : JSON.stringify(validationResult),
        };
      }
      if (
        command.startsWith("mkdir -p") &&
        command.includes("validation-result.json")
      ) {
        const match = command.match(
          /MAKEADEMO_VALIDATION_RESULT\n([\s\S]*)\nMAKEADEMO_VALIDATION_RESULT/,
        );
        validationResult =
          match?.[1] === undefined
            ? validationArtifact()
            : JSON.parse(match[1]);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("repo-preparation-result.json")
      ) {
        return {
          exitCode: input.preparationResult === undefined ? 1 : 0,
          stderr: "",
          stdout:
            input.preparationResult === undefined
              ? ""
              : JSON.stringify(input.preparationResult),
        };
      }
      if (command.startsWith("rm -f")) {
        if (command.includes("dependency-install-request.json")) {
          dependencyInstallRequest = undefined;
        }
        if (command.includes("validation-request.json")) {
          validationRequest = undefined;
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command === "bun install") {
        throw new Error(
          "outer workspace execution must not install dependencies",
        );
      }
      if (command.includes("makeademo_clone_diagnostics")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: input.cloneDiagnosticsStdout ?? "",
        };
      }
      if (command.includes("git clone") && cloneResults.length > 0) {
        const cloneResult = cloneResults.shift();
        if (cloneResult instanceof Error) {
          throw cloneResult;
        }
        return cloneResult ?? { exitCode: 0, stderr: "", stdout: "cloned" };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: command.includes("git clone")
          ? "cloned"
          : (commandStdout.shift() ?? ""),
      };
    },
    async setOutboundNetworkAccess(enabled) {
      events.push({ network: enabled });
    },
    async executeSubmittedCode(command) {
      events.push({ submittedCodeExecute: command });
      if (command.includes("git clone")) {
        if (input.submittedCodeCloneResult !== undefined) {
          return input.submittedCodeCloneResult;
        }
        return { exitCode: 0, stderr: "", stdout: "cloned submitted" };
      }
      if (command.includes("makeademo_clone_diagnostics")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: input.cloneDiagnosticsStdout ?? "",
        };
      }
      if (command === "bun install") {
        if (input.submittedCodeNeverSettles === true) {
          await new Promise(() => {});
        }
        if (input.submittedCodeInstallDelayMs !== undefined) {
          await new Promise((resolve) =>
            setTimeout(resolve, input.submittedCodeInstallDelayMs),
          );
        }
        if (input.submittedCodeInstallResult !== undefined) {
          return input.submittedCodeInstallResult;
        }
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }
      throw new Error(`Unexpected submitted-code command: ${command}`);
    },
    async executeSubmittedProject(request: SubmittedProjectExecutionRequest) {
      events.push({
        submittedProjectExecute: {
          argv: [...request.argv],
          executable: request.executable,
          nodeVersion: request.plan.node.version,
        },
      });
      if (input.submittedCodeNeverSettles === true) {
        await new Promise(() => {});
      }
      if (input.submittedCodeInstallDelayMs !== undefined) {
        await new Promise((resolve) =>
          setTimeout(resolve, input.submittedCodeInstallDelayMs),
        );
      }
      if (input.submittedCodeInstallResult !== undefined) {
        return input.submittedCodeInstallResult;
      }
      return { exitCode: 0, stderr: "", stdout: "installed" };
    },
    async setSubmittedCodeNetworkAccess(enabled) {
      events.push({ submittedCodeNetwork: enabled });
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async cancelActiveCommands() {
      events.push({ cancelActiveCommands: true });
      events.push({ submittedCodeNetwork: false });
    },
    async uploadFiles() {
      throw new Error("Repo Preparation should clone inside Daytona.");
    },
    writeSandboxLog(entry) {
      const write = async () => {
        if (input.sandboxLogDelayMs !== undefined) {
          await new Promise((resolve) =>
            setTimeout(resolve, input.sandboxLogDelayMs),
          );
        }
        events.push({ sandboxLog: entry });
        if (entry.event === input.sandboxLogNeverSettlesEvent) {
          await new Promise(() => {});
        }
        if (entry.event === input.sandboxLogFailureEvent) {
          throw new Error("sandbox log sink failed");
        }
      };
      if (input.queuedSandboxLogWrites !== true) {
        return write();
      }

      sandboxLogChain = sandboxLogChain.then(write, write);
      return sandboxLogChain;
    },
  };
}

function supportedPnpmMetadata(): unknown {
  return {
    candidates: [
      {
        files: {
          "package.json": JSON.stringify({
            engines: { node: "22" },
            packageManager: "pnpm@11.13.0",
          }),
          "pnpm-lock.yaml": "",
        },
        projectRoot: ".",
      },
    ],
  };
}

function providerInvalidApiKeyFailure(
  receivedCredential: string,
): AgentTaskRunResult {
  return {
    exitCode: 1,
    failure: {
      category: "provider-auth-invalid",
      message: `Provider rejected the configured API key (${receivedCredential}).`,
    },
  };
}

function isReleaseEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && "release" in event;
}

function validationArtifact() {
  return {
    manifest: successResult().manifest,
    status: "succeeded",
    validation: {
      blockedNetworkAttempts: [],
      logs: ["validated"],
      status: "succeeded" as const,
      warnings: [],
    },
  };
}

function successResult() {
  return {
    manifest: {
      assumptions: [],
      createdFiles: [],
      demoCommand: "npm run demo:makeademo",
      diffArtifactId: "artifact_diff",
      existingDemoEvidence: [],
      mockedServices: [],
      modifiedFiles: [],
      nativeVisibleInterface: {
        nativeStartupAttempts: ["npm run demo:makeademo"],
        sourceControlledUiPaths: ["src/App.tsx", "src/styles.css"],
      },
      repoUrl: "https://github.com/example/app",
      risks: [],
      scriptGenerationContext: [],
      setupSummary: "Prepared demo runtime.",
      status: "created-new-demo",
      url: "http://localhost:3000",
      workspaceId: "workspace_123",
    },
    status: "succeeded",
  };
}
