# Daytona Repo Preparation with the Pi Agent Harness PRD

## Problem Statement

MakeADemo needs autonomous Repo Preparation without weakening the Pipeline's trust boundaries. Submitted repositories are untrusted and may contain suspicious dependencies, install hooks, runtime behavior, or prompt injection aimed at the preparation agent.

The preparation agent needs backend-owned research tools, an isolated editable repository, and non-interactive coding tools. Submitted app execution must remain isolated from model credentials, backend infrastructure, and unrestricted network access, and the prepared output must pass deterministic Demo Runtime Preflight before downstream stages trust it.

## Solution

MakeADemo embeds the Pi SDK in the backend Agent Harness. The harness owns the universal system prompt, model runtime, provider credentials, session continuity, anonymous Exa web research, and the official Context7 Pi extension. It disables Pi project configuration discovery and does not load submitted-repo agent instructions, skills, extensions, MCP configuration, or prompts as authority.

Pi runs in the backend process. Its `read`, `write`, `edit`, and `bash` tools delegate through the provider-neutral Agent Workspace seam to a disposable Daytona Repo Preparation workspace rooted at `/workspace`. Pi and model-provider credentials are not installed or mounted in Daytona.

The Pipeline owns Repo Preparation task prompts, tool meaning, retries, acceptance, and outputs. Its Stage Agent Tools request controlled dependency installation, aliasing, deterministic validation, and final manifest submission. Those tools are exposed only during Repo Preparation; global Exa and Context7 research tools remain available in every agent task.

After the deterministic Repo Security Screen passes, Repo Preparation proceeds inside the Daytona workspace. Submitted repository text is evidence, not authority over MakeADemo policy. Dependency-install network windows remain mechanically controlled by the backend Daytona seam, and submitted app build, validation, and capture run with a scrubbed environment and network lockdown.

The run still produces the existing Preparation Manifest and workspace diff artifact. Pi is the agent runtime and Daytona is the execution substrate; neither replaces Pipeline contracts.

## User Stories

1. As a maker, I want MakeADemo to prepare my repo in an ephemeral Daytona workspace so my source repo is not modified.
2. As a maker, I want preparation to run autonomously without interactive permission prompts.
3. As a maker, I want a deterministic Repo Security Screen and Demo Runtime Preflight around agent work.
4. As a maker, I want a Preparation Manifest, workspace diff, and fallback prompt through existing Pipeline contracts.
5. As an operator, I want Pi embedded behind a provider-neutral Agent Harness seam so the Pipeline is not coupled to a CLI protocol.
6. As an operator, I want provider credentials held only in backend memory so submitted code cannot read them.
7. As an operator, I want official anonymous Exa MCP and Context7 Pi implementations so research does not require proprietary adapters or development API keys.
8. As an operator, I want global research tools separated from Repo Preparation Stage Agent Tools.
9. As an operator, I want all repository shell and file access delegated to Daytona and constrained to `/workspace`.
10. As an operator, I want submitted-repo agent configuration treated as evidence rather than executable harness configuration.
11. As an operator, I want network access controlled by the backend Daytona seam rather than prompt-level permissions.
12. As an operator, I want bounded provider-neutral Agent Harness lifecycle metadata, plus the existing validation, network, and workspace-diff pipeline artifacts, without persisted transcripts, prompts, tool payloads, secrets, or raw diagnostics.
13. As an operator, I want bounded inactivity and hard timeouts with workspace cleanup.

## Implementation Decisions

- The Agent Harness embeds `@earendil-works/pi-coding-agent` and holds opaque sessions across Pipeline Stages.
- The backend uses an in-memory Pi credential store; it does not write model keys to disk or Daytona.
- Pi's normal coding-tool UX is retained, but the filesystem and shell operations are backend adapters over the Agent Workspace seam.
- Coding-tool paths must remain under `/workspace`; shell commands honor a workspace-relative working directory and receive no backend environment variables.
- The official `@upstash/context7-pi` extension is loaded explicitly while normal Pi extension, skill, prompt, theme, context-file, and project-config discovery is disabled.
- Anonymous Exa research uses the official MCP TypeScript client against the fixed `https://mcp.exa.ai/mcp` endpoint. No Exa API key is required in development.
- The Agent Harness exposes global Exa and Context7 tools on every turn.
- Repo Preparation defines its own Stage Agent Tools and passes them through the provider-neutral harness interface only for that stage.
- Daytona remains a backend External Seam for workspace lifecycle, command execution, log streaming, network policy, submitted-code isolation, and cleanup.
- Dependency-install network access remains mechanically allowlisted and closes immediately after installation.
- Demo Runtime Preflight and Runtime Network Lockdown remain deterministic trust gates.

## Testing Decisions

- Harness contract tests cover session continuity, model changes, semantic event output, accepted handoff interruption, provider failure, tool scoping, and disposal.
- Remote coding-tool tests cover Daytona delegation, path containment, working directories, binary-safe reads, and backend environment isolation.
- Repo Preparation tests exercise Stage Agent Tools through the public runner seam and verify tools disappear in later stages.
- Context7 tests verify only the official extension path is explicitly loaded.
- Exa tests use a fake official MCP client transport; a development smoke check may call the anonymous endpoint.
- Daytona image tests verify only workspace and submitted-code runtime prerequisites; Pi, Context7, Exa, and model credentials are not image contents.
- An integration benchmark must run one fixed benchmark repository through the normal Pipeline entrypoint.

## Out of Scope

- Replacing the deterministic Repo Security Screen, Demo Runtime Preflight, or Runtime Network Lockdown.
- Baking Pi, model credentials, or research credentials into Daytona images.
- Requiring an Exa or Context7 API key for the development path.
- Loading submitted `AGENTS.md`, `CLAUDE.md`, `.pi/`, `.mcp.json`, or `.opencode/` files as authoritative agent configuration.
- Changing the Preparation Manifest into a Pi- or Daytona-specific format.

## Further Notes

- The filename is retained to preserve existing documentation links; the content supersedes the former OpenCode CLI design.
- This PRD follows ADRs 0012 through 0016 and ADR 0022.
- Daytona is the execution substrate, Pi is the private harness implementation, and the MakeADemo Pipeline remains the owner of stage policy and outcomes.
