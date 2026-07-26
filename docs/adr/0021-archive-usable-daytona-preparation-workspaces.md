# Archive Usable Daytona Preparation Workspaces on Release

When a Daytona **Preparation Workspace** has yielded a usable handle,
MakeADemo will release it by cancelling active commands, then stopping and
archiving the logical submitted-code child when present before stopping and
archiving the primary. Release does not attempt to reseal network access while
the development policy keeps both sandboxes network-enabled.
Each sandbox is archived only after its own stop succeeds, because the Daytona
SDK requires a stopped sandbox before archiving. Neither sandbox is permanently
deleted as part of normal release.

The primary and submitted-code sandboxes are both created with
`autoDeleteInterval: -1`, which disables auto-deletion in the pinned Daytona
SDK. The submitted-code sandbox remains a separate execution boundary with its
own network namespace, but it is an independent Daytona sandbox and only a
logical child of the Preparation Workspace. Daytona-linked sandboxes must be ephemeral
with `autoDeleteInterval: 0` and cannot be preserved after stop, so provider
linkage is incompatible with this retention contract. The submitted-code
sandbox continues to use its dedicated runtime snapshot, scrubbed environment,
network-enabled development policy (`networkBlockAll: false`), and secret
isolation.

Deletion remains valid before a usable handle exists. If submitted-code sandbox
creation fails, or the primary cannot otherwise yield a usable handle, the
already-created primary sandbox is deleted as creation rollback.

Release is idempotent and best-effort across independent cleanup actions. A
submitted-code stop or archive failure does not prevent stopping and archiving
the primary. A stop failure prevents archive only for the sandbox whose stop
failed. The first cleanup error is reported after all applicable independent
cleanup work has been attempted.

This supersedes the workspace-teardown portions of ADR 0012 and ADR 0015, and
ADR 0016's requirement that submitted-code execution use a Daytona-linked,
ephemeral sandbox. It also supersedes the linked-sandbox implementation wording
in ADR 0014. It preserves ADR 0014 and ADR 0016's separate-execution, runtime
isolation, and secret-scoping constraints. Daytona sandbox-firewall Runtime
Network Lockdown is deferred and is not enforced or resealed during development
release; browser-level blocked-network evidence remains a separate signal.
