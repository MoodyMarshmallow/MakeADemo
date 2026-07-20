# Capture Path Validation PRD

## Problem Statement

MakeADemo currently treats Repo Preparation and Script Generation as sequential work, with Project Validation proving only that the prepared app can start, load in a browser, and avoid runtime network access. That is not the actual product invariant. The product only needs the generated capture path to run against the prepared app under Runtime Network Lockdown.

The current separation creates two problems. First, Repo Preparation can spend effort trying to make the whole repo generally watertight even though only the eventual Browser Actions or Capture Scripts need to run offline. Second, Script Generation can produce a plausible Video Script Package after generic validation, but the specific capture path may still fail because of missing seeded state, bad selectors, timing issues, routes that were not prepared, or runtime network calls triggered only by the scripted flow.

MakeADemo needs a single non-agent validation gate that proves the prepared app and generated Video Script Package work together before Footage Capture begins, while still preserving clear stage contracts, backend-controlled trust boundaries, and fast validation.

## Solution

MakeADemo will replace standalone pre-script Project Validation in the main script-driven flow with Capture Path Validation. Capture Path Validation is a deterministic dry-run validation stage that runs project-level checks and then runs the generated Browser Actions or Capture Scripts against the prepared app under Runtime Network Lockdown.

Repo Preparation and Script Generation may run through one long-lived Agent Session with staged backend prompts. The session can prepare the repo, generate the Video Script Package, receive structured Capture Path Validation failures, and repair either the prepared workspace or the Video Script Package. The stage contracts remain separate: Repo Preparation still produces a Preparation Manifest, Script Generation still produces a Video Script Package, and Capture Path Validation remains a backend-owned non-agent gate.

Capture Path Validation will be a dry run. It should skip presentation-oriented behavior such as human-like typing, visible cursor movement, and recording-specific pauses so validation stays fast and deterministic. Footage Capture will run after Capture Path Validation succeeds and will start from fresh deterministic app state, using the accepted Video Script Package to record final Scenes with the slower presentation-oriented browser behavior.

If Capture Path Validation fails, the backend returns structured failure feedback to the same agent and allows repair attempts. The repair budget defaults to a small bounded value and is configurable through `MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS`. Every repair retry must rerun the full Capture Path Validation stage from the beginning, including project-level checks and capture-path checks. If the repair budget is exhausted, the Pipeline Job fails and tells the user to report the issue to MakeADemo rather than returning a partially trusted Video Script Package or a Preparation Fallback Prompt.

## User Stories

