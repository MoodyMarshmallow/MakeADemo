# MakeADemo

MakeADemo helps builders turn a runnable web app, codebase context, and product description into a short demo video.

The repo is a single Bun/TypeScript package with a Vite React frontend and a Bun API backend.

## Quick Start

Install dependencies:

```bash
bun install
```

Copy `.env.example` to `.env` and fill in the required values.

Run the frontend and backend together:

```bash
bun run dev
```

Open `http://localhost:5173`.

## Agent Skills

Agent skills are pinned in `skills-lock.json` but installed copies are not committed. `.agents/` is local generated state and is ignored by git.

Agent-facing CLI tools are tracked in `tools-lock.json`. Railway is installed through the pinned `@railway/cli` package in `package.json`/`bun.lock`; Daytona follows the latest GitHub release because it is not distributed as an npm CLI.

Restore the repo-level skills locally before using OpenCode in this repo:

```bash
npx skills experimental_install
```

Restart OpenCode after installation. The restored skills should take precedence over global skills with the same names; use global skills only when they are not duplicated by the repo lockfile.

Verify the tool versions before using infrastructure skills:

```bash
bunx railway --version
daytona --version
```

## App Commands

Run both frontend and backend in development:

```bash
bun run dev
```

Run them separately:

```bash
bun run dev:web
bun run dev:api
```

The frontend runs on `http://localhost:5173`. The API runs on `http://localhost:8787`, and Vite proxies `/api/*` to it.

Build and run the production app locally:

```bash
bun run build
bun run start
```

In production, `bun run start` runs `src/server/api/server.mts`. That server handles `/api/*` routes and serves the built frontend from `dist` for browser routes.

## Environment

Required for the web/API app:

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

Register the same-origin API callback URL as one of the GitHub App's callback
URLs. For local development, that callback URL is:

```text
http://localhost:5173/api/github/oauth-callback
```

Set the GitHub App setup URL to `GITHUB_REDIRECT_URL`. The GitHub connection
starts at the OAuth authorization URL with `redirect_uri` set to the API
callback URL; when GitHub returns an authorization `code`, MakeADemo exchanges
it for a user access token. If the user already has an installation, the API
redirects back to `GITHUB_REDIRECT_URL` with the connected installation. If no
installation is visible yet, the API redirects straight to the fresh install
URL, and GitHub returns through the app setup URL after installation.

Required for local full-pipeline runs:

```bash
DAYTONA_API_KEY=...
OPENAI_API_KEY=sk-...
```

The embedded Pi Agent Harness reads `OPENAI_API_KEY` in the backend process and
holds it in memory. It is not copied into Repo Preparation or submitted-code
Daytona workspaces.

Optional email settings:

```bash
FINAL_VIDEO_EMAILS_ENABLED=false
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL="MakeADemo <demo@your-domain.com>"
PUBLIC_APP_BASE_URL=https://your-app-domain.com
```

Apply the Drizzle schema after creating or changing the database:

```bash
bun run db:migrate
```

## External Services

Postgres stores makers, submitted projects, Context Gathering data, and demo request status.

Cloudflare R2 stores Supporting Documents and final demo videos. Supporting Documents are written under `uploads/{draftId}/...`; final videos should use `demo-videos/{demoRequestId}/...`.

The GitHub App needs repository metadata and contents read permissions. Public repos can be submitted by URL; private repos use the GitHub App installation flow.

Resend is optional. Email notifications are disabled unless `FINAL_VIDEO_EMAILS_ENABLED=true` or `FINAL_VIDEO_EMAILS_ENABLED=1`.

## Railway Deployment

Railway deploys the frontend and backend as one service:

```bash
bun run build
bun run start
```

Railway injects `PORT`; the API server uses `PORT` first and falls back to `API_PORT`.

Current deployed shape:

- App service: Bun API server plus built Vite frontend.
- Database service: Railway Postgres.
- Public app URL: `https://makeademo-production-3dbd.up.railway.app`.

Useful Railway commands:

```bash
railway up -y --detach -m "Deploy MakeADemo"
railway deployment list --json
railway service list --json
railway logs --lines 100 --json
```

Run migrations against Railway Postgres when the schema changes:

```bash
DATABASE_URL=<railway-postgres-public-url> bun run db:migrate
```

## Pipeline

The primary local pipeline command runs from repository intake through final video output:

1. Context Gathering
2. Repo Security Screen
3. Repo Preparation with the Agent Harness
4. Script Generation with the same Agent Session
5. Capture Path Validation
6. Footage Capture
7. Compositing and final output

Interactive run:

```bash
bun run pipeline:run
```

Non-interactive run:

```bash
bun run pipeline:run -- \
  --output-root .makeademo-full-pipeline-runs \
  --repo https://github.com/OWNER/REPO \
  --feature "Feature one" \
  --feature "Feature two" \
  --doc ./optional-notes.md
```

Optional flags:

```bash
--doc ./optional-notes.md
```

Pipeline runs require `DAYTONA_API_KEY` and `OPENAI_API_KEY`. The embedded Pi Agent Harness runs in the backend and delegates repository shell and filesystem tools to Daytona through the workspace seam. Its global tools provide anonymous Exa web research and Context7 library documentation; Pipeline Stage tools are exposed only during their owning stage. After preparation succeeds, Script Generation resumes the same opaque Agent Session so the model keeps the repo context it discovered while emitting only the capture-ready script artifact. Provider credentials remain in the backend process.

Each run writes a local run directory under `--output-root`:

```text
.makeademo-full-pipeline-runs/full-pipeline-<timestamp>/
  full-pipeline-result.json
  agent-audit-log.jsonl
  pipeline-log.jsonl
  script-generation-agent-audit-log.jsonl
  demo-script.json
  capture/capture/capture-manifest.json
  composite/composite/composite-manifest.json
  composite/composite/final-video.mp4
```

The CLI prints the final artifact paths when it completes:

```text
Full pipeline complete.
Final video: <path-to-final-video.mp4>
Generated script: <path-to-demo-script.json>
Capture manifest: <path-to-capture-manifest.json>
Composite manifest: <path-to-composite-manifest.json>
Log: <path-to-pipeline-log.jsonl>
Agent audit log: <path-to-agent-audit-log.jsonl>
Script Generation audit log: <path-to-script-generation-agent-audit-log.jsonl>
Result JSON: <path-to-full-pipeline-result.json>
```

`pipeline-log.jsonl` is the structured high-level pipeline event log. `agent-audit-log.jsonl` records bounded provider-neutral Agent Harness lifecycle metadata with timestamps: task stage, provider/model identifiers, output lengths, activity kinds, and tool names. It intentionally excludes assistant text, reasoning, tool arguments, and diagnostic contents. `script-generation-agent-audit-log.jsonl` contains the Script Generation and later shared-agent lifecycle evidence separately for debugging script quality and repair loops.

If the pipeline fails, `full-pipeline-result.json` is still written with failure status, failure details, and available log paths.

## Demo Tooling

Run the standalone demo app from `demo/app`:

```bash
bun run demo
```

Open `http://localhost:3000`.

Install Chromium if Playwright browsers are missing:

```bash
bunx playwright install chromium
```

Demo Script validation, Footage Capture, and Compositing are driven by the same `bun run pipeline:run` command as the rest of the pipeline; standalone capture and compositing CLIs are not public package scripts.

## Quality Checks

Run the project checks before shipping code changes:

```bash
bun run lint
bun run typecheck
bun run test
bun run knip
```
