# Use Prepared Agent Workspace Images

Daytona preparation workspaces will start from a prepared image or template that includes the OpenCode agent runtime, the Context7 CLI, Context7 OpenCode skill configuration, and required non-secret agent tooling. We chose this over installing agent tooling on every workspace creation because prepared images make Repo Preparation faster, more consistent, and less dependent on repeated setup-time network access.

The parent prepared image should run OpenCode and MakeADemo tooling only. Submitted app build and runtime commands should run in a separate linked ephemeral Daytona sandbox created from a submitted-code runtime snapshot. Linked sandboxes keep pipeline execution tied to the Daytona external seam, avoid Docker-in-Docker image-store preloading, and avoid exposing a host Docker socket to the agent workspace.

Secrets must not be baked into either snapshot. OpenCode web search should be enabled for the agent with `OPENCODE_ENABLE_EXA=1`, which does not require an EXA API key for the built-in web search path. LLM provider credentials and any future agent-only credentials should be injected at runtime only into the OpenCode agent environment. Submitted repo build and runtime commands should execute in the linked submitted-code sandbox with a scrubbed environment, no inherited agent secrets, and no outbound network access except for mechanically approved dependency-install-only windows.

The OpenCode agent may run fully autonomously inside the disposable workspace copy, including destructive file operations needed to prepare the demo. That autonomy must not extend to the maker's source repo, host infrastructure, or persisted artifacts except through explicit product-level APIs.

The prepared OpenCode configuration should allow all OpenCode permissions for the agent session to avoid interactive blockers. Network access, runtime isolation, secret scoping, timeouts, and workspace teardown are enforced by the backend Daytona seam and nested runtime controls rather than by OpenCode permission prompts.

Snapshot selection is deployment configuration, not a CLI input. The parent OpenCode snapshot is read from `MAKEADEMO_DAYTONA_SNAPSHOT`. The linked submitted-code runtime snapshot is read from `MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT`.

The prepared image should include predefined OpenCode subagent configurations for the four security reviewers from ADR 0013. Predefining them keeps reviewer prompts, permissions, and structured accept/reject outputs consistent across preparation runs.
