# Run an Opt-In Railway Pipeline Benchmark Spike

We will evaluate Railway through opt-in, hard-gated canaries and whole-Pipeline
benchmark runs behind provider-neutral workspace and runner seams. Daytona
remains the production provider and default path. This decision does not
supersede the production Daytona decisions in [ADR 0014](0014-gate-network-and-agent-secrets-in-preparation-workspaces.md),
[ADR 0015](0015-wrap-daytona-as-a-backend-external-seam.md),
[ADR 0021](0021-archive-usable-daytona-preparation-workspaces.md), or
[ADR 0022](0022-separate-agent-harness-from-pipeline.md).

The benchmark runner may select Railway with the explicit
`--sandbox-provider railway` flag. This is an experiment switch, not a public
product fallback or a change to the default provider. The controller-facing
Pipeline interface remains provider-neutral: composition supplies the selected
workspace provider, while the controller owns only Pipeline Job input, `run`,
and `dispose`.

The spike provisions two independent `ISOLATED` Railway sandboxes for each
canary or benchmark run. It uses a fixed, pinned toolchain and explicit,
hard-gated commands; ordinary test or pipeline execution must not provision
Railway resources. Authentication is limited to
`MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN` and
`MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID`. The runner must not read ambient
`RAILWAY_API_TOKEN`, `RAILWAY_TOKEN`, `RAILWAY_ENVIRONMENT_ID`, or other
inherited credentials. Railway cleanup destroys exact run-owned sandbox IDs;
unlike Daytona's normal release, it does not stop and archive usable workspaces.
No public preview or user-facing provider selection is part of this spike.

The recorded POC proves the pinned SDK's core lifecycle and execution seam:
two isolated sandboxes can be created concurrently, listed and reconnected,
stream stdout and stderr, detach and reattach a durable session when Railway
assigns one, kill a process group and await settlement, round-trip text,
binary, and streamed files, reach public egress, and be destroyed with an
empty final live-sandbox list. The pinned CLI can likewise create and destroy
two isolated sandboxes, observe separated streams, detached-session
reattachment, timeout followed by settlement, and public-origin access; the
Railway project-sandbox feature is enabled.

The POC does not prove a production-ready image or runtime: the default image
ran as uid 0 and lacked Node, FFmpeg, and Chromium; template/tool coverage,
idle-timeout behavior or a bounded heartbeat, capacity/concurrency, the Files
API and token SDK, screenshot transfer, representative previously failing
repositories, and injected-failure cleanup diagnostics remain unproven.
Private-DNS isolation and localhost screenshot checks were skipped because
their dedicated inputs were not configured. A client-side timeout is not
treated as proof of provider termination, and the POC does not claim a
heartbeat, template, browser image, resource, or concurrency contract.

The whole-Pipeline benchmark is evidence that the selected Railway adapter can
exercise the existing stage sequence only when every stage's capture and
compositing prerequisites are present. A successful machine run must still be
reported with its provider, pinned repository commit, and full-Pipeline result;
it does not award manual L6 verification. The Railway browser path remains
loopback-only, so it does not establish a public preview URL or remote-browser
reachability contract.

Promotion beyond the spike requires a pinned image/toolchain containing the
capture prerequisites (including Chromium, Playwright, and FFmpeg), measured
idle-timeout/heartbeat behavior, capacity and concurrency limits, coverage on
a simple fixture and representative failing benchmark repositories, and
cleanup diagnostics for injected failures at each provisioning stage. The
private-DNS and screenshot checks must be run where applicable. Until every
gate is accepted, Railway is neither a fallback nor a replacement for the
Daytona production path, and no public preview is exposed.

This ADR intentionally records an evaluation boundary and its non-goals: it
does not make Railway a production fallback, alter Capture Path Validation
contracts, promise sandbox-firewall network lockdown, expose a public preview,
or authorize ambient credentials. Any future promotion must be a separate
decision that preserves the provider-neutral seams and the existing Daytona
production ADRs.
