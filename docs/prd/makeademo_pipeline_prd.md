# MakeADemo Pipeline PRD

## Problem Statement

Makers need a fast way to turn a JavaScript/TypeScript web app into the foundation of a demo video, but most repos are not immediately safe or deterministic enough for MakeADemo to run and capture. They may depend on secrets, hosted databases, external APIs, OAuth, remote assets, or manual setup. MakeADemo should automate as much repo preparation as possible without requesting write access to the maker's source repo or trusting agent-prepared output before deterministic validation.

Makers also need a clear way to provide enough product context for a useful demo without filling out a long production brief. MakeADemo should let the maker submit a repo link, structured demo intent, and Supporting Documents, then run the complete pipeline through repository screening, preparation, script generation, capture path validation, footage capture, compositing, and final delivery.

## Solution

The MakeADemo Pipeline starts with Context Gathering. The maker submits a GitHub repo URL, structured demo intent, and Supporting Documents. Supporting Documents are broad document uploads that exclude videos and pictures, and the upload UI should support drag-and-drop document intake with UploadThing. Supporting Documents are normalized into text artifacts before Repo Preparation begins.

MakeADemo clones the repo and runs a fast static Repo Security Screen before any agent or runtime preparation work begins. Repos that pass the static screen move into Repo Preparation, where a preparation agent works in a locked-down ephemeral cloud workspace. The agent first looks for existing demo setup, then reuses, adapts, or creates the smallest deterministic demo runtime it can. Repo Preparation produces a durable Preparation Manifest with the prepared demo command, local URL, workspace changes, mocks, assumptions, risks, and script-generation context. If Repo Preparation fails, MakeADemo returns a targeted Preparation Fallback Prompt for the maker and the maker's coding agent, and Script Generation does not run.

Project Validation validates the prepared ephemeral workspace using the Preparation Manifest. Dependency installation may use network access, then the sandbox network boundary is sealed. Validation is programmatic and LLM-free. Any inbound or outbound network communication across the sandbox boundary after dependency installation is a hard failure.

After Project Validation succeeds, MakeADemo generates a read-only Video Script Package organized into Script Sections and Scene Descriptions. Each Scene Description includes Browser Actions and records assumptions or capture risks for downstream capture and compositing.

Capture Path Validation proves the exact generated browser flow against the prepared runtime under Runtime Network Lockdown. Footage Capture then starts from fresh deterministic state and records the accepted Demo Script. Compositing assembles the captured Scenes into a Draft Composite, runs bounded quality review and repair, and stores the accepted final video for delivery.

## User Stories

