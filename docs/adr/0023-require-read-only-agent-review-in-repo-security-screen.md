# Require Read-Only Agent Review in the Repo Security Screen

Supersedes ADR 0013.

Repo Security reuses the cold, initially unprivileged parent Preparation
Workspace that contains the pinned clone. Before any submitted code executes,
MakeADemo runs OSV-Scanner, GuardDog, and pinned local Semgrep rules there as
static advisory checks. Their normalized findings are leads for the reviewer;
the scanners do not approve or reject the repository. These established tools
replace MakeADemo's bespoke deterministic rejection rules.

The reviewer receives scanner findings as untrusted initial evidence and may
inspect the pinned clone through one Stage Agent Tool named `exec_command`.
That tool is a restricted read-only command surface, not a general shell: it
allows only approved repository-navigation operations such as ripgrep, bounded
`sed` reads, and explicitly safe Git inspection. It cannot write files, execute
repository code, start background work, access Global Agent Tools, or invoke a
browser. The Agent Harness uses `executionMode: "stage-tools-transient"`, does
not retain or return an Agent Session, and disposes provider state after the
review.

Repository files, filenames, manifests, scripts, and scanner messages are
untrusted evidence rather than instructions. Scanner findings, incomplete
scanner coverage, known vulnerabilities, dangerous-but-legitimate lifecycle
scripts, omissions, and general suspicion are not sufficient grounds for
rejection on their own. The reviewer must approve under ambiguity. It may
reject only when repository inspection establishes concrete, high-confidence,
clearly malicious behavior that MakeADemo would reach during dependency
installation, build, or application runtime. A rejection must identify the
exact file, line range, behavior, and reachable execution path.

Agent rejection stops the Pipeline as `security-rejected`. Reviewer timeout,
unavailability, or invalid structured output stops it as
`infrastructure-failed`; Repo Preparation never runs without an explicit agent
approval. Rejection destroys the unapproved parent immediately. Approval keeps
that same parent for Repo Preparation, while submitted-code execution remains
deferred to the separately provisioned child Sandbox. Secrets remain absent
until approval.

An approved review is recorded in the existing agent task logs when those logs
are enabled and is consumed only as the in-memory transition into Repo
Preparation. Approval is not carried in the Pipeline result and Stage 02 does
not create a separate audit artifact. Rejection and infrastructure outcomes
remain Pipeline results.

Scanner findings are not forwarded into Repo Preparation as authority. The
safety decision belongs entirely to Stage 02, keeping Repo Preparation focused
on making an already-approved repository runnable in its isolated workspace.
