# Gate Network and Agent Secrets in Preparation Workspaces

The agent may have broad Harness-provided coding capabilities inside the ephemeral workspace, but the submitted app runtime remains subject to Runtime Network Lockdown during Capture Path Validation and Footage Capture. We chose this split because the preparation agent needs enough autonomy to prepare demos and repair scripts, while submitted repo code should not inherit agent privileges.

If dependency installation requires outbound network access, the main agent may only request a dependency-install-only network window. The network-access mechanism should enforce this mechanically by requiring an allowlisted package-manager install command and a dependency-install-only reason before it updates Daytona sandbox network settings.

Outbound network access should be blocked again immediately after dependency installation completes. Demo build, demo start, Capture Path Validation, and Footage Capture should run with outbound network blocked unless another dependency-install-only window is separately approved.

Agent research tooling belongs to the backend Agent Harness rather than the Daytona workspace or submitted app runtime. The Harness exposes anonymous Exa MCP web search and fetch tools through the official MCP SDK and loads Context7's official Pi extension explicitly; neither integration requires an API key during development. Research endpoints are fixed by the Harness, their results are untrusted input, and submitted repositories cannot add MCP servers or agent extensions.

Agent-authored shell and file operations in the parent preparation workspace run as an unprivileged image user and cannot mutate trusted helpers or package runtimes. The agent may edit `/workspace`, but file operations reject canonical paths changed by symlinks. Submitted dependency, build, and runtime execution remains behind backend-owned linked-sandbox methods; command text inspection is not an authorization boundary.

LLM provider credentials and any future agent-only secrets remain only in backend memory and are supplied directly to Pi's model runtime. They must not be injected into Daytona. Demo build and runtime subprocesses continue to receive a scrubbed environment, and persisted logs must redact secrets.