1. As a maker, I want to submit a GitHub repo URL without preparing a demo command first, so that MakeADemo can do the setup work for me.
2. As a maker, I want to provide structured demo intent, so that MakeADemo understands what product value the demo should communicate.
3. As a maker, I want to upload Supporting Documents through drag-and-drop document intake, so that MakeADemo can use product docs, setup notes, and demo notes as context.
4. As a maker, I want Supporting Documents to accept document-like files but not videos or pictures, so that the intake scope stays focused.
5. As a maker, I want MakeADemo to statically screen my repo before agent work begins, so that obviously unsafe repos are rejected quickly.
6. As a maker, I want MakeADemo to look for existing demo setup before creating anything new, so that useful repo conventions are reused.
7. As a maker, I want MakeADemo to prepare a deterministic demo runtime in an ephemeral workspace, so that my source repo is not modified.
8. As a maker, I want the preparation agent to mock or seed data when possible, so that the prepared demo does not depend on external services.
9. As a maker, I want MakeADemo to return a targeted fallback prompt when preparation fails, so that my own coding agent can prepare the demo with the right context.
10. As a maker, I want the fallback prompt to include preparation blockers, assumptions, and suggested changes, so that I know what to fix.
11. As a maker, I want validation to avoid LLM API calls, so that validation remains cheap and repeatable.
12. As a maker, I want dependency installation to use the network when needed, so that normal JavaScript/TypeScript package installation works.
13. As a maker, I want demo runtime to be offline after dependency installation, so that demos do not depend on hosted services.
14. As a maker, I want validation to fail on external runtime requests, so that the generated demo is deterministic and safe to capture.
15. As a maker, I want validation to run in an isolated sandbox, so that untrusted submitted code is contained.
16. As a maker, I want Playwright validation to run inside the sandbox, so that browser checks do not require network access into the sandbox from the backend host.
17. As a maker, I want MakeADemo to infer the install command from standard lockfiles, so that I do not need to configure dependency installation.
18. As a maker, I want repos without lockfiles to be allowed with a warning, so that early projects can still be evaluated.
19. As a maker, I want validation to fail if no JavaScript/TypeScript package manifest exists, so that the product scope is clear.
20. As a maker, I want validation to confirm the prepared app loads in a browser, so that script generation is based on a reachable web app.
21. As a maker, I want validation to reject blank pages and framework error screens, so that later output is not based on broken footage.
22. As a maker, I want validation to capture screenshot proof, so that I can see what MakeADemo was able to load.
23. As a maker, I want validation logs and failure reasons, so that I can understand why the prepared workspace failed.
24. As a maker, I want MakeADemo to generate a Video Script only after validation succeeds, so that the script is grounded in a runnable app.
25. As a maker, I want the Video Script to be organized into Script Sections, so that the structure of the demo is easy to understand.
26. As a maker, I want each Script Section to contain Scene Descriptions, so that I can see the sequence of the demo.
27. As a maker, I want each Scene Description to summarize one web-based scene, so that I understand what downstream footage capture should show.
28. As a maker, I want each Scene Description to include Browser Actions, so that I can understand how MakeADemo intends to interact with the app.
29. As a maker, I want each Browser Action to be readable, so that I can audit the intended clicks, typing, and waits.
30. As a maker, I want MakeADemo to capture the accepted Demo Script from fresh deterministic state, so that validation cannot pollute the recorded take.
31. As a maker, I want MakeADemo to composite and review the captured Scenes before delivery, so that every successful Pipeline Job produces a usable final video.
32. As a MakeADemo operator, I want submitted repos to be JavaScript/TypeScript web apps in V1, so that sandbox images, install inference, and validation behavior stay tractable.
33. As a MakeADemo operator, I want the Demo Run Contract to forbid secrets and external services, so that validation and capture do not depend on user-specific infrastructure.
34. As a MakeADemo operator, I want artifacts to be copied out after sandbox execution rather than fetched over the network during runtime, so that runtime isolation is preserved.
35. As a MakeADemo operator, I want Repo Preparation artifacts to be durable, so that MakeADemo can support analytics, debugging, reruns, fallback prompts, and future product features.
36. As a MakeADemo operator, I want validation failures to be explicit and structured, so that they can drive helpful user-facing messages and future issue triage.

## Implementation Decisions

