# MakeADemo Project Overview

## Status

MakeADemo has been sunset. The repository is preserved as an exploration of long-horizon agent harnesses, isolated submitted-code execution, application preparation, browser automation, and automated demo-video production.

The project attempted to turn a submitted web application, its source code, and a product brief into a short product demo. Its most useful output is the set of explicit boundaries it developed between trusted orchestration, agent work, untrusted application code, browser capture, and durable Pipeline evidence.

For the shortest path to exercising those boundaries, use the backend benchmark documented in the [README](../README.md). The complete benchmark methodology is described in [Benchmarking](./benchmarking.md).

## System shape

MakeADemo is a single Bun and TypeScript package containing:

- A Vite and React frontend for Project Intake and demo requests.
- A Bun HTTP API serving application endpoints and the production frontend build.
- A background worker that processes queued Pipeline Jobs.
- A provider-neutral Pipeline interface used by controllers.
- An embedded Pi Agent Harness for the agent-driven Pipeline Stages.
- Daytona adapters for isolated preparation and submitted-code execution.
- Playwright-based validation and Footage Capture.
- Remotion-based video Compositing.
- Postgres persistence, Cloudflare R2 artifact storage, GitHub App integration, and optional Resend email delivery.

The frontend and API can run together during local product development. The backend benchmark instead invokes the Pipeline CLI directly and does not require the web application, persistence, or delivery services.

## MakeADemo Pipeline

The MakeADemo Pipeline is a linear flow with explicit artifacts and failure states:

1. **Context Gathering** records the repository, Pinned Source Revision, requested features, and normalized Supporting Documents.
2. **Repo Security Screen** performs static, read-only inspection before submitted code is allowed to execute. OSV-Scanner, GuardDog, and Semgrep provide advisory findings to a restricted security reviewer.
3. **Repo Preparation** asks an agent to understand the application and prepare a deterministic Demo Runtime in an ephemeral workspace. The result includes a Preparation Manifest, a structured mocking plan, and the actual workspace diff.
4. **Prepared Application Identity Review** independently checks that preparation preserved the submitted application's native interface instead of replacing it with a lookalike or simplified mock.
5. **Script Generation** produces a typed Demo Script describing setup, browser interactions, Scenes, and presentation metadata.
6. **Capture Path Validation** starts the prepared application and performs a fast, non-recording Playwright rehearsal of the generated interactions.
7. **Footage Capture** executes the accepted Demo Script from a fresh deterministic baseline and records Scene footage.
8. **Compositing** assembles captured footage, overlays, transitions, and audio into a final video, with an agent review loop for the Draft Composite.

Controllers depend on the small `MakeADemoPipeline` interface, which exposes `run` and `dispose`. Pipeline construction, stage dependencies, retained Agent Sessions, and Sandbox cleanup remain behind the production composition root.

## Runtime and trust boundaries

MakeADemo separates trusted orchestration from submitted application execution.

### Parent Preparation Workspace

The Pipeline creates a cold, unprivileged Daytona workspace and clones one pinned Git revision into it. Repo Security reads that clone without installing dependencies or executing repository code. If the security review rejects the repository, the parent is destroyed immediately.

After approval, the same parent becomes the Repo Preparation workspace. The preparation agent may inspect and edit `/workspace`, but it cannot modify the trusted image, access backend credentials, or authorize arbitrary host operations.

### Submitted-code Sandbox

Only after preparation does MakeADemo provision a separate submitted-code Sandbox for the detected project toolchain. Prepared files are synchronized into it, and submitted dependency installation, build commands, application runtime, validation, and capture execute there.

The submitted application runtime dynamically supports the repository's selected Node version and package manager: npm, pnpm, Yarn, or Bun. Package-manager commands are resolved centrally and honor the selected project root.

### MakeADemo Capture Runtime

Generated capture code does not inherit the submitted repository's package manager or `PATH`. MakeADemo compiles generated TypeScript to JavaScript and invokes it with an explicit, fixed Node and Playwright runtime owned by MakeADemo.

This capture runtime still runs inside submitted-code isolation so it can reach the local application, but its toolchain and dependencies remain separate from the application's toolchain.

### Agent Harness

Pi runs in the trusted backend process. Model credentials remain in backend memory and are never installed in Daytona. Agent filesystem and command tools delegate through provider-neutral workspace seams, while Stage Agent Tools are exposed only during their owning Pipeline Stage.

The Repo Security reviewer receives a narrower, read-only command surface. Repo Preparation can additionally load backend-bundled Trusted Preparation Playbooks for backend mocking, local authentication, and local database seeding. Repository-provided skills, prompts, agent instructions, extensions, and MCP configuration remain untrusted content rather than authority.

The development configuration leaves Daytona network access enabled. Secrets are still scrubbed from submitted build and runtime processes, and browser-level request interception records network evidence where supported.

## Repository layout

```text
src/app/                         React application and Context Gathering UI
src/server/api/                  Bun HTTP API
src/server/composition/          Production wiring, CLI, worker, and controllers
src/server/agent-harness/        Provider-neutral agent execution and tools
src/server/pipeline/             Pipeline Stages and orchestration
src/server/shared/               Persistence and external-service adapters
scripts/                         Benchmark and infrastructure verification CLIs
infra/daytona/                   Daytona image and submitted-toolchain assets
demo/                            Standalone local demo application
docs/adr/                        Architecture decisions
docs/prd/                        Product requirement documents
```

`CONTEXT.md` defines the project's domain vocabulary and relationships. The ADRs record the architectural decisions behind the Pipeline and its trust boundaries.

