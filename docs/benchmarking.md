# MakeADemo Benchmarking

Use this benchmark to measure how far submitted repos get through the MakeADemo Pipeline, how long each run takes, and which repos fail early versus late.

The runner starts every repo in the fixed benchmark suite concurrently. Each
completed run is recorded independently, and the summarizer reports every run's
duration together with the arithmetic mean, median, and maximum duration.

## First Pass

Run the complete benchmark with no arguments:

```bash
bun run benchmark
```

The command prints individual, average, median, and maximum durations when it
finishes. To summarize an existing JSONL result file again:

```bash
bun scripts/summarize-benchmark.mts .makeademo-benchmark-runs/<run>/benchmark-results.jsonl
```

Required environment:

```bash
DAYTONA_API_KEY=...
OPENAI_API_KEY=...
```

MakeADemo creates or updates a Daytona secret from `OPENAI_API_KEY` before
creating Repo Preparation sandboxes. The benchmarked OpenCode process receives a
Daytona secret placeholder, not the plaintext local value.

Every benchmark runs the whole MakeADemo Pipeline, from Repo Security Screen
through Compositing. Repositories, commits, features, provider, and repetition
count are fixed in
`src/server/shared/benchmark/benchmark-suite.ts`; the command takes no suite
configuration arguments. The model is not overridden, so pipeline runs inherit
the normal CLI default.

Every repository has a full 40-character `commitSha`. The
security inspection and both Repo Preparation workspace views check out that
commit in detached-HEAD mode and verify the resulting `HEAD` before continuing.
The suite snapshot and each durable result retain the SHA used for the run.

## Success Levels

| Level | Meaning |
| --- | --- |
| `L0` | Repo rejected safely, Repo Preparation failed, or no trusted stage output exists. |
| `L1` | Repo Preparation produced enough output to reach Project Validation, but validation failed. |
| `L2` | Reserved for explicit Project Validation success when later pipeline work is skipped by a failure. |
| `L3` | Script Generation produced a Video Script Package. |
| `L4` | Footage Capture produced Scene artifacts. |
| `L5` | Compositing produced the final video artifact. |

## Repo Classes

Use categories to make failures explainable. The fixed suite includes:

| Class | Why it matters |
| --- | --- |
| `frontend` | Baseline browser app, usually easiest to prepare. |
| `fullstack` | Requires API/backend setup in addition to browser validation. |
| `monorepo` | Tests package-manager discovery and workspace command selection. |
| `database` | Tests seed data, migrations, and local service setup. |
| `auth` | Tests whether the preparer can create or bypass deterministic auth flows. |
| `external-services` | Tests Runtime Network Lockdown and mock generation. |
| `legacy` | Tests older dependency and build assumptions. |
| `large` | Tests clone, dependency install, and agent context pressure. |
| `hard` | Expected to fail or require a useful Preparation Fallback Prompt. |

## Current Suggested Bank

The fixed suite contains ten repos ordered by benchmark importance:

| Repo | Classification | Expected first-pass result |
| --- | --- | --- |
| `cypress-io/cypress-realworld-app` | Seeded React/Vite/Express payment app and deterministic baseline | `L5` |
| `epicweb-dev/epic-stack` | React Router full-stack notes app with local persistence and auth | `L5` |
| `calcom/cal.diy` | Scheduling SaaS, monorepo, auth/external-service pressure | `L5` |
| `directus/directus` | Vue/Node content studio, SQL database, auth, and monorepo setup | `L5` |
| `ghostfolio/ghostfolio` | Angular/NestJS finance app with database, cache, and market-data pressure | `L5` |
| `nuxt/movies` | Compact Nuxt/Vue app that requires deterministic TMDB data and images | `L5` |
| `sveltejs/realworld` | SvelteKit publishing app with CRUD, auth, routing, and pagination | `L5` |
| `satnaing/astro-paper` | Astro content site and low-complexity static baseline | `L5` |
| `twentyhq/twenty` | Large CRM, database/auth-heavy monorepo | `L5` |
| `excalidraw/excalidraw` | Canvas-heavy local-first whiteboard and capture-path stretch case | `L5` |

Adjust `expectedLevel` in `benchmark-suite.ts` when the benchmark hypothesis
changes. The expected level is not a claim that the repo definitely works.

## Result Files

Each run writes:

```text
.makeademo-benchmark-runs/
  benchmark-.../
    benchmark-manifest.snapshot.json
    benchmark-results.jsonl
    <repo-id>-r1/
      stdout.log
      stderr.log
      pipeline/
```

`benchmark-results.jsonl` is the durable result table. Token usage is currently recorded as `null`; wire structured model usage into the agent/model seam before using the benchmark for cost conclusions.

Child pipeline output is written to each run's `stdout.log` and `stderr.log`
instead of being echoed to the terminal. The runner redacts authorization header
values and standalone bearer credentials from those logs before recording the
run result.

## Next Instrumentation

The current backbone measures process-level runtime and inferred success level. The next useful additions are:

- Parse or emit structured token usage from Repo Preparation and Script Generation.
- Record per-stage duration from `PipelineObserver` output for whole-pipeline runs.