- Build product modules around the MakeADemo Pipeline stages rather than around infrastructure capabilities.
- Pipeline modules should be ordered as Context Gathering, Repo Security Screen, Repo Preparation, Script Generation, Capture Path Validation, Footage Capture, Compositing, and final output.
- Context Gathering collects the GitHub repo URL, structured demo intent, and Supporting Documents.
- Supporting Documents are broad document uploads, excluding videos and pictures.
- UploadThing should power drag-and-drop Supporting Document intake.
- Supporting Documents should be normalized into text artifacts before Repo Preparation begins.
- Repo Security Screen runs after repo clone and before any agent or runtime preparation work.
- Repo Security Screen is static-only, fast, deterministic, and does not install dependencies or execute submitted repo code.
- Repo Security Screen warns, rather than rejects, when repo size or file count may prevent the agent from fully exploring the project and may degrade demo quality.
- Repo Preparation runs after Repo Security Screen in a locked-down ephemeral cloud workspace.
- Repo Preparation first checks for existing demo setup before creating a new demo runtime.
- Repo Preparation may edit and execute the ephemeral workspace, but it does not modify the maker's source repo.
- Repo Preparation may use controlled network access for setup and research, but the prepared app runtime must run without external network access after setup.
- Repo Preparation should expose a runtime network lockdown tool/check to the agent; if the app runtime attempts external network communication, the tool returns a structured failure so the agent can mock or remove the dependency and retry.
- Repo Preparation produces a durable Preparation Manifest as the source of truth for validation command and URL.
- The Preparation Manifest records prepared command, local URL, existing demo evidence, workspace changes, mocks, assumptions, risks, and script-generation context.
- The minimum required Preparation Manifest fields are workspace ID, repo URL, prepared demo command, local URL, preparation status, setup summary, diff artifact ID, assumptions, and risks.
- If Repo Preparation fails, MakeADemo returns a targeted Preparation Fallback Prompt and does not run Script Generation.
- The Demo Run Contract requires a deterministic browser-accessible demo inside an isolated sandbox.
- Dependency installation may use network access.
- After dependency installation, all inbound and outbound communication across the sandbox boundary is blocked and treated as a hard validation failure.
- Project Validation is programmatic and does not use LLM API calls.
- Project Validation runs in backend Daytona sandboxes, not in the web server process, the maker's browser, Docker-specific infrastructure, or a local-only CLI architecture.
- Playwright validation runs inside the Sandbox rather than from the backend host.
- Artifacts such as screenshots, logs, normalized documents, preparation manifests, diffs, and Video Script Packages are stored as pipeline artifacts.
- V1 supports JavaScript/TypeScript web apps with `package.json` and standard JS package managers.
- Dependency installation is inferred from lockfiles: Bun, pnpm, Yarn, npm lockfile, then npm fallback.
- Repos without lockfiles are allowed with a validation warning rather than rejected.
- Project Validation must confirm that the prepared local URL loads in a browser, is not blank, avoids obvious runtime/framework error screens, and is interactable enough for browser capture.
- Project Validation validates the prepared ephemeral workspace using the Preparation Manifest.
- Script Generation runs only after Project Validation succeeds.
- The Demo Script is an internal pipeline handoff rather than a terminal product result.
- A Video Script contains Script Sections.
- A Script Section contains Scene Descriptions.
- Each Scene Description contains Browser Actions and is structured to map to exactly one Scene during Footage Capture.
- Footage Capture starts from fresh deterministic app state and preserves state across Scenes in the accepted Demo Script.
- Compositing produces a Draft Composite, runs bounded quality review, and stores the accepted final video.
- Deep modules to build include Project Intake, Supporting Document Intake, Supporting Document Normalizer, Repo Security Screen, Repo Preparation, Preparation Manifest, Preparation Fallback Prompt Generator, Install Plan inference, Sandbox Runner, Network Isolation Policy, Capture Path Validation, Browser Validation, Artifact Store, Script Generator, Footage Capture, Compositing, and Pipeline Job Orchestrator.
- Preparation Fallback Prompt Generator should expose a simple interface that returns a targeted prompt from preparation blockers, assumptions, and recommended changes.
- Preparation Manifest should expose a validation boundary for reading and validating the prepared demo command and URL.
- Install Plan inference should expose a simple repo-inspection interface that returns the install command and warnings.
- Sandbox Runner should encapsulate clone/install/runtime isolation/artifact extraction behind a small job interface.
- Network Isolation Policy should make runtime network blocking explicit and testable.
- Project Validation should return structured success/failure results, logs, warnings, screenshots, and blocked network attempts.
- Browser Validation should encapsulate Playwright page-load, blank-page, runtime-error, screenshot, and interactability checks.
- Script Generator should consume validated project context, structured demo intent, normalized Supporting Documents, and Preparation Manifest context and return a structured Video Script Package.
- Pipeline Job Orchestrator should coordinate the linear flow without owning the implementation details of each deep module.

