# Use Trusted Preparation Playbooks and Independently Review Application Identity

Repo Preparation will receive MakeADemo's core preparation invariants on every
agent turn and may load deeper guidance only from a backend-bundled trusted
playbook catalog. The catalog contains `mock-backend-data`,
`local-authentication`, and `seed-local-database`. Repo Preparation owns the
stage-scoped `makeademo_load_playbook` tool, and the backend records every
playbook ID actually loaded through it. Repository-provided skills, agent
instructions, prompts, extensions, MCP configuration, and similarly named
files remain untrusted repository evidence. MakeADemo never discovers or loads
them as preparation skills or authority.

The Preparation Manifest will persist a structured mocking plan covering the
native UI roots that must remain visible, the runtime boundaries replaced by
local behavior, fixture paths, loaded trusted playbooks, and planned
presentation-only changes. The backend verifies that the manifest's loaded
playbook IDs exactly match recorded tool use. Mocking authentication requires
`local-authentication`, mocking a backend requires `mock-backend-data`, and
mocking a database requires `seed-local-database`. A preparation result that
claims an unloaded playbook or mocks one of those boundaries without its
required playbook is invalid.

MakeADemo will also create backend-owned identity evidence around Repo
Preparation. Before preparation, it records the submitted repository URL,
pinned revision, source tree object ID, and bounded source-controlled path
inventory. After preparation, it records a content-addressed workspace diff
and bounded prepared evidence such as screenshots and accessibility snapshots.
Together with the manifest's mocked boundaries, these records form the
Prepared Application Identity Evidence ledger. Repository content and prepared
output remain untrusted data inside that ledger; they cannot author or widen
its provenance.

After Repo Preparation succeeds and before Script Generation begins, a
Prepared Application Identity Review independently decides whether the visible
prepared application is still the submitted pinned application's native
interface. The reviewer runs in a fresh, non-retained
`stage-tools-transient` Agent Harness task. It receives no Global Agent Tools,
general shell, repository skill discovery, or retained preparation session.
Its complete tool surface consists of bounded reads from source-controlled
files at the backend-pinned commit and bounded pages from the backend-owned
identity evidence ledger.

Deterministic code validates only evidence structure, bounds, hashes, pinned
Git provenance, allowed source paths, evidence IDs, mocked-boundary citations,
and reviewer output provenance. It does not decide the semantic question of
application identity. That judgment belongs to the independent reviewer, which
must fail closed when identity is not proven, a replacement application is
detected, or the evidence is ambiguous. Timeout, unavailability, and invalid
structured output are also terminal review failures. No failed review may
advance to Script Generation.

This decision refines ADRs 0011, 0012, and 0022 by inserting an independent
agent review between Repo Preparation and Script Generation and by adding a
stage-owned trusted guidance catalog. It preserves ADR 0017: Prepared
Application Identity Review is not an execution or capture-readiness gate and
does not replace deterministic Capture Path Validation. Capture Path
Validation remains the authoritative non-agent gate that must run the prepared
application and generated capture path successfully before Footage Capture.

This review is also distinct from ADR 0020's Benchmark Demo Verification. The
Pipeline identity review protects the prepared application before script
generation. Benchmark L6 remains a later manual judgment by the external
coding agent comparing an L5 final video with pinned source evidence; the
benchmark command still stops at L5 and never invokes an evaluator or writes
L6.

The tradeoff is one additional transient model review and the possibility of a
fail-closed rejection when evidence is insufficient. In return, preparation
guidance stays backend-controlled, replacement applications cannot become
trusted merely by satisfying deterministic shape checks, and the independent
reviewer cannot inherit the preparation agent's instructions, tools, or
conversation.