## Local application development

Install dependencies and create a local environment file:

```bash
bun install
cp .env.example .env
```

Run the frontend and API together:

```bash
bun run dev
```

The frontend runs at `http://localhost:5173`. The API runs at `http://localhost:8787`, and Vite proxies `/api/*` to the API during development.

Run them independently with:

```bash
bun run dev:web
bun run dev:api
```

Build and start the production application locally:

```bash
bun run build
bun run start
```

The production server handles `/api/*` routes and serves the built Vite frontend for browser routes.

## Environment configuration

### Web application and persistence

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST/DATABASE?sslmode=require
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=owlet
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_REDIRECT_URL=http://localhost:5173/github/callback
API_PORT=8787
```

After creating or changing the database schema, apply the Drizzle schema:

```bash
bun run db:migrate
```

For local development, register this same-origin GitHub App callback URL:

```text
http://localhost:5173/api/github/oauth-callback
```

Set the GitHub App setup URL to `GITHUB_REDIRECT_URL`. Public repositories can be submitted directly; private repositories use the GitHub App installation flow.

### Pipeline and agent execution

```bash
DAYTONA_API_KEY=
MAKEADEMO_DAYTONA_SNAPSHOT=makeademo-repo-preparation-general-20260731-rav3n
MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT=makeademo-submitted-code-general-20260731-rav3n
OPENAI_API_KEY=
REPO_PREPARATION_PROVIDER_ID=openai
REPO_PREPARATION_MODEL_ID=gpt-5.6-terra
```

`OPENAI_API_KEY` is read by the embedded Pi Agent Harness in the backend process and held in memory. It is not copied into the parent Preparation Workspace or submitted-code Sandbox.

### Optional final-video email

```bash
FINAL_VIDEO_EMAILS_ENABLED=false
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL="MakeADemo <demo@your-domain.com>"
PUBLIC_APP_BASE_URL=https://your-app-domain.com
```

Email delivery is disabled unless `FINAL_VIDEO_EMAILS_ENABLED` is `true` or `1`.

## External services

- **Postgres** stores makers, submitted projects, Context Gathering data, Pipeline requests, and job status.
- **Cloudflare R2** stores Supporting Documents and final demo videos. Supporting Documents use `uploads/{draftId}/...`; final videos use `demo-videos/{demoRequestId}/...`.
- **GitHub App** resolves repository metadata, reads source, and grants access to private repositories.
- **Daytona** provisions the parent Preparation Workspace and submitted-code Sandbox.
- **OpenAI** supplies the models used by the embedded Agent Harness.
- **Resend** optionally sends final-video notifications.

## Run one Pipeline Job directly

The interactive CLI prompts for repository and demo intent:

```bash
bun run pipeline:run
```

The non-interactive form requires a pinned commit:

```bash
bun run pipeline:run -- \
  --output-root .makeademo-full-pipeline-runs \
  --repo https://github.com/OWNER/REPO \
  --commit FULL_40_CHARACTER_GIT_SHA \
  --feature "Feature one" \
  --feature "Feature two" \
  --doc ./optional-notes.md
```

Each run writes a timestamped directory containing the terminal Pipeline result, Pipeline and Sandbox logs, Agent Harness audit logs, generated Demo Script, capture artifacts, Compositing manifests, and—on success—the final video.

```text
.makeademo-full-pipeline-runs/full-pipeline-<timestamp>/
  full-pipeline-result.json
  pipeline-log.jsonl
  sandbox-log.jsonl
  agent-audit-log.jsonl
  demo-script.json
  capture/
  composite/
    .../final-video.mp4
```

`full-pipeline-result.json` is written for terminal Pipeline failures as well as successes. `pipeline-log.jsonl` records high-level stage events, while the bounded Agent Harness audit artifacts record task, model, activity, and tool lifecycle metadata without persisting tool arguments or results.

## Background processing

The API persists demo requests, while the background worker claims and executes queued Pipeline Jobs:

```bash
bun run worker:demo-generation
```

The worker uses `DEMO_QUEUE_POLL_INTERVAL_MS` to control its polling interval. Set `DEMO_QUEUE_WORKER_ONCE=1` to process one polling cycle and exit.

## Railway deployment

The original deployment runs the frontend and backend as one Railway service:

```bash
bun run build
bun run start
```

Railway injects `PORT`; the API server uses it before falling back to `API_PORT`. The deployed shape consists of the Bun API and built Vite frontend in one application service plus Railway Postgres.

Useful operational commands:

```bash
railway up -y --detach -m "Deploy MakeADemo"
railway deployment list --json
railway service list --json
railway logs --lines 100 --json
```

Apply schema changes to the public Railway Postgres URL when required:

```bash
DATABASE_URL=<railway-postgres-public-url> bun run db:migrate
```

## Agent and infrastructure tooling

Repo-level agent skills are pinned in `skills-lock.json`; installed copies under `.agents/` are local generated state and are not committed. Restore them with:

```bash
npx skills experimental_install
```

Agent-facing CLI tools are tracked separately in `tools-lock.json`. Verify the pinned Railway CLI and installed Daytona CLI before infrastructure work:

```bash
bunx railway --version
daytona --version
```

## Standalone demo application

Run the small application under `demo/app` with:

```bash
bun run demo
```

Open `http://localhost:3000`. If Playwright's browser is missing, install Chromium with:

```bash
bunx playwright install chromium
```

## Quality checks

Run the repository checks before shipping changes:

```bash
bun run lint
bun run typecheck
bun run test
bun run knip
```