1. As a maker, I want MakeADemo to validate the actual generated demo path, so that the final video is based on interactions that really work.
2. As a maker, I want MakeADemo to avoid requiring the entire repo to be perfectly offline, so that preparation can focus on the specific demo path that will be captured.
3. As a maker, I want MakeADemo to run the generated Browser Actions before recording final footage, so that broken selectors or missing UI state are caught before Footage Capture.
4. As a maker, I want MakeADemo to detect runtime network calls triggered by scripted interactions, so that the demo does not depend on external services during capture.
5. As a maker, I want MakeADemo to repair capture-path failures automatically when possible, so that I do not need to manually debug Playwright scripts.
6. As a maker, I want MakeADemo to keep my source repo unchanged while repairing the prepared workspace, so that automated fixes remain isolated.
7. As a maker, I want MakeADemo to fail clearly if it cannot validate the capture path, so that I know the issue should be reported to MakeADemo rather than trusting partial output.
8. As a maker, I want final Footage Capture to start from clean app state, so that the dry run does not pollute the recorded demo.
9. As a maker, I want final Footage Capture to preserve polished cursor movement and human-like typing, so that the final demo looks intentional even though validation is fast.
10. As a maker, I want validation to be faster than recording final footage, so that repair loops do not spend unnecessary time on presentation effects.
11. As a maker, I want Capture Path Validation to produce useful internal evidence when it fails, so that MakeADemo can diagnose and improve the pipeline.
12. As a maker, I want MakeADemo to avoid returning a Video Script Package that has not passed Capture Path Validation, so that downstream capture does not treat untrusted scripts as ready.
13. As a maker, I want validation to account for project-level failures such as app startup failure, blank pages, and framework errors, so that basic runtime problems are still caught.
14. As a maker, I want validation to account for script-level failures such as missing buttons, failed waits, bad routes, and wrong test data, so that the actual demo path is proven.
15. As a maker, I want MakeADemo to use the same prepared app contract for validation and capture, so that the final recording is grounded in the same Preparation Manifest.
16. As a MakeADemo operator, I want one non-agent validation gate for script-driven runs, so that trust decisions are easier to reason about.
17. As a MakeADemo operator, I want Capture Path Validation to subsume project-level checks, so that we avoid validating generic app interactivity separately from the real capture path.
18. As a MakeADemo operator, I want Repo Preparation and Script Generation to remain separate stage contracts, so that artifacts stay durable and auditable.
19. As a MakeADemo operator, I want one long-lived Agent Session across Repo Preparation, Script Generation, and repair prompts, so that context is preserved without coordinating multiple agents.
20. As a MakeADemo operator, I want the backend validator to remain authoritative, so that agent-written scripts and workspace changes are not trusted without deterministic checks.
21. As a MakeADemo operator, I want the agent to repair either workspace or script failures, so that both seeded data problems and script interaction problems are addressable.
22. As a MakeADemo operator, I want every repair retry to rerun all Capture Path Validation checks, so that a workspace or script repair cannot bypass project-level safety checks.
23. As a MakeADemo operator, I want the repair budget to be configurable with `MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS`, so that deployments can tune cost and latency without code changes.
24. As a MakeADemo operator, I want exhausted repair attempts to produce an internal failure with logs and artifacts, so that the team can debug pipeline reliability.
25. As a MakeADemo operator, I want exhausted repair attempts to show the user a report-this-to-us message, so that users do not receive misleading self-service preparation advice for a pipeline failure.
26. As a MakeADemo operator, I want Runtime Network Lockdown enforced during Capture Path Validation, so that scripted interactions cannot reach external services.
27. As a MakeADemo operator, I want submitted app runtime commands to run with scrubbed environments, so that agent secrets are not exposed during validation or capture.
28. As a MakeADemo operator, I want validation and capture to run in backend Sandboxes, so that untrusted app code and Playwright automation remain isolated from the backend host.
29. As a MakeADemo operator, I want validation dry runs to skip recording-oriented delays, so that the repair loop remains practical for real repos.
30. As a MakeADemo operator, I want Footage Capture to use fresh deterministic state after validation succeeds, so that the final recording is not affected by dry-run mutations.
31. As a MakeADemo operator, I want validation failure evidence to identify the failed scene and browser action when possible, so that repair prompts can be specific.
32. As a MakeADemo operator, I want validation failure evidence to include runtime network attempts, so that the agent can mock or remove external dependencies.
33. As a MakeADemo operator, I want validation failure evidence to include app logs and browser logs, so that startup, runtime, and interaction failures can be distinguished.
34. As a MakeADemo operator, I want validation failure evidence to include screenshots when useful, so that visual states can be debugged without rerunning the job.
35. As a MakeADemo operator, I want the accepted Video Script Package to be stored only after Capture Path Validation succeeds, so that persisted script artifacts represent capture-ready output.
36. As a MakeADemo operator, I want script-generation resume artifacts to account for the new fused validation flow, so that operators can inspect or resume runs consistently.
37. As a MakeADemo operator, I want the full pipeline result to distinguish capture-path validation failure from repo preparation failure, so that analytics and support can track the right failure mode.
38. As a MakeADemo operator, I want Capture Path Validation to share infrastructure seams with Footage Capture where possible, so that browser automation behavior remains consistent.
39. As a MakeADemo operator, I want validation-specific browser execution to differ from recording-specific browser execution, so that speed and final video quality can be optimized independently.
40. As a MakeADemo operator, I want the old standalone Project Validation code paths to be either folded into Capture Path Validation or retained only as diagnostics, so that the main pipeline does not duplicate validation work.

## Implementation Decisions

