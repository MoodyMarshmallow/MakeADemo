# MakeADemo

https://github.com/user-attachments/assets/09ed5cd3-548a-4124-9e75-0343e6b148e5

**This project has been sunset.**

*We learned a lot about what it takes to build performant harnesses for long-horizon tasks. However, I (Milo) decided that MakeADemo was trying to solve too many difficult problems simultaneously. It makes more sense to build several smaller projects that address those problems independently before attempting this again.*

MakeADemo turns a runnable web application, its source code, and a product brief into a short demo video.

## Tech stack

| Area | Technologies |
| --- | --- |
| Backend | TypeScript, Bun, TypeBox |
| Frontend | React, Vite, Tailwind CSS |
| Agent system | Pi Agent Harness, OpenAI models, Exa, Context7 |
| Sandboxing | Daytona |
| Security scanning | OSV-Scanner, GuardDog, Semgrep |
| Browser automation | Playwright, Chromium |
| Video production | Remotion, FFmpeg, FFprobe |
| Data and storage | PostgreSQL, Drizzle ORM, Cloudflare R2 |
| Integrations and deployment | GitHub App, Resend, Railway |
| Development tooling | Vitest, Biome, TypeScript compiler, Knip |

## Run the backend benchmark

The benchmark runs fixed, pinned repositories through the complete backend MakeADemo Pipeline using Daytona sandboxes and the embedded Pi Agent Harness. It does not require the frontend, API server, database, or background worker.

Install the project dependencies:

```bash
bun install
```

Copy the environment template:

```bash
cp .env.example .env
```

At minimum, configure these values in `.env`:

```bash
DAYTONA_API_KEY=...
OPENAI_API_KEY=...
MAKEADEMO_DAYTONA_SNAPSHOT=makeademo-repo-preparation-general-20260731-rav3n
MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT=makeademo-submitted-code-general-20260731-rav3n
```

The two snapshot values must name images available to the Daytona organization associated with the API key. Verify both images before starting a long run:

```bash
bun run verify:daytona-image
```

Run one repository as a smoke test:

```bash
bun run benchmark -- --concurrency 1 excalidraw
```

Run the complete ten-repository suite with bounded concurrency:

```bash
bun run benchmark -- --concurrency 3
```

You can select any subset of the fixed suite:

```bash
bun run benchmark -- --concurrency 2 midday directus cyberchef
```

Available repository IDs are `midday`, `calcom`, `directus`, `mattermost`, `ghost`, `ghostfolio`, `outline`, `twenty`, `excalidraw`, and `cyberchef`.

Runs are written beneath `.makeademo-benchmark-runs/`. Summarize an existing result file with:

```bash
bun scripts/summarize-benchmark.mts \
  .makeademo-benchmark-runs/<run>/benchmark-results.jsonl
```

Set `MAKEADEMO_BENCHMARK_TIMEOUT_MS` to a positive integer when a run needs a non-default per-job timeout. See [Benchmarking](./docs/benchmarking.md) for result semantics, success levels, timeout behavior, manual video verification, and the fixed suite design.

For a detailed description of the system, see the [MakeADemo project overview](./docs/project-overview.md).
