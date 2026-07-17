# MakeADemo Benchmarking

Use this benchmark to measure how far submitted repos get through the MakeADemo Pipeline, how long each run takes, and which repos fail early versus late.

The runner starts every repo in the fixed benchmark suite concurrently. Each
completed run is recorded independently, and the summarizer reports every run's
duration together with the arithmetic mean, median, maximum duration, and
external Codex verification outcome.

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

The `codex` CLI must also be installed and authenticated. It runs a fresh,
ephemeral evaluator session for each final video; it does not resume or trust
the OpenCode session that generated the demo.

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
| `L0` | Repo Security Screen rejected the repo, or no trusted pipeline progress exists. |
| `L1` | Repo Preparation failed, including exhausting its validation or repair attempts. |
| `L2` | Repo Preparation succeeded, but Script Generation did not produce a Demo Script. |
| `L3` | Script Generation produced a Demo Script, but Capture Path Validation failed, including exhausting its repair attempts. |
| `L4` | Capture Path Validation succeeded, but Footage Capture or Compositing did not produce a final video. |
| `L5` | Compositing produced the final video artifact. |
| `L6` | An independent external Codex evaluator verified that final-video frames depict the submitted application at its pinned commit, contain no obvious broken visual artifacts, and pair overlay text with relevant footage. |

The level records the furthest trusted pipeline milestone, not whether the
process merely started a later stage. This keeps common bounded-retry failures
visible: Repo Preparation exhaustion lands at L1, while Capture Path Validation
exhaustion lands at L3. A later Footage Capture or Compositing failure remains
at L4 because the prepared app and generated capture path already passed their
validation gate.

L6 is machine-verified, not human-verified. The evaluator receives contact
sheets and sampled final-video frames, independently fetches the exact pinned
repository, and compares the frames with source-controlled UI components,
routes, styles, assets, tests, stories, and documentation screenshots. It also
checks for obvious blank/black frames, corrupt rendering, clipping, flicker,
overlap, unreadable text, broken transitions, frozen footage, and irrelevant
overlay/footage pairings. It ignores repository-provided agent rules and does
not execute submitted code on the benchmark host. A `rejected`, `incoherent`,
`inconclusive`, or evaluator `error` verdict is recorded in the result and
leaves the run at L5.

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
| `production` | Source repository for a deployed product with a real browser interface, rather than a tutorial, starter, template, or showcase app. |

## Current Suggested Bank

The fixed suite contains ten repos ordered by benchmark importance. Every entry
is the source repository for a deployed product with a browser interface, and
each SHA resolves to a tagged release rather than a moving default branch:

| Repo | Classification | Expected first-pass result |
| --- | --- | --- |
| `midday-ai/midday` | Next.js finance operations suite with auth, banking integrations, and background services | `L6` |
| `calcom/cal.diy` | Next.js scheduling product, monorepo, auth, database, and integration pressure | `L6` |
| `directus/directus` | Vue/Node content studio, SQL database, auth, and monorepo setup | `L6` |
| `mattermost/mattermost` | React/Go team collaboration platform with PostgreSQL and a very large codebase | `L6` |
| `TryGhost/Ghost` | Ember/Node publishing platform with authoring, memberships, themes, and persistence | `L6` |
| `ghostfolio/ghostfolio` | Angular/NestJS wealth-management product with database, cache, and market-data pressure | `L6` |
| `outline/outline` | React/Koa collaborative knowledge base with rich editing, auth, and persistence | `L6` |
| `twentyhq/twenty` | Large React/NestJS CRM with database and auth-heavy monorepo setup | `L6` |
| `excalidraw/excalidraw` | Canvas-heavy local-first production whiteboard | `L6` |
| `gchq/CyberChef` | Frontend-only JavaScript data-transformation utility and deterministic baseline | `L6` |

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
      external-verification/
        codex-verdict.json
      pipeline/
```

`benchmark-results.jsonl` is the durable result table. L5 runs include their
structured external verification verdict and artifact path. Token usage is
currently recorded as `null`; wire structured model usage into the agent/model
seam before using the benchmark for cost conclusions.

Child pipeline output is written to each run's `stdout.log` and `stderr.log`
instead of being echoed to the terminal. The runner redacts authorization header
values and standalone bearer credentials from those logs before recording the
run result.

## Next Instrumentation

The current backbone measures process-level runtime and inferred success level. The next useful additions are:

- Parse or emit structured token usage from Repo Preparation and Script Generation.
- Record per-stage duration from `PipelineObserver` output for whole-pipeline runs.
