# Railway Sandbox SDK proof of concept

This is an opt-in Phase 0 integration spike. It does not change production
composition and does not remove or replace Daytona. The test exercises the
official `railway@3.6.0` TypeScript SDK directly, using its product-owned
`Sandbox` API.

## Run

The suite is hard-gated so an ordinary test run cannot provision cloud
resources. Set `RUN_RAILWAY_SANDBOX_POC=1` and provide a dedicated Railway
token/environment before running:

```sh
MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN=... \
MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID=... \
bun run test:railway-sandbox-poc
```

The test intentionally does not read ambient `RAILWAY_API_TOKEN`,
`RAILWAY_TOKEN`, or `RAILWAY_ENVIRONMENT_ID`; the dedicated names and explicit
gate prevent a backend process environment from being reused accidentally. The
token is passed as a Railway project token (`authType: "project-token"`).
This deliberately tightens the attached plan's broader `RAILWAY_API_TOKEN`
proposal to the environment-scoped credential Railway recommends for
single-environment automation.

## Whole-Pipeline benchmark

The existing benchmark runner can exercise the complete MakeADemo Pipeline on
Railway, from Repo Security Screen through Compositing, with an explicit
provider flag:

```sh
MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN=... \
MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID=... \
OPENAI_API_KEY=... \
bun run benchmark --sandbox-provider railway -- midday
```

The flag is intentionally benchmark-only and does not change the Daytona
default or expose Railway as a product fallback. The provider-neutral
controller-facing Pipeline interface receives the selected adapter; controllers
do not construct Railway sandboxes or manage their lifecycle. The benchmark
records the selected provider in its manifest and result rows and preserves the
same pinned repository commit and success-level rules used by Daytona.

Railway whole-Pipeline runs use the revisioned
`makeademo-railway-pipeline-v2` recipe, including root-owned capture tooling.
They require the dedicated project token and environment variables above and
ignore ambient Railway credential names. Each run destroys its exact
run-owned Railway sandboxes during cleanup. This differs from Daytona's normal
release, which stops and archives usable preparation workspaces.

The browser and app remain inside the Railway sandbox on loopback addresses;
the benchmark therefore validates the pipeline's local capture path, not a
public preview or remote-browser URL. A passing machine result is not an L6
review: manual Benchmark Demo Verification remains required, and promotion to
production still requires the hard gates in ADR 0023.

## Demo Runtime Preflight canary

The Phase 3 canary is a separate, hard-gated command. It uses the checked-in
localhost fixture, creates two `ISOLATED` Railway sandboxes from the pinned
template recipe, invokes the real Demo Runtime Preflight and Playwright
validator, transfers a PNG proof back across the submitted-code boundary, and
destroys only the two sandboxes it created. It never creates a public preview
and does not alter the Daytona production composition.

```sh
RUN_RAILWAY_SANDBOX_SPIKE=1 \
MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN=... \
MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID=... \
bun run railway:preflight-spike
```

Do not substitute ambient `RAILWAY_API_TOKEN`, `RAILWAY_TOKEN`, or
`RAILWAY_ENVIRONMENT_ID`; the command ignores them. The JSON report redacts
the dedicated token and is evidence for this one canary only, not a production
provider-selection result. On success, the command first downloads and verifies
the PNG proof into an owned directory under the system temporary directory,
then releases both run-owned sandboxes and writes `report.json` beside the PNG.
The report includes the PNG byte size and SHA-256 plus the template revision and
pinned Node, npm, and Playwright versions. Failed runs remove their partial
evidence directory.

## Sandbox-ready latency benchmark

The latency benchmark is separate from full Demo Runtime Preflight timing. It
first runs and reports one unmeasured exact-recipe prewarm through the same
provider, first-exec, release, and inventory path. The resulting cohort is
described as `prewarmed-exact-recipe`; the benchmark does not claim access to
Railway's server-side cache metadata. For each of the following 20 measured
samples, it starts the clock immediately before creating the independent parent
and submitted-code sandboxes, and stops only after both are `RUNNING` and each
has completed an ordinary bounded `true` command.

Cleanup is measured separately. Before prewarm, the command captures the active
sandbox inventory in the dedicated environment. After prewarm and every sample,
it requires authoritative inventory to contain no new live ids relative to that
baseline before continuing. It only destroys exact ids returned to this run;
baseline or otherwise unknown ids are never destroyed, and an unknown new live
id fails the run closed without printing the id. Inventory follows every
GraphQL cursor to completion under per-request and total deadlines; it never
certifies cleanup from a truncated page. Only `DESTROYED` and `FAILED` are
treated as terminal, so an unfamiliar future status fails safe as active.

