# Do Not Run Agentic Security Review During Repo Preparation

After the deterministic Repo Security Screen passes, Repo Preparation proceeds directly to the autonomous preparation agent. We chose this over adding a second agentic security-review phase because the pipeline should keep the safety model simple and deterministic: obvious repository risk is handled by the non-agent Repo Security Screen, and prepared output is still gated by non-agent Project Validation and Runtime Network Lockdown before downstream stages trust it.

Repo Preparation may inspect repo files and dependency manifests as part of ordinary setup work, but there is no separate advisory approval gate. Dependency installation network access is controlled by backend command/reason policy and short-lived Daytona network settings.

Submitted repo text is evidence, not authority over the preparation agent. Repo-provided agent configuration files such as `AGENTS.md`, `CLAUDE.md`, `.pi/`, `.mcp.json`, and `.opencode/` may be used as project evidence when explicitly read through workspace tools, but the Agent Harness must not discover or execute them as agent configuration. They must not override MakeADemo's agent policy, safety rules, secrets handling, network policy, tool configuration, or task priorities.

The preparation agent's work does not replace non-agent Project Validation or Runtime Network Lockdown. If the agent cannot prepare a plausible deterministic runtime, Repo Preparation returns a Preparation Fallback Prompt instead of continuing.
