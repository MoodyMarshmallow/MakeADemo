# Require Read-Only Agent Review in the Repo Security Screen

Supersedes ADR 0013.

The deterministic Repo Security scan is intentionally permissive: it rejects
only an exact, clearly destructive root-delete lifecycle command and records
all ambiguous repository characteristics as structured warnings. A separate
tool-free agent review inside Stage 02 is the sole transition that may approve
Repo Preparation.

The reviewer receives backend-selected, bounded static evidence and the
deterministic findings. Repository text is evidence rather than instructions.
The Agent Harness uses `executionMode: "tool-free-transient"`; the review has
no global or stage tools, Sandbox provider, browser controller, submitted-code
execution, or retained Agent Session. A hard deterministic rejection skips the
reviewer.
Agent rejection stops the Pipeline as `security-rejected`. Reviewer timeout,
unavailability, or invalid structured output stops it as
`infrastructure-failed`; Repo Preparation never runs without an explicit
approval.

An approved review is recorded in the existing agent task logs when those logs
are enabled and is consumed only as the in-memory transition into Repo
Preparation. Approval is not carried in the Pipeline result and Stage 02 does
not create a separate audit artifact. Rejection and infrastructure outcomes
remain Pipeline results.

Deterministic warnings are not forwarded into Repo Preparation. The safety
decision belongs entirely to Stage 02, keeping Repo Preparation focused on
making an already-approved repository runnable in its isolated workspace.
