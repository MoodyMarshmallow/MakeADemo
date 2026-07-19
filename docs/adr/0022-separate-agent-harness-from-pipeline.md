# Separate the Agent Harness from the MakeADemo Pipeline

MakeADemo will run agentic Pipeline Stage work through a provider-neutral Agent Harness located beside the Pipeline. The Pipeline remains the product architecture: it owns stage order, task-specific prompts and tools, deterministic acceptance gates, repair decisions, retry budgets, and failure semantics. The Agent Harness owns universal agent policy, task execution, session continuity, tool exposure and dispatch mechanics, timeouts, cancellation, and audit behavior.

The Agent Harness combines Global Agent Tools with only the active Pipeline Stage's Stage Agent Tools for each task. MakeADemo currently has no production Global Agent Tools. Repo Preparation owns the existing dependency-install request, preparation-validation request, and preparation-result submission tools; those tools must not be exposed during Script Generation, Capture Path repair, or Draft Composite review.

OpenCode is colocated under the Agent Harness as its private agent-runtime implementation, but OpenCode commands, configuration, streamed protocol, model identifiers, and session identifiers remain behind the harness interface. Daytona remains an External Seam because it provisions and operates workspaces and submitted-code sandboxes for both agent and deterministic Pipeline behavior.

This refines ADR 0011 rather than replacing it: runtime call direction is Pipeline to Agent Harness, while the user-visible MakeADemo Pipeline remains the product core. It also preserves ADRs 0012 and 0017: one Agent Session may continue across stages, but agent output never replaces authoritative Capture Path Validation.
