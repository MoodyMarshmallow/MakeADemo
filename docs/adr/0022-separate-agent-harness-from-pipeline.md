# Separate the Agent Harness from the MakeADemo Pipeline

MakeADemo will run agentic Pipeline Stage work through a provider-neutral Agent Harness located beside the Pipeline. The Pipeline remains the product architecture: it owns stage order, task-specific prompts and tools, deterministic acceptance gates, repair decisions, retry budgets, and failure semantics. The Agent Harness owns universal agent policy, task execution, session continuity, tool exposure and dispatch mechanics, timeouts, cancellation, and audit behavior.

The Agent Harness combines Global Agent Tools with only the active Pipeline Stage's Stage Agent Tools for each task. Its production Global Agent Tools are anonymous Exa MCP web search/fetch and Context7 documentation lookup; remote read, write, edit, and shell execution are Harness runtime primitives rooted in the active Daytona workspace. Repo Preparation owns the dependency-install request, preparation-validation request, and preparation-result submission tools; those tools must not be exposed during Script Generation, Capture Path repair, or Draft Composite review.

The embedded Pi SDK is private to the Agent Harness. Pi models, events, native sessions, resource loading, and MCP clients remain behind the harness interface. The Harness disables normal Pi project and user discovery, supplies an in-memory configuration, and explicitly loads only MakeADemo policy and approved integrations. Daytona remains an External Seam because it provisions and operates workspaces and submitted-code sandboxes for both agent and deterministic Pipeline behavior; Pi delegates all model-invocable filesystem and command operations to that seam rather than the backend host.

This refines ADR 0011 rather than replacing it: runtime call direction is Pipeline to Agent Harness, while the user-visible MakeADemo Pipeline remains the product core. It also preserves ADRs 0012 and 0017: one Agent Session may continue across stages, but agent output never replaces authoritative Capture Path Validation.

The Harness owns provider retry policy: at most five retries (six total provider
requests) with exponential backoff waits of 2, 4, 8, 16, and 32 seconds. Each
applied wait emits a sanitized warning audit and synchronously extends the
stage's mutable hard deadline. Extensions are capped by, and never move, an
immutable Pipeline deadline supplied by the caller.
