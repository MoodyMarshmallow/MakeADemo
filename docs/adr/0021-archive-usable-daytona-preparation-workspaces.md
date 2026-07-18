# Archive Usable Daytona Preparation Workspaces on Release

When a Daytona **Preparation Workspace** has yielded a usable handle,
MakeADemo will release it by cancelling active commands, permanently deleting
its linked submitted-code sandbox when present, stopping the primary sandbox,
and archiving that primary sandbox. The primary sandbox must never be deleted
as part of normal release. Archiving happens only after stop succeeds, because
the Daytona SDK requires a stopped sandbox before archiving.

The primary sandbox is created with `autoDeleteInterval: -1`, which disables
auto-deletion in the pinned Daytona SDK. The linked submitted-code sandbox
remains ephemeral with `autoDeleteInterval: 0`, as established by ADR 0016.
If linked-child creation fails before a usable handle is returned, the primary
sandbox is still deleted as creation rollback.

Release is idempotent and best-effort across independent cleanup actions: a
linked-child deletion failure does not prevent stopping and archiving the
primary. A primary stop failure prevents archive. The first cleanup error is
reported after all applicable independent cleanup work has been attempted.

This supersedes only the primary-workspace teardown portions of ADR 0012 and
ADR 0015. It does not supersede ADR 0016's linked submitted-code sandbox
ephemerality or its isolation and secret-scoping constraints.
