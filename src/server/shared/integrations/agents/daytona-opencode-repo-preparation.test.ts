import { describe, expect, it, vi } from "vitest";

import type { PreparationWorkspaceProvider } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  SubmittedProjectExecutionRequest,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { createPipelineEventLogger } from "../../logging/pipeline-event-logger";
import { DaytonaOpenCodeRepoPreparation } from "./daytona-opencode-repo-preparation";

describe("DaytonaOpenCodeRepoPreparation", () => {
  it("clones the submitted repo and runs OpenCode inside Daytona", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
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
          execute: expect.stringContaining("sudo mkdir -p '/workspace'"),
        },
        {
          execute: expect.stringContaining(
            "checkout --detach '0123456789abcdef0123456789abcdef01234567'",
          ),
        },
        { network: false },
        {
          execute: expect.stringContaining("plugins/makeademo-tools.ts"),
        },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/dependency-install-request.json",
          ),
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/repo-preparation-result.json",
          ),
        },
      ]),
    );
    expect(streamed).toEqual(["stdout:opencode output"]);

    const command = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(command).not.toContain("OPENCODE_ENABLE_EXA");
    expect(command).not.toContain("OPENAI_API_KEY");
    expect(command).toContain("opencode run");
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).toContain("--dir /workspace");
    expect(command).toContain("--model 'openai/gpt-5.5'");
    const configIndex = events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("plugins/makeademo-tools.ts"),
    );
    const openCodeIndex = events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    );
    expect(openCodeIndex).toBeGreaterThan(configIndex);
    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("dotenv"),
      ),
    ).toBe(false);

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
  });

  it("continues Repo Preparation when streamed OpenCode activity log writes fail", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      provider: fakeProvider(events, {
        commandStderrChunks: ["agent warning"],
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["agent output"],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "opencode.stderr",
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
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
    });
    expect(streamed).toEqual(["stdout:agent output", "stderr:agent warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("continues Repo Preparation when streamed OpenCode activity log writes never settle", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStderrChunks: ["agent warning"],
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["agent output"],
        preparationResult: successResult(),
        sandboxLogNeverSettlesEvent: "opencode.stderr",
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
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

  it("continues Repo Preparation when sandbox progress logging fails", async () => {
    const events: unknown[] = [];
    const pipelineLogs: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new DaytonaOpenCodeRepoPreparation({
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
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "workspace-created",
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
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
    const agent = new DaytonaOpenCodeRepoPreparation({
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
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "workspace-created",
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
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

  it("retries transient Daytona clone connection failures before starting OpenCode", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
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
      providerID: "openai",
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
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        { network: false },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("retries Daytona socket-closed clone failures before starting OpenCode", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
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
      providerID: "openai",
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
    expect(events).toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("does not retry OpenCode execution errors from the Repo Preparation agent", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        openCodeStartupErrors: [new Error("PTY connection timeout")],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
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
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(1);
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "opencode-pty-connection-retrying",
          }),
        },
      ]),
    );
  });

  it("retries once in a fresh workspace when OpenCode receives a Daytona secret reference", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProviderSequence(events, [
        {
          openCodeResults: [providerSecretReferenceAuthFailure()],
        },
        {
          commandStdout: ["Submitted preparation result."],
          preparationResult: successResult(),
          validationResult: validationArtifact(),
        },
      ]),
      providerID: "openai",
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
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(2);
    expect(events.filter(isReleaseEvent)).toHaveLength(1);
    expect(events.filter(isCancelActiveCommandsEvent)).toHaveLength(1);
    const firstCancelIndex = events.findIndex(isCancelActiveCommandsEvent);
    const firstReleaseIndex = events.findIndex(isReleaseEvent);
    const retryCreateIndex = events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "create" in event &&
        event.create === 2,
    );
    expect(firstCancelIndex).toBeLessThan(firstReleaseIndex);
    expect(firstReleaseIndex).toBeLessThan(retryCreateIndex);
  });

  it("returns the provider-auth blocker when the fresh-workspace retry also fails", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProviderSequence(events, [
        { openCodeResults: [providerSecretReferenceAuthFailure()] },
        { openCodeResults: [providerSecretReferenceAuthFailure()] },
      ]),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toEqual({
      assumptions: [],
      blockers: [
        "OpenCode provider authentication failed because Daytona supplied a secret reference instead of the provider API key.",
      ],
      status: "failed",
      suggestedChanges: [
        "Retry Repo Preparation after verifying the Daytona provider secret injection.",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("dtn_secr");
    expect(JSON.stringify(result)).not.toContain("invalid JSON");
    expect(events.filter(isReleaseEvent)).toHaveLength(2);
    expect(events.filter(isCancelActiveCommandsEvent)).toHaveLength(2);
  });

  it("does not retry a generic nonzero OpenCode result without a handoff artifact", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProviderSequence(events, [
        {
          openCodeResults: [
            { exitCode: 1, stderr: "agent failed", stdout: "not JSON" },
          ],
        },
      ]),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["OpenCode did not return valid preparation JSON."],
      status: "failed",
    });
    expect(events.filter(isReleaseEvent)).toHaveLength(1);
  });

  it("does not retry an invalid provider key that is not a Daytona secret reference", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProviderSequence(events, [
        {
          openCodeResults: [
            providerInvalidApiKeyFailure("sk-proj-********test"),
          ],
        },
      ]),
      providerID: "openai",
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
        "OpenCode provider authentication failed because the provider rejected the configured API key.",
      ],
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("sk-proj");
    expect(events.filter(isReleaseEvent)).toHaveLength(1);
  });

  it("reports pre-OpenCode git clone failures as Repo Preparation clone blockers", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
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
      providerID: "openai",
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
          /^(?!.*OpenCode exited)[\s\S]*Repo Preparation could not clone the submitted repository in the parent OpenCode workspace[\s\S]*server certificate verification failed/,
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
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("writes bounded CA and tool diagnostics when the pre-OpenCode clone fails", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      cloneFailureDiagnosticsContext: {
        daytonaSnapshot: "makeademo-opencode",
        daytonaSubmittedCodeSnapshot: "makeademo-submitted-code-browser",
      },
      modelID: "gpt-5.5",
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
      providerID: "openai",
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
            daytonaSnapshot: "makeademo-opencode",
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
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("reports linked submitted-code clone failures with workspace context", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        submittedCodeCloneResult: {
          exitCode: 128,
          stderr:
            "fatal: unable to access 'https://github.com/example/app/': server certificate verification failed. CAfile: none CRLfile: none",
          stdout: "",
        },
      }),
      providerID: "openai",
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
          /^(?!.*OpenCode exited)[\s\S]*Repo Preparation could not clone the submitted repository in the linked submitted-code workspace[\s\S]*server certificate verification failed/,
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
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("writes linked submitted-code clone diagnostics before skipping OpenCode", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      cloneFailureDiagnosticsContext: {
        daytonaSnapshot: "makeademo-opencode",
        daytonaSubmittedCodeSnapshot: "makeademo-submitted-code-browser",
      },
      modelID: "gpt-5.5",
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
      providerID: "openai",
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
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("waits for clone-failure diagnostics to reach sandbox log sinks before releasing the workspace", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        cloneDiagnosticsStdout: "gitVersion=git version 2.45.2",
        cloneResults: [{ exitCode: 128, stderr: "clone failed", stdout: "" }],
        sandboxLogDelayMs: 10,
      }),
      providerID: "openai",
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
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        cloneResults: [
          {
            exitCode: 128,
            stderr: `fatal: unable to access 'https://token:secret@github.com/example/app/?access_token=query-secret&password=pw-secret': authentication failed ${noisyOutput}`,
            stdout: `remote: https://oauth2:another-secret@gitlab.com/example/app?api_key=key-secret&client_secret=client-secret&safe=visible ${noisyOutput}`,
          },
        ],
      }),
      providerID: "openai",
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

  it("handles custom tool dependency install requests in the retained Daytona workspace", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
          "Submitted preparation result.",
        ],
        dependencyInstallRequest: { command: "bun install" },
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      opencodeSessionID: "session_123",
      status: "succeeded",
      workspace: { id: "daytona_workspace" },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        {
          execute: expect.stringContaining("sudo mkdir -p '/workspace'"),
        },
        {
          execute: expect.stringContaining(
            "git clone --depth 1 'https://github.com/example/app' '/workspace'",
          ),
        },
        { network: false },
        {
          execute: expect.stringContaining("plugins/makeademo-tools.ts"),
        },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/dependency-install-request.json",
          ),
        },
        { submittedCodeNetwork: true },
        {
          submittedProjectExecute: {
            argv: ["i", "--frozen-lockfile"],
            executable: "pnpm",
            nodeVersion: "22.23.1",
          },
        },
        { submittedCodeNetwork: false },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/dependency-install-request.json",
          ),
        },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/repo-preparation-result.json",
          ),
        },
      ]),
    );
    const openCodeCommands = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      )
      .map((event) => event.execute);
    expect(openCodeCommands).toHaveLength(2);
    expect(openCodeCommands[0]).not.toContain("--session");
    expect(openCodeCommands[1]).toContain("--session 'session_123'");
  });

  it("gives each OpenCode pass a fresh timeout budget across dependency installation", async () => {
    const events: unknown[] = [];
    const timeoutMs = 250;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandDelayMsByRun: [110, 110],
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
          "Validation requested.",
        ],
        dependencyInstallRequest: { command: "bun install" },
        preparationResult: successResult(),
        submittedCodeInstallDelayMs: 110,
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs,
      validatePreparation: async () => validationArtifact().validation,
    });

    const startedAt = Date.now();
    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(Date.now() - startedAt).toBeGreaterThan(timeoutMs);
    const startedEvents = events.filter(
      (
        event,
      ): event is { sandboxLog: { event?: unknown; remainingMs?: unknown } } =>
        typeof event === "object" &&
        event !== null &&
        "sandboxLog" in event &&
        typeof (event as { sandboxLog?: unknown }).sandboxLog === "object" &&
        (event as { sandboxLog?: { event?: unknown } }).sandboxLog?.event ===
          "opencode-started",
    );
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[1]?.sandboxLog.remainingMs).toBeGreaterThan(200);
  });

  it("tells OpenCode successful dependency installs ran in submitted-code before retrying preparation", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
          "Submitted preparation result.",
        ],
        dependencyInstallRequest: { command: "bun install" },
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "dependency-install-finished",
            exitCode: 0,
            stderrLength: 0,
            stdoutLength: 9,
            stage: "repo-preparation",
          }),
        },
      ]),
    );

    const resumedOpenCodeCommand = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      )
      .map((event) => event.execute)[1];
    expect(resumedOpenCodeCommand).toContain(
      "Dependency install ran in the submitted-code sandbox",
    );
    expect(resumedOpenCodeCommand).toContain(
      "parent OpenCode `/workspace` may not contain `node_modules`",
    );
    expect(resumedOpenCodeCommand).toContain(
      "Validate readiness by writing the Preparation Manifest and calling MakeADemo preparation preflight",
    );
  });

  it("returns failed dependency installation output to OpenCode before retrying preparation", async () => {
    const events: unknown[] = [];
    const installStderr = `${"stderr-start ".repeat(200)}missing package left-pad`;
    const installStdout = `${"stdout-start ".repeat(200)}resolved 9 packages`;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
          JSON.stringify({
            assumptions: [],
            blockers: ["Agent received dependency failure feedback."],
            status: "failed",
            suggestedChanges: [],
          }),
        ],
        dependencyInstallRequest: { command: "bun install" },
        submittedCodeInstallResult: {
          exitCode: 42,
          stderr: installStderr,
          stdout: installStdout,
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["Agent received dependency failure feedback."],
      status: "failed",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "dependency-install-finished",
            exitCode: 42,
            stderrLength: installStderr.length,
            stdoutLength: installStdout.length,
            stage: "repo-preparation",
          }),
        },
      ]),
    );

    const resumedOpenCodeCommand = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      )
      .map((event) => event.execute)[1];
    expect(resumedOpenCodeCommand).toContain("Dependency installation failed");
    expect(resumedOpenCodeCommand).toContain("exit code 42");
    expect(resumedOpenCodeCommand).toContain("resolved 9 packages");
    expect(resumedOpenCodeCommand).toContain("missing package left-pad");
    expect(resumedOpenCodeCommand).not.toContain(
      "Backend-controlled dependency installation has completed",
    );
  });

  it("logs Repo Preparation retries with the reason before resuming OpenCode", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
          JSON.stringify({
            assumptions: [],
            blockers: ["Agent received validation feedback."],
            status: "failed",
            suggestedChanges: [],
          }),
        ],
        dependencyInstallRequest: { command: "bun install" },
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        failureReason: "Preview requested https://api.example.test/articles.",
        logs: ["external runtime request blocked"],
        status: "failed",
        warnings: ["network mock needed"],
      }),
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
        {
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
            nextAttempt: 2,
            reason: "dependency-install-completed",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
            nextAttempt: 3,
            reason: "Preview requested https://api.example.test/articles.",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
  });

  it("reserves validation repairs after a successful dependency install handoff", async () => {
    const events: unknown[] = [];
    const validationFailures = [
      "Initial validation failure.",
      "Second validation failure.",
      "Third validation failure.",
      "Fourth validation failure.",
      "Fifth validation failure.",
      "Sixth validation failure.",
      "Final actionable validation failure.",
    ];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandOutputChunksByRun: [
          [
            {
              channel: "stdout",
              chunk: `${JSON.stringify({
                args: { command: "bun install" },
                toolName: "makeademo_dependency_request_install",
                type: "tool-call",
              })}\n`,
            },
          ],
          ...validationFailures.map(() => [
            {
              channel: "stdout" as const,
              chunk: `${JSON.stringify({
                input: {
                  manifestPath:
                    "/tmp/makeademo/submitted-code/preparation-manifest.json",
                },
                toolName: "makeademo_validate_preparation",
                type: "tool-call",
              })}\n`,
            },
          ]),
          [
            {
              channel: "stdout",
              chunk: `${JSON.stringify({
                input: {
                  manifestPath:
                    "/tmp/makeademo/submitted-code/preparation-manifest.json",
                },
                toolName: "makeademo_validate_preparation",
                type: "tool-call",
              })}\n`,
            },
          ],
        ],
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => {
        const failureReason = validationFailures.shift();
        return failureReason === undefined
          ? validationArtifact().validation
          : {
              blockedNetworkAttempts: [],
              evidence: {
                browser: {
                  text: "The repair target is visible in the browser.",
                },
              },
              failureKind: "browser-not-interactable" as const,
              failureReason,
              logs: [failureReason],
              status: "failed" as const,
              warnings: ["Repair the observed browser state."],
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
      status: "succeeded",
      validation: { status: "succeeded" },
    });
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
    expect(retries).toHaveLength(8);
    expect(retries.map((entry) => entry.nextAttempt)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(retries.every((entry) => entry.level === "warn")).toBe(true);
    expect(
      events.filter(
        (event): event is { sandboxLog: { event?: unknown } } =>
          typeof event === "object" &&
          event !== null &&
          "sandboxLog" in event &&
          typeof (event as { sandboxLog?: unknown }).sandboxLog === "object" &&
          (event as { sandboxLog: { event?: unknown } }).sandboxLog.event ===
            "opencode-started",
      ),
    ).toHaveLength(9);
  });

  it("returns the final typed validation verdict without logging an impossible repair", async () => {
    const events: unknown[] = [];
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
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandOutputChunksByRun: Array.from({ length: 9 }, () => [
          {
            channel: "stdout" as const,
            chunk: `${JSON.stringify({
              input: {
                manifestPath:
                  "/tmp/makeademo/submitted-code/preparation-manifest.json",
              },
              toolName: "makeademo_validate_preparation",
              type: "tool-call",
            })}\n`,
          },
        ]),
      }),
      providerID: "openai",
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

  it("does not log a retry after the total OpenCode safety bound", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandOutputChunksByRun: Array.from({ length: 16 }, () => [
          {
            channel: "stdout" as const,
            chunk: `${JSON.stringify({
              args: { command: "bun install" },
              toolName: "makeademo_dependency_request_install",
              type: "tool-call",
            })}\n`,
          },
        ]),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    const retries = events
      .filter(
        (
          event,
        ): event is { sandboxLog: { event: string; nextAttempt: number } } =>
          typeof event === "object" &&
          event !== null &&
          "sandboxLog" in event &&
          typeof (event as { sandboxLog?: unknown }).sandboxLog === "object" &&
          (event as { sandboxLog: { event?: unknown } }).sandboxLog.event ===
            "repo-preparation.retrying",
      )
      .map((event) => event.sandboxLog.nextAttempt);
    expect(retries).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });

  it("tells OpenCode to repair only observed runtime network requests before rerunning preflight", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          "Validation requested.",
          JSON.stringify({
            assumptions: [],
            blockers: ["Agent received validation feedback."],
            status: "failed",
            suggestedChanges: [],
          }),
        ],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [
          {
            direction: "outbound",
            host: "code.ionicframework.com",
            phase: "runtime",
            url: "https://code.ionicframework.com/ionicons/ionicons.esm.js",
          },
          {
            direction: "outbound",
            host: "fonts.googleapis.com",
            phase: "runtime",
            url: "https://fonts.googleapis.com/css?family=Inter",
          },
        ],
        failureReason: "Runtime network requests were blocked.",
        logs: ["external runtime request blocked"],
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

    expect(result).toMatchObject({ status: "failed" });
    const validationFeedbackCommand = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      )
      .map((event) => event.execute)[1];
    expect(validationFeedbackCommand).toContain(
      "repair only the observed runtime network requests listed in `blockedNetworkAttempts`",
    );
    expect(validationFeedbackCommand).toContain(
      "Remaining Repo Preparation budget:",
    );
    expect(validationFeedbackCommand).toContain(
      "Patch those listed runtime requests first",
    );
    expect(validationFeedbackCommand).toContain(
      "Ignore package metadata URLs, lockfile URLs, and ordinary external anchor links unless the demo actually clicks or navigates to those links",
    );
    expect(validationFeedbackCommand).toContain(
      "After removing or replacing the listed runtime requests, rerun `makeademo_validate_preparation` promptly",
    );
  });

  it("fails fast when preparation preflight cannot restore submitted-code files", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
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
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(1);
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

  it("retries preparation preflight feedback when restore-looking text has no failure kind", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          "Validation requested.",
          JSON.stringify({
            assumptions: [],
            blockers: ["Agent received validation feedback."],
            status: "failed",
            suggestedChanges: [],
          }),
        ],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
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
      blockers: ["Agent received validation feedback."],
      status: "failed",
    });
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(2);
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
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
        ],
        dependencyInstallRequest: { command: "bun install" },
        submittedCodeNeverSettles: true,
      }),
      providerID: "openai",
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

  it("fails dependency install handoff when reading the request artifact times out", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
        ],
        dependencyInstallRequestReadNeverSettles: true,
      }),
      providerID: "openai",
      timeoutMs: 250,
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
          "Repo Preparation timed out reading the dependency install request artifact",
        ),
      ],
      status: "failed",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "dependency-install-request-read.started",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "dependency-install-request-read.timeout",
            stage: "repo-preparation",
          }),
        },
        { release: "daytona_workspace" },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ submittedProjectExecute: expect.anything() }),
      ]),
    );
  });

  it("reads validation handoff first after OpenCode calls the validation tool", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Tool call: makeademo_validate_preparation"],
        dependencyInstallRequestReadNeverSettles: true,
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
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

    expect(result).toMatchObject({
      status: "succeeded",
      validation: { status: "succeeded" },
    });
    expect(validationStarted).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "validation-request-read.started",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "dependency-install-request-read.timeout",
          }),
        },
      ]),
    );
  });

  it("cancels a still-running OpenCode command after a completed validation tool event", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandOutputChunks: [
          {
            channel: "stdout",
            chunk: `${JSON.stringify({
              part: {
                state: {
                  input: {
                    manifestPath:
                      "/tmp/makeademo/submitted-code/preparation-manifest.json",
                  },
                  status: "completed",
                },
                tool: "makeademo_validate_preparation",
              },
              type: "tool_use",
            })}\n`,
          },
        ],
        openCodeWaitsForCancellation: true,
        validationRequestReadNeverSettles: true,
      }),
      providerID: "openai",
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

    expect(result).toMatchObject({
      status: "succeeded",
      validation: { status: "succeeded" },
    });
    expect(validationStarted).toBe(true);
    expect(
      events.filter(
        (event) => event instanceof Object && "cancelActiveCommands" in event,
      ),
    ).toHaveLength(1);
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "validation-request-read.started",
          }),
        },
      ]),
    );
  });

  it("runs dependency install from streamed structured tool input when the dependency artifact read never settles", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandOutputChunksByRun: [
          [
            {
              channel: "stderr",
              chunk: `${JSON.stringify({
                input: { manifestPath: "/tmp/old-manifest.json" },
                toolName: "makeademo_validate_preparation",
                type: "tool-call",
              })}\n`,
            },
            {
              channel: "stdout",
              chunk: `${JSON.stringify({
                args: { command: "bun install" },
                toolName: "makeademo_dependency_request_install",
                type: "tool-call",
              })}\n`,
            },
          ],
          [
            {
              channel: "stdout",
              chunk: `${JSON.stringify({
                input: {
                  manifestPath:
                    "/tmp/makeademo/submitted-code/preparation-manifest.json",
                },
                toolName: "makeademo_validate_preparation",
                type: "tool-call",
              })}\n`,
            },
          ],
        ],
        dependencyInstallRequestReadNeverSettles: true,
      }),
      providerID: "openai",
      timeoutMs: 500,
      validatePreparation: async () => validationArtifact().validation,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          submittedProjectExecute: {
            argv: ["i", "--frozen-lockfile"],
            executable: "pnpm",
            nodeVersion: "22.23.1",
          },
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "dependency-install-request-read.started",
          }),
        },
      ]),
    );
  });

  it("executes the catalog install instead of agent-selected argv", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandOutputChunksByRun: [
          [
            {
              channel: "stdout",
              chunk: `${JSON.stringify({
                args: { command: "pnpm install --no-frozen-lockfile" },
                toolName: "makeademo_dependency_request_install",
                type: "tool-call",
              })}\n`,
            },
          ],
          [
            {
              channel: "stdout",
              chunk: `${JSON.stringify({
                input: {
                  manifestPath:
                    "/tmp/makeademo/submitted-code/preparation-manifest.json",
                },
                toolName: "makeademo_validate_preparation",
                type: "tool-call",
              })}\n`,
            },
          ],
        ],
        toolchainMetadata: supportedPnpmMetadata(),
      }),
      providerID: "openai",
      timeoutMs: 500,
      validatePreparation: async () => validationArtifact().validation,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(events).toContainEqual({
      submittedProjectExecute: {
        argv: ["i", "--frozen-lockfile"],
        executable: "pnpm",
        nodeVersion: "22.23.1",
      },
    });
    expect(events).not.toContainEqual({
      submittedCodeExecute: "pnpm install --no-frozen-lockfile",
    });
  });

  it("blocks unsupported submitted toolchains before the preparation agent can continue", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
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
      providerID: "openai",
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
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
  });

  it("still rejects a non-allowlisted agent install request when a catalog plan exists", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandOutputChunks: [
          {
            channel: "stdout",
            chunk: `${JSON.stringify({
              args: { command: "pnpm install && curl example.test" },
              toolName: "makeademo_dependency_request_install",
              type: "tool-call",
            })}\n`,
          },
        ],
        toolchainMetadata: supportedPnpmMetadata(),
      }),
      providerID: "openai",
      timeoutMs: 500,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ submittedProjectExecute: expect.anything() }),
      ]),
    );
  });

  it("fails preparation preflight handoff when reading the validation request artifact times out", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequestReadNeverSettles: true,
      }),
      providerID: "openai",
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

    expect(result).toMatchObject({
      blockers: [
        expect.stringContaining(
          "Repo Preparation timed out reading the validation request artifact",
        ),
      ],
      status: "failed",
    });
    expect(validationStarted).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "validation-request-read.started",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "validation-request-read.timeout",
            stage: "repo-preparation",
          }),
        },
        { release: "daytona_workspace" },
      ]),
    );
  });

  it("returns a successful preparation result as soon as preparation preflight passes", async () => {
    const events: unknown[] = [];
    const validations: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
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
    expect(events).toEqual(
      expect.arrayContaining([
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/validation-request.json",
          ),
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/validation-result.json",
          ),
        },
      ]),
    );
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(1);
  });

  it("preserves the OpenCode session ID from streamed output when validation passes", async () => {
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider([], {
        commandStdout: ["Validation requested."],
        commandStdoutChunks: [
          `${JSON.stringify({ sessionID: "session_streamed_123", type: "step_start" })}\n`,
        ],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
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

    expect(result).toMatchObject({
      opencodeSessionID: "session_streamed_123",
      status: "succeeded",
    });
  });

  it("returns malformed manifest handoff failures to the agent as preparation preflight feedback", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          "Validation requested.",
          JSON.stringify({
            assumptions: [],
            blockers: ["Agent received validation feedback."],
            status: "failed",
            suggestedChanges: [],
          }),
        ],
        manifestPayload: { demoCommand: "npm run demo" },
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
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
      blockers: ["Agent received validation feedback."],
      status: "failed",
    });
    expect(validationStarted).toBe(false);
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(2);
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
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, [JSON.stringify(successResult())]),
      providerID: "openai",
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
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
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
            event: "opencode-started",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-result-found",
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

  it("mirrors bounded streamed OpenCode stderr into the sandbox Pino log seam", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      provider: fakeProvider(events, {
        commandStderrChunks: ["agent warning"],
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["agent output"],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(streamed).toEqual(["stdout:agent output", "stderr:agent warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            channel: "stderr",
            event: "opencode.stderr",
            message: "agent warning",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        { execute: expect.stringContaining("opencode-activity.jsonl") },
        { execute: expect.stringContaining("opencode-attempt-1.stdout.log") },
        { execute: expect.stringContaining("opencode-attempt-1.stderr.log") },
      ]),
    );
  });

  it("filters terminal-control-only OpenCode chunks out of the sandbox Pino log seam", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStderrChunks: ["\r"],
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["\r\r", "\u001b[?25h", ">"],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(events).not.toEqual(
      expect.arrayContaining([
        { sandboxLog: expect.objectContaining({ raw: "\r\r" }) },
        { sandboxLog: expect.objectContaining({ raw: "\u001b[?25h" }) },
        { sandboxLog: expect.objectContaining({ raw: ">" }) },
        { sandboxLog: expect.objectContaining({ raw: "\r" }) },
      ]),
    );
  });

  it("fails fast instead of starting preparation preflight when the preparation deadline is nearly exhausted", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandDelayMs: 920,
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
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
  });

  it("stops repeated OpenCode passes at the overall hard cap", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandDelayMs: 200,
        commandStdout: ["not structured preparation output"],
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      hardTimeoutMs: 150,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["Repo Preparation exceeded its hard cap of 150ms."],
      status: "failed",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-timeout",
            hardTimeoutMs: 150,
            timeoutKind: "hard-cap",
          }),
        },
      ]),
    );
  });

  it("does not extend inactivity for periodic step_start heartbeats", async () => {
    vi.useFakeTimers();
    try {
      const events: unknown[] = [];
      const agent = new DaytonaOpenCodeRepoPreparation({
        modelID: "gpt-5.5",
        provider: fakeProvider(events, {
          commandOutputScheduleByRun: [
            [
              {
                afterMs: 40,
                channel: "stdout",
                chunk: '{"type":"step_start"}\n',
              },
              {
                afterMs: 40,
                channel: "stdout",
                chunk: '{"type":"step_start"}\n',
              },
              {
                afterMs: 40,
                channel: "stdout",
                chunk: '{"type":"step_start"}\n',
              },
            ],
          ],
          openCodeWaitsForCancellation: true,
        }),
        providerID: "openai",
        timeoutMs: 100,
        hardTimeoutMs: 1_000,
      });
      const pending = agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      });
      await vi.advanceTimersByTimeAsync(130);
      await expect(pending).resolves.toMatchObject({
        blockers: [
          "Repo Preparation agent timed out after 100ms of inactivity.",
        ],
        status: "failed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends inactivity for structured text and accepts validation after the original deadline", async () => {
    vi.useFakeTimers();
    try {
      const events: unknown[] = [];
      const agent = new DaytonaOpenCodeRepoPreparation({
        modelID: "gpt-5.5",
        provider: fakeProvider(events, {
          commandOutputScheduleByRun: [
            [
              {
                afterMs: 80,
                channel: "stdout",
                chunk: '{"type":"text","part":{"text":"working"}}\n',
              },
              {
                afterMs: 50,
                channel: "stdout",
                chunk: `${JSON.stringify({
                  input: {
                    manifestPath:
                      "/tmp/makeademo/submitted-code/preparation-manifest.json",
                  },
                  state: { status: "completed" },
                  toolName: "makeademo_validate_preparation",
                })}\n`,
              },
            ],
          ],
          openCodeWaitsForCancellation: true,
          validationResult: validationArtifact(),
        }),
        providerID: "openai",
        timeoutMs: 100,
        hardTimeoutMs: 1_000,
        validatePreparation: async () => validationArtifact().validation,
      });
      const pending = agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      });
      await vi.advanceTimersByTimeAsync(130);
      await expect(pending).resolves.toMatchObject({ status: "succeeded" });
      expect(events).toEqual(
        expect.arrayContaining([{ cancelActiveCommands: true }]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a periodically meaningful OpenCode run at the hard cap", async () => {
    vi.useFakeTimers();
    try {
      const events: unknown[] = [];
      const agent = new DaytonaOpenCodeRepoPreparation({
        modelID: "gpt-5.5",
        provider: fakeProvider(events, {
          commandOutputScheduleByRun: [
            [
              {
                afterMs: 80,
                channel: "stdout",
                chunk: '{"type":"text","part":{"text":"one"}}\n',
              },
              {
                afterMs: 80,
                channel: "stdout",
                chunk: '{"type":"text","part":{"text":"two"}}\n',
              },
              {
                afterMs: 80,
                channel: "stdout",
                chunk: '{"type":"text","part":{"text":"three"}}\n',
              },
            ],
          ],
          openCodeWaitsForCancellation: true,
        }),
        providerID: "openai",
        timeoutMs: 100,
        hardTimeoutMs: 250,
      });
      const pending = agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      });
      await vi.advanceTimersByTimeAsync(260);
      await expect(pending).resolves.toMatchObject({
        blockers: ["Repo Preparation exceeded its hard cap of 250ms."],
        status: "failed",
      });
      expect(events).toEqual(
        expect.arrayContaining([
          {
            sandboxLog: expect.objectContaining({
              event: "preparation-timeout",
              timeoutKind: "hard-cap",
            }),
          },
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives OpenCode the remaining hard-cap timeout plus grace", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        captureOpenCodeTimeouts: true,
        commandStdout: ["not structured preparation output"],
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      hardTimeoutMs: 500,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    const timeout = events.find(
      (event): event is { openCodeTimeoutMs: number } =>
        typeof event === "object" &&
        event !== null &&
        "openCodeTimeoutMs" in event &&
        typeof event.openCodeTimeoutMs === "number",
    )?.openCodeTimeoutMs;
    expect(timeout).toBeGreaterThan(500);
  });
});

function fakeProvider(
  events: unknown[],
  input:
    | string[]
    | {
        commandStdout?: string[];
        commandOutputChunks?: Array<{
          channel: "stderr" | "stdout";
          chunk: string;
        }>;
        commandOutputChunksByRun?: Array<
          Array<{
            channel: "stderr" | "stdout";
            chunk: string;
          }>
        >;
        commandOutputScheduleByRun?: Array<
          Array<{
            afterMs: number;
            channel: "stderr" | "stdout";
            chunk: string;
          }>
        >;
        commandStderrChunks?: string[];
        commandStdoutChunks?: string[];
        commandDelayMs?: number;
        commandDelayMsByRun?: number[];
        openCodeWaitsForCancellation?: boolean;
        captureOpenCodeTimeouts?: boolean;
        dependencyInstallRequestReadNeverSettles?: boolean;
        cloneDiagnosticsStdout?: string;
        captureCloneTimeouts?: boolean;
        cloneResults?: Array<PreparationWorkspaceCommandResult | Error>;
        dependencyInstallRequest?: { command: string };
        manifestPayload?: unknown;
        openCodeResults?: PreparationWorkspaceCommandResult[];
        openCodeStartupErrors?: Error[];
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
      return {
        async release() {
          events.push({ release: "daytona_workspace" });
        },
        id: "daytona_workspace",
        workspace: fakeWorkspace(events, workspaceInput),
      };
    },
  };
}

function fakeWorkspace(
  events: unknown[],
  input: {
    commandStdout?: string[];
    commandOutputChunks?: Array<{
      channel: "stderr" | "stdout";
      chunk: string;
    }>;
    commandOutputChunksByRun?: Array<
      Array<{
        channel: "stderr" | "stdout";
        chunk: string;
      }>
    >;
    commandOutputScheduleByRun?: Array<
      Array<{
        afterMs: number;
        channel: "stderr" | "stdout";
        chunk: string;
      }>
    >;
    commandStderrChunks?: string[];
    commandStdoutChunks?: string[];
    commandDelayMs?: number;
    commandDelayMsByRun?: number[];
    openCodeWaitsForCancellation?: boolean;
    captureOpenCodeTimeouts?: boolean;
    dependencyInstallRequestReadNeverSettles?: boolean;
    cloneDiagnosticsStdout?: string;
    captureCloneTimeouts?: boolean;
    cloneResults?: Array<PreparationWorkspaceCommandResult | Error>;
    dependencyInstallRequest?: { command: string };
    manifestPayload?: unknown;
    openCodeResults?: PreparationWorkspaceCommandResult[];
    openCodeStartupErrors?: Error[];
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
  const commandOutputChunksByRun = [...(input.commandOutputChunksByRun ?? [])];
  const commandOutputScheduleByRun = [
    ...(input.commandOutputScheduleByRun ?? []),
  ];
  const cloneResults = [...(input.cloneResults ?? [])];
  const openCodeStartupErrors = [...(input.openCodeStartupErrors ?? [])];
  const openCodeResults = [...(input.openCodeResults ?? [])];
  let dependencyInstallRequest = input.dependencyInstallRequest;
  let sandboxLogChain = Promise.resolve();
  let validationRequest = input.validationRequest;
  let validationResult = input.validationResult;
  let releaseOpenCode: (() => void) | undefined;
  const commandDelayMsByRun = [...(input.commandDelayMsByRun ?? [])];

  return {
    async execute(command, options) {
      if (
        command.includes("opencode run") &&
        (input.commandDelayMs !== undefined || commandDelayMsByRun.length > 0)
      ) {
        const commandDelayMs =
          commandDelayMsByRun.shift() ?? input.commandDelayMs;
        if (commandDelayMs === undefined) {
          throw new Error("missing fake OpenCode delay");
        }
        await new Promise((resolve) => setTimeout(resolve, commandDelayMs));
      }
      if (command !== "git -C /workspace ls-files -z") {
        events.push({
          execute: command,
          ...(command.includes("opencode run")
            ? {
                configDir: options?.env?.OPENCODE_CONFIG_DIR,
                streaming:
                  options?.onStdout !== undefined ||
                  options?.onStderr !== undefined,
              }
            : {}),
        });
      }
      if (
        command.includes("git clone") &&
        input.captureCloneTimeouts === true
      ) {
        events.push({ cloneTimeoutMs: options?.timeoutMs });
      }
      if (
        command.includes("opencode run") &&
        input.captureOpenCodeTimeouts === true
      ) {
        events.push({ openCodeTimeoutMs: options?.timeoutMs });
      }
      if (
        command.includes("opencode run") &&
        openCodeStartupErrors.length > 0
      ) {
        throw openCodeStartupErrors.shift();
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
      const openCodeCompletion =
        command.includes("opencode run") &&
        input.openCodeWaitsForCancellation === true
          ? new Promise<void>((resolve) => {
              releaseOpenCode = resolve;
            })
          : undefined;
      const commandOutputChunks = command.includes("opencode run")
        ? commandOutputChunksByRun.length > 0
          ? commandOutputChunksByRun.shift()
          : input.commandOutputChunks
        : undefined;
      const commandOutputSchedule = command.includes("opencode run")
        ? commandOutputScheduleByRun.shift()
        : undefined;
      if (commandOutputSchedule !== undefined) {
        for (const output of commandOutputSchedule) {
          await new Promise((resolve) => setTimeout(resolve, output.afterMs));
          if (output.channel === "stdout") {
            options?.onStdout?.(output.chunk);
          } else {
            options?.onStderr?.(output.chunk);
          }
        }
      }
      if (
        commandOutputSchedule === undefined &&
        commandOutputChunks !== undefined
      ) {
        for (const output of commandOutputChunks) {
          if (output.channel === "stdout") {
            options?.onStdout?.(output.chunk);
          } else {
            options?.onStderr?.(output.chunk);
          }
        }
      } else {
        for (const chunk of input.commandStdoutChunks ?? ["opencode output"]) {
          options?.onStdout?.(chunk);
        }
        for (const chunk of input.commandStderrChunks ?? []) {
          options?.onStderr?.(chunk);
        }
      }
      if (openCodeCompletion !== undefined) {
        await openCodeCompletion;
      }
      if (command.includes("opencode run") && openCodeResults.length > 0) {
        return openCodeResults.shift() as PreparationWorkspaceCommandResult;
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
      if (
        command.includes("plugins/makeademo-tools.ts") ||
        command.startsWith("rm -f")
      ) {
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
      releaseOpenCode?.();
      releaseOpenCode = undefined;
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

function fakeProviderSequence(
  events: unknown[],
  inputs: Array<Exclude<Parameters<typeof fakeProvider>[1], string[]>>,
): PreparationWorkspaceProvider {
  const providers = inputs.map((input) => fakeProvider(events, input));
  let createIndex = 0;
  return {
    async create() {
      const provider = providers[createIndex];
      createIndex += 1;
      if (provider === undefined) {
        throw new Error("Unexpected extra workspace creation.");
      }
      events.push({ create: createIndex });
      return provider.create();
    },
  };
}

function providerSecretReferenceAuthFailure(): PreparationWorkspaceCommandResult {
  return providerInvalidApiKeyFailure("dtn_secr***************test");
}

function providerInvalidApiKeyFailure(
  receivedCredential: string,
): PreparationWorkspaceCommandResult {
  return {
    exitCode: 1,
    stderr: "",
    stdout: JSON.stringify({
      error: {
        data: {
          message: `Incorrect API key provided: ${receivedCredential}.`,
          responseBody: JSON.stringify({
            error: { code: "invalid_api_key" },
          }),
          statusCode: 401,
        },
        name: "APIError",
      },
      type: "error",
    }),
  };
}

function isReleaseEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && "release" in event;
}

function isCancelActiveCommandsEvent(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    "cancelActiveCommands" in event
  );
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