- The MakeADemo Pipeline for script-driven runs should be ordered as Context Gathering, Repo Security Screen, Repo Preparation, Script Generation, Capture Path Validation, Footage Capture, Compositing, and final output.
- Project Validation should no longer be a standalone stage before Script Generation in the main script-driven flow.
- Project-level checks should move inside Capture Path Validation as preflight checks.
- Project-level checks should still verify app startup, browser load, obvious fatal runtime states, browser interactability, and Runtime Network Lockdown.
- Capture Path Validation should then run the generated Browser Actions or Capture Scripts from the Video Script Package against the prepared app.
- Capture Path Validation should run under Runtime Network Lockdown.
- Capture Path Validation should run in a Sandbox rather than from the backend host.
- Capture Path Validation should be backend-owned and deterministic; LLM calls should not decide whether validation succeeds.
- Repo Preparation and Script Generation may use one long-lived Agent Session with staged backend prompts.
- Repo Preparation and Script Generation should remain separate stage contracts even when they share an Agent Session.
- Repo Preparation should still produce a Preparation Manifest.
- Script Generation should still produce a Video Script Package.
- Capture Path Validation should produce validation evidence and an accepted or failed result.
- The backend validator remains authoritative over whether a Video Script Package is accepted for Footage Capture.
- If Capture Path Validation fails, the backend may send structured failure feedback to the same Agent Session.
- The agent may repair the prepared workspace, the Video Script Package, or both after Capture Path Validation failure.
- Every repair attempt must rerun the complete Capture Path Validation stage from the beginning.
- The repair budget should be configurable through `MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS`.
- The default repair budget should be small and bounded; the environment variable should only tune the bound, not remove validation.
- If the repair budget is exhausted, the Pipeline Job should fail.
- Exhausted repair attempts should tell the user to report the issue to MakeADemo.
- Exhausted repair attempts should not return a partially trusted Video Script Package.
- Exhausted repair attempts should not return a Preparation Fallback Prompt, because preparation and script generation already happened and the remaining failure is a pipeline validation failure.
- Capture Path Validation should be a dry run and should not produce final raw Scene footage.
- Capture Path Validation should skip human-like typing, cursor movement, and recording-specific pauses unless those behaviors are required to prove correctness.
- Footage Capture should run after Capture Path Validation succeeds.
- Footage Capture should start from fresh deterministic app state after Capture Path Validation succeeds.
- Footage Capture should record final Scenes separately with presentation-oriented browser behavior.
- The same accepted Video Script Package should drive Capture Path Validation and Footage Capture.
- Validation and capture should use the same prepared workspace artifacts, but not the same live mutated app runtime.
- Capture Path Validation failure evidence should be structured enough for repair prompts.
- Failure evidence should identify the failed project-level check, scene, Browser Action, Capture Script step, or network attempt where possible.
- Failure evidence should include app logs, browser logs, blocked network attempts, screenshots or visual evidence when useful, and retry attempt metadata.
- Pipeline observability should record Capture Path Validation started, failed, repaired, retried, exhausted, and succeeded events.
- Full pipeline result artifacts should include Capture Path Validation evidence on success and failure.
- Existing Project Validation adapters and browser validation behavior should be reused inside Capture Path Validation where they remain valuable.
- Existing Footage Capture script preparation should support a fast validation mode and a presentation recording mode.
- The fast validation mode should prove action correctness without applying recording-only stylization.
- The presentation recording mode should retain human-like typing, cursor movement, and pauses for final footage.
- The pipeline should avoid running the old standalone Project Validation stage and then Capture Path Validation as separate gates in the main flow.
- Standalone Project Validation may remain as a diagnostic or legacy helper if useful, but it should not be the main trust gate for script-driven runs.
- The Preparation Manifest remains the source of truth for prepared command, local URL, workspace changes, mocks, assumptions, risks, and context for later script and capture stages.
- The Video Script Package remains the handoff artifact from Script Generation into Capture Path Validation and Footage Capture.

## Testing Decisions

