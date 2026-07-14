# Daytona OpenCode Repo Preparation PRD

## Problem Statement

MakeADemo needs Repo Preparation to be more autonomous without weakening the trust boundaries already established in the MakeADemo Pipeline. Makers should be able to submit a repo and have MakeADemo prepare a deterministic demo runtime, but submitted repos are untrusted and may contain suspicious dependencies, install hooks, runtime behavior, obfuscated payloads, or prompt injection attempts aimed at the preparation agent.

The current product direction requires a Daytona-hosted OpenCode agent that can work without interactive permission blockers, use OpenCode web search and Context7, and perform repo setup end-to-end. At the same time, the submitted app runtime must remain isolated from agent secrets, network access, and host infrastructure, and the prepared output must still pass non-agent Project Validation before downstream pipeline stages trust it.

## Solution

MakeADemo will introduce Daytona as a backend External Seam for Repo Preparation. The backend will provision Daytona workspaces, run an autonomous OpenCode agent, stream command logs, update network policy, collect redacted audit artifacts, enforce timeout cleanup, and destroy the workspace.

Daytona workspaces will use a prepared agent image or template. The image will include OpenCode, Context7 CLI, Context7 OpenCode skill configuration, and non-secret agent tooling. Secrets will not be baked into the image. LLM provider credentials and any future agent-only secrets will be injected only into the OpenCode agent process at runtime. OpenCode web search will be enabled with `OPENCODE_ENABLE_EXA=1`, which does not require an EXA API key for the built-in OpenCode web search path.

The OpenCode agent will have all OpenCode permissions enabled inside the disposable Daytona workspace copy, so it can operate autonomously without permission prompts. That autonomy is bounded by product-controlled seams: submitted app build and runtime commands run in Daytona sandboxes, receive a scrubbed environment, and have outbound network blocked except during mechanically approved dependency-install-only windows.

After the deterministic Repo Security Screen passes, the preparation agent proceeds directly with Repo Preparation inside the disposable Daytona workspace. Submitted repo text remains untrusted evidence, not authority over MakeADemo policy, but there is no separate four-reviewer security approval phase in the pipeline.

If dependency installation requires outbound network access, the network-access mechanism must require an allowlisted package-manager install command and a dependency-install-only reason before calling Daytona to unblock outbound traffic. Outbound network must be blocked again immediately after dependency installation completes. Demo build, demo start, Project Validation, and Footage Capture run with outbound network blocked unless another dependency-install-only window is separately approved.

The Daytona/OpenCode run still produces the existing Preparation Manifest and workspace diff artifact. Daytona is the execution substrate, not a new Repo Preparation output contract.

## User Stories