```sh
RUN_RAILWAY_SANDBOX_LATENCY_BENCHMARK=1 \
MAKEADEMO_RAILWAY_SANDBOX_PROJECT_TOKEN=... \
MAKEADEMO_RAILWAY_SANDBOX_ENVIRONMENT_ID=... \
bun run railway:sandbox-latency-benchmark
```

The default 20 samples are the minimum useful set for nearest-rank p95. Set
`MAKEADEMO_RAILWAY_SANDBOX_BENCHMARK_SAMPLES` to an integer from 20 through 100
for a larger run. The JSON report includes every sample, create/first-exec/
release timings, p50/p95/max, failures, template revision, pinned tool versions,
and a `meetsP95Target` result for the strict `p95 < 15,000ms` target. The
prewarm timing is reported separately and never enters percentile calculation.
The command exits nonzero on any sample failure or when p95 is 15 seconds or
greater. It ignores ambient Railway
tokens and does not include fixture upload, browser validation, or other full
preflight work.

Optional checks:

- `RAILWAY_POC_PUBLIC_URLS`: whitespace/comma-separated HTTPS URLs (defaults
  to npm, yarn, nodejs.org, Prisma, Playwright, and Google Fonts origins).
- `RAILWAY_POC_STREAM_BYTES`: streamed file size in bytes (defaults to 64 MiB,
  or `67108864` bytes); set a positive integer to override it.
- `RAILWAY_POC_PRIVATE_HOST`: a Railway private DNS URL/host. The test expects
  a `PRIVATE` control sandbox to curl it successfully and two `ISOLATED`
  sandboxes to fail.
- `RAILWAY_POC_SCREENSHOT_COMMAND`: a command that starts with the prepared
  localhost page at `http://127.0.0.1:4173/` and writes a PNG to
  `RAILWAY_POC_SCREENSHOT_PATH` (default `/tmp/makeademo-railway-poc.png`).
  This check remains skipped unless browser tooling is explicitly supplied.

## Covered SDK primitives

The live tests cover default-`ISOLATED` create, reconnect, list, destroy,
stdout/stderr streaming, durable `detach`/session-name reattach when Railway
assigns a durable session, process-group `kill` and settlement, text/binary/
streaming file round trips, public egress, optional private-DNS isolation,
optional localhost screenshot transfer, and cleanup in an injected failure.
The durable-session test requires Railway to assign a reattachable session; it
does not fake a pass.

The large-file check produces deterministic 8 KiB chunks lazily, supplies a
fresh upload iterable for retries, and verifies the streamed download by byte
count and SHA-256 without collecting the full file in memory.

The SDK's authoritative contract says `kill()` delivers a signal to the
process group and returns a boolean; awaiting the exec handle yields the final
`ExecResult`. Timeout is a client-side deadline that reports `timedOut`. The POC
therefore does not claim that a timeout is a provider kill, nor does it invent a
heartbeat, template, browser image, or resource/concurrency result. Those
remain hard gates for a later phase.

## SDK findings (2026-07-28)

- The final credentialed core run completed in 71.72 seconds with seven
  required checks passed and two optional checks skipped. The default 64 MiB
  streamed transfer passed its byte-count and SHA-256 verification without an
  out-of-memory failure.
- The optional private-DNS isolation and localhost screenshot checks remained
  skipped because their environment inputs were not configured.
- The run cleaned up its sandboxes; a final live-sandbox list was empty.

## CLI findings (2026-07-28)

- Pinned CLI checks passed: `railway 5.8.0` and `Daytona CLI v0.199.0`.
- MakeADemo staging sandbox listing succeeded, confirming the
  `PROJECT_SANDBOXES` feature is enabled. Two default-`ISOLATED` sandboxes
  were created and destroyed; the final list was empty.
- CLI checks observed separated stdout/stderr, detached-session reattach and
  completion, and timeout followed by a settled process. Public npm, yarn,
  Node, Prisma, Playwright, and font origins were reachable (including
  expected HTTP 404/400 responses); `makeademo-worker.railway.internal` did
  not resolve from an isolated sandbox.
- The default image ran as uid 0 and did not include Node, FFmpeg, or
  Chromium. No live Files API, token-SDK, template, screenshot, idle-timeout,
  concurrency, or injected-cleanup proof was performed in that CLI pass.
- The SDK package source confirms lifecycle, files, `ISOLATED` default, and
  separated streaming callbacks.
- The command above remains the live verification path for the updated 64 MiB
  default and optional environment-specific checks.

## Hard gate

The core SDK POC now passes, but do not begin the Daytona migration until the
remaining plan gates are verified: template/tool coverage
(Chromium/Playwright/FFmpeg), idle-timeout behavior or a bounded heartbeat,
capacity/concurrency, coverage with a simple fixture plus representative
previously failing benchmark repositories, and cleanup diagnostics for
injected failures at each provisioning stage. The optional private-DNS and
screenshot checks remain available but were not configured for the recorded
core run.