- Tests should verify behavior through public pipeline seams and external interfaces rather than private implementation details.
- The highest-value tests should exercise the pipeline orchestration from successful Repo Preparation and Script Generation through Capture Path Validation, repair, and Footage Capture handoff.
- Capture Path Validation should be tested with fakes for sandbox execution, browser automation, network attempts, and recorder behavior.
- Tests should prove that project-level app startup and browser checks run inside Capture Path Validation before generated capture actions run.
- Tests should prove that Runtime Network Lockdown failures during project-level checks fail Capture Path Validation.
- Tests should prove that Runtime Network Lockdown failures during generated Browser Actions fail Capture Path Validation.
- Tests should prove that malformed or non-capture-ready Video Script Packages fail before Footage Capture begins.
- Tests should prove that a successful Capture Path Validation result is required before Footage Capture runs.
- Tests should prove that Footage Capture does not run after Capture Path Validation failure.
- Tests should prove that the same agent session receives structured failure feedback after Capture Path Validation failure.
- Tests should prove that the agent may repair the workspace and rerun Capture Path Validation.
- Tests should prove that the agent may repair the Video Script Package and rerun Capture Path Validation.
- Tests should prove that every repair attempt reruns project-level checks and capture-path checks, not only the failed browser action.
- Tests should prove that `MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS` controls the retry budget.
- Tests should prove that exhausted repair attempts fail the Pipeline Job.
- Tests should prove that exhausted repair attempts produce the user-facing report-this-to-us failure rather than a Preparation Fallback Prompt.
- Tests should prove that exhausted repair attempts do not return or persist a capture-ready Video Script Package.
- Tests should prove that Capture Path Validation uses fast dry-run behavior rather than presentation-oriented Footage Capture behavior.
- Tests should prove that Footage Capture starts from fresh deterministic app state after Capture Path Validation succeeds.
- Tests should prove that dry-run state mutations do not leak into final Footage Capture state.
- Tests should prove that validation and capture can share prepared workspace artifacts without sharing one live runtime.
- Tests should cover action-level validation failures such as missing selectors, failed waits, unexpected navigation, and missing seeded data.
- Tests should cover project-level validation failures such as command failure, blank page, framework error screen, and non-interactable page.
- Tests should cover failure evidence shape through public result objects or artifact records.
- Tests should cover observability events for validation start, validation failure, repair attempt, retry, exhausted failure, and validation success.
- Existing Project Validation and Browser Validation tests should be reused or migrated so their behavior is preserved inside Capture Path Validation.
- Existing Footage Capture tests should be extended so fast validation mode and presentation recording mode do not regress each other.
- Integration-style pipeline tests should cover the happy path from Script Generation through Capture Path Validation into Footage Capture and Compositing.
- Integration-style pipeline tests should cover repair success after the first validation failure.
- Integration-style pipeline tests should cover repair budget exhaustion.

## Out of Scope

- Replacing Repo Security Screen.
- Removing Runtime Network Lockdown.
- Trusting agent-prepared workspace changes without backend validation.
- Trusting agent-generated Video Script Packages without backend validation.
- Returning partial Video Script Packages as capture-ready output after validation failure.
- Returning Preparation Fallback Prompt after Capture Path Validation repair exhaustion.
- Producing final Scene videos during Capture Path Validation.
- Using human-like typing, cursor movement, or recording-specific pauses during validation unless required for correctness.
- Sharing one live app runtime between Capture Path Validation and Footage Capture.
- Creating a two-agent feedback loop between Repo Preparation and Script Generation.
- Adding user-facing script editing semantics.
- Adding scene-level user review or approval flows.
- Adding new support for non-JavaScript/TypeScript runtimes.
- Weakening Daytona workspace isolation, scrubbed runtime environments, or dependency-install network gating.
- Publishing repair diagnostics directly to users as detailed self-service failure reports.
- Changing the final compositing model beyond the handoff from validated capture path to Footage Capture.

## Further Notes

- This PRD follows the current MakeADemo glossary and ADR 0017.
- The important invariant is not that the whole repo is perfectly offline; the invariant is that the generated capture path runs against the prepared app under Runtime Network Lockdown.
- Capture Path Validation should reduce flake by proving the exact browser path before final recording.
- Capture Path Validation should stay fast enough to support repair loops.
- Footage Capture remains responsible for creating the final raw Scene videos with presentation quality.
- The MakeADemo Pipeline PRD and Daytona Repo Preparation PRD should use Capture Path Validation as the script-driven validation gate rather than the older standalone Project Validation model.