## Testing Decisions

- Tests should verify external behavior through public interfaces and real seams, not private implementation details.
- Good tests should describe observable outcomes such as intake validation, Supporting Document normalization, Repo Security Screen rejects and warnings, Repo Preparation success/failure, Preparation Manifest validation, fallback prompts, validation failures, and produced script structures.
- Supporting Document Intake should be tested for accepting document-like uploads while rejecting videos and pictures.
- Supporting Document Normalizer should be tested for producing normalized text artifacts with source metadata.
- Repo Security Screen should be tested for hard rejects on obviously unsafe repos and warnings for large repos, missing lockfiles, external-service SDKs, auth packages, native dependencies, postinstall scripts, shell scripts, and other non-fatal risks.
- Repo Preparation should be tested with fake agent/workspace adapters that simulate existing demo reuse, existing demo adaptation, new demo creation, runtime network lockdown failures, successful retry after mocking, and structured preparation failure.
- Preparation Manifest schema/loader should be tested for required command, URL, status, setup summary, diff artifact ID, assumptions, and risks.
- Preparation Fallback Prompt Generator should be tested for including blockers, assumptions, suggested changes, and enough context for the maker's coding agent.
- Install Plan inference should be tested across Bun, pnpm, Yarn, npm lockfile, and package-only fallback cases.
- Project Validation should be tested with fake sandbox adapters that simulate install success, install failure, command failure, page-load failure, blocked network attempts, blank pages, runtime error pages, and successful validation.
- Network Isolation Policy should be tested as a pure boundary decision where any post-install sandbox-boundary network attempt fails validation.
- Browser Validation should be tested with Playwright-style fakes or integration fixtures that prove the validator distinguishes reachable pages, blank pages, and obvious framework/runtime errors.
- Artifact Store should be tested through public artifact write/read/list behavior for normalized documents, preparation manifests, diffs, logs, screenshots, and Video Script Packages.
- Script Generator should be tested for producing Video Script Packages organized into Script Sections and Scene Descriptions from structured demo intent, normalized Supporting Documents, Preparation Manifest context, and validated project context.
- Pipeline Job Orchestrator should be tested through an integration-style happy path and representative failure paths, using fakes at external seams rather than mocking internal functions.
- Whole-pipeline tests should follow the integration-through-public-interface style and verify observable outcomes through product seams rather than private implementation details.

## Out of Scope

- Non-JavaScript/TypeScript repos.
- Mobile apps, desktop apps, API-only projects, and CLI-only projects.
- Voiceover videos.
- Directly modifying maker repos, creating branches, opening pull requests, or committing fixes on behalf of users.
- LLM-based validation of repo runnability.
- Images, videos, and other non-document Supporting Document uploads.
- External APIs, hosted databases, OAuth, paid services, secrets, or manual setup during demo runtime.
- Script editing by the user.
- Fine-grained user control over Playwright Capture Scripts.
- Multiple autonomous capture sub-agents.
- Fine-grained timeline editing by the user.
- Supporting arbitrary package manager or language runtime installation beyond standard JavaScript/TypeScript package manager inference.

## Further Notes

- This PRD follows ADRs 0005 through 0012 and the current MakeADemo glossary.
- The initial buildout should remain stage-first while extracting deep capability modules behind small interfaces.
- The agent-prepared ephemeral workspace flow is central: MakeADemo should automate repo preparation without modifying the maker's source repo.
- Repo Security Screen is a fast static pre-agent filter, not a full security verifier.
- Project Validation is the non-agent trust gate before Script Generation output is trusted.
- The durable Preparation Manifest replaces MakeADemo Config as the source of truth for prepared demo command and local URL.
- A successful Pipeline Job produces a reviewed final video rather than stopping at an intermediate script or capture artifact.