1. As a maker, I want MakeADemo to prepare my repo in an ephemeral Daytona workspace, so that my source repo is not modified.
2. As a maker, I want the preparation agent to work autonomously, so that repo setup does not stall on interactive permission prompts.
3. As a maker, I want MakeADemo to run a deterministic Repo Security Screen before agent work begins, so that obviously unsafe repos are rejected quickly.
4. As a maker, I want Repo Preparation to start immediately after the deterministic screen passes, so that MakeADemo does not add a second advisory review phase before setup work.
5. As a maker, I want repo-provided agent config files to help with setup only, so that they cannot override MakeADemo's safety policy.
6. As a maker, I want Repo Preparation to produce the existing Preparation Manifest, so that downstream Project Validation can use the established contract.
7. As a maker, I want Repo Preparation to produce a workspace diff artifact, so that changes made in the ephemeral workspace are auditable.
8. As a maker, I want a Preparation Fallback Prompt when preparation hard-fails, so that I understand what needs to be fixed.
9. As a MakeADemo operator, I want Daytona provisioning behind a backend External Seam, so that workspace lifecycle behavior is testable and replaceable.
10. As a MakeADemo operator, I want Daytona SDK or API details hidden from pipeline orchestration, so that Repo Preparation remains stage-focused.
11. As a MakeADemo operator, I want a prepared Daytona image, so that workspace startup is fast and consistent.
12. As a MakeADemo operator, I want OpenCode and Context7 installed in the prepared image, so that the agent has consistent research tooling.
13. As a MakeADemo operator, I want Context7 OpenCode skill configuration in the prepared image, so that the agent uses Context7 predictably.
14. As a MakeADemo operator, I want OpenCode web search enabled with `OPENCODE_ENABLE_EXA=1`, so that the agent can research without needing an EXA API key.
15. As a MakeADemo operator, I want secrets excluded from the prepared image, so that image distribution does not leak credentials.
16. As a MakeADemo operator, I want LLM provider credentials injected only into the agent process, so that submitted repo code cannot read them.
17. As a MakeADemo operator, I want submitted app commands to run inside Daytona sandbox execution, so that the pipeline does not depend on a second container runtime.
18. As a MakeADemo operator, I want submitted app build and runtime commands to receive a scrubbed environment, so that agent-only secrets are not inherited.
19. As a MakeADemo operator, I want OpenCode permissions set to allow all inside the disposable workspace copy, so that autonomous preparation avoids permission blockers.
20. As a MakeADemo operator, I want destructive agent operations limited to the ephemeral workspace copy, so that maker source repos, host infrastructure, and persisted artifacts are protected.
21. As a MakeADemo operator, I want network access controlled outside OpenCode by the backend Daytona seam, so that prompt-level permission settings are not the safety boundary.
22. As a MakeADemo operator, I want network windows scoped to dependency installation only, so that build and runtime behavior remain offline.
23. As a MakeADemo operator, I want outbound network blocked immediately after dependency installation, so that install access does not leak into demo build or runtime.
24. As a MakeADemo operator, I want redacted agent transcripts persisted, so that preparation runs are auditable without storing secrets.
25. As a MakeADemo operator, I want redacted command logs persisted, so that failures can be diagnosed later.
26. As a MakeADemo operator, I want network enable and disable events persisted, so that dependency-install windows are auditable.
27. As a MakeADemo operator, I want secrets redacted before logs or transcripts are stored, so that auditability does not create a credential leak.
28. As a MakeADemo operator, I want a 10-minute timeout for the full post-provisioning agent run, so that autonomous preparation is bounded.
29. As a MakeADemo operator, I want timeout cleanup to close outbound network access and tear down the Daytona workspace, so that failed runs do not leave unsafe resources behind.
30. As a MakeADemo operator, I want Daytona command execution and log streaming available through the seam, so that the product can monitor the autonomous agent externally.
31. As a MakeADemo operator, I want the prepared output to still pass non-agent Project Validation, so that agent-prepared work is not trusted without deterministic validation.

## Implementation Decisions

