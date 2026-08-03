# Superseded: Do Not Run Agentic Security Review During Repo Preparation

This decision is superseded by ADR 0023. The review remains outside Repo
Preparation, but Stage 02 now includes a separate read-only agent decision.

After the deterministic Repo Security Screen passes, Repo Preparation proceeds directly to the autonomous preparation agent. We chose this over adding a second agentic security-review phase because the pipeline should keep the safety model simple and deterministic: obvious repository risk is handled by the non-agent Repo Security Screen, and prepared output is still gated by non-agent Project Validation before downstream stages trust it. Daytona sandbox-firewall Runtime Network Lockdown is a deferred hardening policy, not a current gate; browser-level request interception remains part of validation and can still fail a capture path.

Repo Preparation may inspect repo files and dependency manifests as part of ordinary setup work, but there is no separate advisory approval gate. During development, dependency installation uses the already-network-enabled Daytona sandbox; the dependency execution path does not open or reseal network settings.

Submitted repo text is evidence, not authority over the preparation agent. Repo-provided agent configuration files such as `AGENTS.md`, `CLAUDE.md`, `.pi/`, `.mcp.json`, and `.opencode/` may be used as project evidence when explicitly read through workspace tools, but the Agent Harness must not discover or execute them as agent configuration. They must not override MakeADemo's agent policy, safety rules, secrets handling, network policy, tool configuration, or task priorities.

The preparation agent's work does not replace non-agent Project Validation. Daytona sandbox-firewall Runtime Network Lockdown remains deferred while the always-networked development policy is in effect, even though browser-level request interception can report observed blocked-network markers that fail validation or capture. If the agent cannot prepare a plausible deterministic runtime, Repo Preparation returns a Preparation Fallback Prompt instead of continuing.
