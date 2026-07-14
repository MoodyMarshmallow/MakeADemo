# Goal

A website that:

- Takes in your codebase and a description of what your product video is   
- Makes a video demo of it automatically

## V1 Scope

- Target users: hackathon participants and early founders making small projects
- Supported projects: browser-accessible JavaScript/TypeScript web apps only
- Output: a short text-led demo video using captured product footage, display text, and generic background music
- Not in v1: voiceover videos, CLI tools, mobile apps, desktop apps, and API-only projects

# The Architecture

## Linear Pipeline

Needs to accept:

- GitHub repo URL
- Demo run command, such as `npm run demo`
- Key product features to demo

Output: A demo video that cover—
- What the product does  
- The main differentiating features of the product
- Display text instead of narration
- Background music from a generic library

Repo execution contract:
- The submitted repo should expose a dedicated demo run command, such as `npm run demo`
- The submitted repo should include a tiny `makeademo.config.json` declaring only the demo command and local URL
- The demo run command should start the app in a deterministic demo mode
- Dependency installation may use the network
- Demo mode should run without runtime network access, external APIs, external databases, environment files, secrets, paid services, OAuth, or manual setup
- After dependency installation, any inbound or outbound network communication across the sandbox boundary is a hard validation failure
- Demo data should be seeded or mocked automatically
- If the repo does not satisfy this contract, MakeADemo should provide a copy-paste preparation prompt for the maker to use with their own coding agent
- MakeADemo should not directly modify the maker's repo in v1

–
- Typescript monorepo  
- Tanstack start (starter, basically nextjs+template but not nextjs)  
- Deployed on Railway (better Vercel)

### Backend

- BetterAuth (if we need auth) (optional)
- Tanstack db (if we need better load times) (optional)
- ElectricSQL (just for better sql, if we need it)(optional)
- Drizzle ORM (better prisma)  
- HonoAPI (for frontend-backend comms)
- Postgres  
- Cloudflare R2 storage (better AWS S3)  
- Pino (dead simple observability logging)

Execution capabilities:

- Daytona sandbox  
- PreMotion  
- Playwright
- Repo validation should run as a backend job in an isolated Daytona sandbox

### Frontend

- Tailwind CSS  
- React  
- UploadThing

# Whole Pipeline Buildout

The product has one linear workflow. The detailed contract lives in
`docs/prd/makeademo_pipeline_prd.md`.

Goal: accept a JavaScript/TypeScript web app and demo intent, prepare and
validate a deterministic runtime, generate a Demo Script, capture the required
Scenes, and composite a polished final video in one Pipeline Job.

## Modules to build or extend

- Project Intake: captures the GitHub repo URL, Supporting Documents, and key product features to demo.
- Repo Security Screen: rejects obvious repository risks before agent or runtime work begins.
- Repo Preparation: prepares a deterministic demo runtime in an ephemeral workspace without modifying the maker's repo.
- Preparation Fallback Prompt Generator: explains blockers when the repo cannot be prepared automatically.
- Sandbox Runner: clones the repo, installs dependencies, seals the runtime network boundary, runs the demo command, and extracts artifacts.
- Capture Path Validation: proves the prepared app and generated Demo Script can complete the intended browser flow under Runtime Network Lockdown.
- Script Generator: produces the Demo Script from product intent and prepared repo context.
- Footage Capture: records presentation-ready Scene footage from a fresh deterministic app state.
- Draft Composite Reviewer: checks narrative, timing, presentation, and capture quality before final acceptance.
- Compositor: assembles Scenes, display text, transitions, effects, and background music into the final video.
- Artifact Store: stores logs, validation evidence, scripts, captured footage, render plans, and final video artifacts.
- Pipeline Job Orchestrator: coordinates the complete linear flow without owning each module's internal behavior.

## User flow

### 1. Gather Context

- The maker provides a GitHub repo URL, Supporting Documents, and the product features the demo should communicate.
- MakeADemo normalizes those inputs into Project Intake.

### 2. Screen and Prepare the Repository

- MakeADemo runs the deterministic Repo Security Screen.
- Repo Preparation reuses or creates the smallest deterministic demo runtime in an ephemeral workspace.
- If preparation fails, MakeADemo returns a targeted Preparation Fallback Prompt and stops the Pipeline Job.

### 3. Generate and Validate the Demo Script

- MakeADemo generates a Demo Script grounded in the prepared runtime and requested features.
- Capture Path Validation runs the exact browser flow under Runtime Network Lockdown.
- Repair attempts may update the prepared workspace or Demo Script, but the full validation gate reruns before capture.

### 4. Capture Footage

- MakeADemo resets the prepared app to a fresh deterministic state.
- Footage Capture records the accepted Demo Script as one continuous flow with explicit Scene boundaries.

### 5. Composite and Review

- MakeADemo assembles the captured Scenes into a text-led demo with transitions, effects, and background music.
- Draft Composite review checks the complete video and may trigger bounded repair and recapture work.

### 6. Deliver the Final Video

- MakeADemo stores the final video and supporting artifacts.
- The maker receives a view or download URL for the completed demo.

## Future Enhancements

- Timeline editing for scene order, trims, captions, and timing.
- Additional transition, effect, music, and theme presets.
- Faster render previews and multiple export quality profiles.
- Selective regeneration of affected Scenes after user edits.

## Later Possibilities

- Support non-JavaScript/TypeScript web apps.
- Support richer uploaded source material such as pitch decks and product videos.
- Support voiceover generation.
- Support direct GitHub PR creation for demo run command preparation.
- Support team workspaces, saved projects, and multiple generated versions.
- Support a library of reusable demo themes and music beds.