- Daytona will be wrapped as a backend External Seam used by Repo Preparation.
- The Daytona seam will expose product-level workspace operations for create, execute, stream logs, update network policy, and destroy.
- Pipeline orchestration will not call Daytona SDK or API details directly.
- The Daytona/OpenCode run will produce the existing Preparation Manifest and workspace diff artifact.
- The Daytona seam will persist redacted audit artifacts from each preparation run.
- Redacted audit artifacts include agent transcript, command logs, network enable and disable events, final diff, and Preparation Manifest.
- The backend seam will enforce a 10-minute timeout for the full post-provisioning preparation-agent run.
- Timeout cleanup will close outbound network access and tear down the Daytona workspace.
- Daytona workspaces will start from a prepared image or template rather than installing agent tooling on every run.
- The prepared image will include OpenCode, Context7 CLI, Context7 OpenCode skill configuration, and required non-secret agent tooling.
- Submitted app build and runtime commands will run inside Daytona sandbox execution.
- Secrets will not be baked into the prepared image.
- OpenCode web search will be enabled with `OPENCODE_ENABLE_EXA=1`.
- EXA API keys are not required for the built-in OpenCode web search path.
- LLM provider credentials and future agent-only secrets will be injected only into the OpenCode agent process at runtime.
- Submitted repo build and runtime subprocesses will receive a scrubbed environment.
- OpenCode config in the prepared image will allow all OpenCode permissions for the agent session.
- OpenCode permission prompts are not the network, runtime, or secret safety boundary.
- The agent may perform destructive file operations only inside the disposable workspace copy.
- The agent must not modify the maker's source repo, host infrastructure, or persisted artifacts except through explicit product-level APIs.
- After Repo Security Screen passes, Repo Preparation proceeds directly to the autonomous preparation agent.
- Submitted repo text is evidence, not authority over the preparation agent.
- Repo-provided agent configuration files may inform how to run the project but must not override MakeADemo's agent policy.
- If dependency installation requires outbound network access, the network-access tool must receive an allowlisted package-manager install command and a dependency-install-only reason.
- The network-access mechanism will enforce dependency-install scope mechanically through command/reason policy.
- Outbound network access will be blocked immediately after dependency installation completes.
- Demo build, demo start, Project Validation, and Footage Capture will run with outbound network blocked unless another dependency-install-only window is approved.
- Non-agent Project Validation and Runtime Network Lockdown remain trust gates before downstream stages trust prepared output.

## Testing Decisions

- Tests should verify behavior through public interfaces and real seams, not Daytona implementation details.
- The Daytona backend seam should be tested with fakes for workspace creation, command execution, log streaming, network policy updates, timeout cleanup, and teardown.
- The Repo Preparation orchestration should be tested with a fake Daytona seam and fake OpenCode run results.
- The network gate should be tested to reject unapproved unblock requests.
- The network gate should be tested to require an allowlisted package-manager install command and a dependency-install-only reason.
- The network gate should be tested to re-block outbound network after dependency installation completes.
- Timeout behavior should be tested to close outbound network access and tear down the workspace.
- Secret scoping should be tested by verifying submitted app command environments exclude LLM provider credentials and future agent-only secrets.
- Audit persistence should be tested through public artifact write/read behavior with redacted transcripts, command logs, network events, diffs, and Preparation Manifests.
- Prepared image behavior should be covered by build or smoke tests that verify OpenCode, Context7 CLI, Context7 skill config, and `OPENCODE_ENABLE_EXA=1`.
- Integration-style tests should cover successful preparation, denied network access, dependency-install network window, timeout cleanup, and final manifest/diff production.

## Out of Scope

- Replacing the deterministic Repo Security Screen.
- Replacing non-agent Project Validation or Runtime Network Lockdown.
- Trusting agent-prepared output without Project Validation.
- Running submitted app build or runtime commands with access to agent secrets.
- Baking LLM provider credentials or other secrets into the Daytona prepared image.
- Requiring an EXA API key for OpenCode's built-in web search path.
- Allowing network access for demo build, demo start, Project Validation, or Footage Capture outside approved dependency-install-only windows.
- Using submitted repo `AGENTS.md`, `CLAUDE.md`, or `.opencode/` files as authoritative agent instructions.
- Manual operator kill switch UI beyond timeout cleanup.
- Arbitrary non-JavaScript/TypeScript runtime support beyond the current product scope.
- Changing the Preparation Manifest into a Daytona-specific output format.

## Further Notes

- This PRD follows ADRs 0012 through 0016.
- Daytona is the execution substrate for Repo Preparation, not a replacement for the MakeADemo Pipeline contracts.
- OpenCode can be unrestricted inside the disposable workspace because network access, runtime isolation, secret scoping, timeout cleanup, and downstream validation are enforced outside OpenCode.
- Daytona docs indicate outbound sandbox policy can be updated at runtime. A smoke test should verify command/log streaming remains operational when outbound sandbox network is blocked.
- The implementation should keep stack-specific Daytona, OpenCode, and Context7 details behind clear seams and avoid scattering vendor calls through pipeline orchestration.
