# Event-Marked Footage Capture PRD

## Problem Statement

MakeADemo currently asks the Script Generation agent to provide `durationSeconds` for each recorded Scene. Those values are guesses: the agent cannot know how long final presentation-oriented Playwright recording will take after human-like typing, cursor movement, waits, app latency, and visible assertions.

Bad guessed durations produce bad videos. Short captured Scenes get padded or frozen; long captured Scenes get cut before their payoff. The Conduit demo showed both issues: a roughly three-second browse capture was padded to seven seconds, while publish/edit/comment captures were truncated before the outcome.

The current independent-Scene model also makes final footage show repeated setup, such as login and navigation. Validation isolation is useful, but viewer-facing footage should hide setup and show meaningful product moments. MakeADemo needs semantic Scene boundaries, factual capture-derived durations, off-camera setup, and Draft Composite review before final acceptance.

## Solution

MakeADemo will replace agent-authored per-Scene duration planning with event-marked Demo Script capture.

Script Generation will produce one capture-ready **Demo Script** instead of many independent duration-bearing Scene scripts. Demo Script replaces legacy Video Script Package as the handoff into Capture Path Validation, Footage Capture, and Compositing. It centralizes the demo Playwright script, declared Scenes, expected visible outcomes, and required presentation metadata such as overlays, transitions, and music intent.

The demo Playwright script will import a real MakeADemo Capture SDK Contract from generated harness files. The SDK separates off-camera setup from on-camera callback-based Scenes. The agent writes semantic setup and Scene calls, not timestamps, raw video recording configuration, or marker implementation.

Footage Capture will record one continuous browser take while the SDK emits Scene marker events. The capture harness derives marker timestamps from its own monotonic recording clock, applies small pre/post padding, trims the continuous take into per-Scene clips, probes those clips, and writes actual durations to the Capture Manifest.

Capture Path Validation remains the dry-run trust gate. It runs the full Demo Script from a fresh deterministic state without presentation simulations, validates marker correctness and visible assertions, and enforces Runtime Network Lockdown. Footage Capture then reruns the accepted Demo Script from a fresh deterministic state with presentation-oriented behavior.

Compositing will consume Demo Script presentation metadata plus trimmed Scene clips and captured durations. It will produce a Draft Composite. The same long-lived Agent Session must review the Draft Composite at least once, using derived evidence and the raw video path. Review may accept the draft or request repair within a bounded retry budget.

## User Stories

1. As a maker, I want setup, seeding, login, and navigation hidden when they are not the feature, so that the demo focuses on product value.
2. As a maker, I want feature payoffs such as publishing, editing, favoriting, and commenting to remain visible, so that the video communicates complete outcomes.
3. As a maker, I want MakeADemo to avoid frozen, padded, or prematurely cut footage, so that the final video feels intentional.
4. As a maker, I want timing to come from captured reality rather than agent guesses, so that Scenes are neither overrun nor truncated by speculative durations.
5. As a maker, I want a continuous demo flow to preserve useful app state across Scenes, so that the story does not repeat setup before every feature.
6. As a maker, I want final footage to keep polished cursor movement, human-like typing, text overlays, transitions, and music, so that the output is a real demo video rather than raw browser capture.
7. As a maker, I want MakeADemo to retry poor drafts automatically when possible, so that common video-quality issues do not require manual intervention.
8. As a MakeADemo operator, I want one Demo Script artifact to replace Video Script Package, so that validation, capture, and compositing share one source of truth.
9. As a MakeADemo operator, I want a real Capture SDK Contract, so that the agent follows a typed API instead of prompt-only syntax.
10. As a MakeADemo operator, I want validation to reject bad marker structure, missing Scene coverage, raw recording ownership, missing visible assertions, and runtime network violations, so that trusted capture starts from a proven script.
11. As a MakeADemo operator, I want Footage Capture to compute actual Scene durations and produce per-Scene clips, so that Compositing stays simple and does not understand marker internals.
12. As a MakeADemo operator, I want narrow deterministic quality gates, so that objective duration, audio, and static-footage failures are caught without turning the backend into a subjective video reviewer.
13. As a MakeADemo operator, I want Draft Composite review in the same Agent Session, so that the agent can judge narrative quality with the context it used to prepare the workspace and Demo Script.
14. As a MakeADemo operator, I want derived video evidence plus access to the raw draft and tools like ffmpeg, so that review is reproducible and inspectable.
15. As a MakeADemo operator, I want bounded repair retries and warning metadata on retry exhaustion, so that the system remains reliable without discarding the latest generated video.

## Implementation Decisions

### Demo Script Contract

- Script Generation must stop requiring or accepting agent-authored `durationSeconds` for Playwright-recorded Scenes.
- Demo Script replaces Video Script Package as a clean cutover; do not add backward-compatibility support for old script artifact shapes.
- Demo Script must contain the demo Playwright script, declared Scene IDs, descriptions, expected visible outcomes, and presentation metadata needed by Compositing.
- Demo Script must require text overlays, transitions, and music intent, validated against MakeADemo-approved fonts, music assets, styles, and transition options.
- A declared Scene still has an ID, description, expected visible outcome, and any Scene-specific presentation metadata.

### Capture SDK Contract

- The Capture SDK Contract must be real generated harness files: TypeScript declarations, a runtime helper module, and prompt instructions.
- Capture SDK files must live in a MakeADemo-owned generated harness area outside the maker's app source and outside the prepared repo diff.
- The demo Playwright script must import the SDK helper rather than inline marker logic.
- TypeScript validation should catch obvious SDK misuse before Capture Path Validation runs the script.
- The SDK must provide off-camera setup primitives for login, seeding, navigation, and other prep work.
- The SDK must provide a callback-based on-camera Scene primitive, such as `scene(id, async () => { ... })`, that owns paired start/end marker events.
- The SDK should not expose separate raw start/end marker calls as the primary agent API.
- The SDK must prevent the agent from owning browser launch, viewport, video recording, marker log path, output path, or presentation recording behavior.
- The agent must write Playwright interactions and assertions inside the SDK contract, not raw `recordVideo`, ad-hoc timestamps, or custom marker writers.

### Markers And Timing

- Marker events must include Scene ID, event type, and capture-tool-derived timing data.
- Marker timing is a Footage Capture implementation detail and must not appear in agent-authored scripts.
- Marker timestamps must come from the MakeADemo capture harness using a monotonic clock tied to recording start.
- Marker timestamps must not come from browser page time or agent-authored values.
- Footage Capture must apply small configurable pre-roll and post-roll padding when trimming marker ranges.

### Capture Path Validation

- Capture Path Validation must run Demo Runtime Preflight before the generated capture path.
- Validation must execute the full Demo Script from a fresh deterministic starting state.
- Validation must run without presentation simulations such as human typing, cursor movement, recording pauses, and other recording-only delays.
- Validation must check contract correctness: marker order, declared Scene coverage, no nested Scenes, no missing ends, no duplicate starts, no undeclared Scene IDs, and no Scenes without visible assertions.
- Every on-camera Scene must include at least one visible Playwright assertion or equivalent SDK outcome check.
- Validation must enforce Runtime Network Lockdown.
- Validation must not compute final recorded durations.

### Footage Capture

- Footage Capture must run the accepted Demo Script in recording mode with presentation-oriented cursor movement, typing, scrolling, waits, and recording-specific pauses.
- Footage Capture must run from a fresh deterministic app state and must not reuse browser or app state mutated by validation.
- Footage Capture must preserve browser and app state across Scenes inside the same Demo Script.
- Footage Capture must not reset app state before every Scene.
- Footage Capture must record one continuous raw take, convert marker events into trim ranges, and split or trim the take into per-Scene clips.
- Trimmed per-Scene clips are the required downstream handoff into Compositing.
- The continuous raw take is diagnostic only and should be retained when run retention is enabled; it is not the normal Compositing input.
- Footage Capture must probe each trimmed clip and write actual Scene durations to the Capture Manifest.
- The Capture Manifest must record capture-level quality findings, marker log path, continuous take path when retained, Scene clip paths, and actual Scene durations.

### Compositing And Draft Review

- Compositing must use Demo Script presentation metadata plus captured Scene clip durations from the Capture Manifest.
- Compositing must not use Script Generation duration fields for Playwright-recorded Scenes.
- Compositing must not understand marker events when Footage Capture already provides per-Scene clips.
- Compositing must produce a Draft Composite before final output acceptance.
- The Draft Composite or final video manifest must record review status, review attempts, and draft-video quality findings.
- Draft Composite review must happen in the same long-lived Agent Session used for Repo Preparation and Script Generation, using a focused review prompt.
- Draft Composite review must always run at least once.
- The review prompt must include the raw Draft Composite path, derived evidence such as contact sheets, sampled frames, Scene-duration tables, marker summaries, ffmpeg/ffprobe findings, and access to tools such as ffmpeg for deeper inspection.
- The agent must return a structured `accept` or `repair` decision.
- A `repair` decision must include a concise reason and whether changes affect only the Demo Script or also the prepared workspace.
- Demo Script-only repair reruns Footage Capture and draft Compositing.
- Workspace repair must rerun full Capture Path Validation before recapture.

### Quality Gates And Retry Exhaustion

- Deterministic quality gates are limited to total Draft Composite/final video duration, per-Scene clip duration, audio presence when music is enabled, and each Scene containing non-static footage.
- Deterministic quality gate failures enter the same bounded Draft Composite repair loop as agent-review rejections.
- Blank frames, weak composition, repeated setup, poor narrative, bad transitions, missing viewer context, and visible-outcome quality are agent-review evidence, not deterministic hard blockers.
- Additional ffmpeg, ffprobe, screenshot, and contact-sheet findings may be generated as review evidence, but must not hard-fail unless they map to the narrow deterministic gates.
- Viewer-facing duration gates apply to the Draft Composite/final video and per-Scene clips, not off-camera setup time in the continuous raw take.
- The raw take has a separate operational timeout only to prevent hangs and runaway cost.
- If the Draft Composite exceeds the hard total duration limit, MakeADemo still produces the full draft and sends it to the agent with an overtime error message.
- Draft Composite review has a bounded retry budget configurable separately from Capture Path Validation retries.
- If the review retry budget is exhausted, MakeADemo outputs the latest Draft Composite as the final video.
- Retry exhaustion is a successful Pipeline Job with structured warning metadata, not a failed Pipeline Job.
- Exhaustion must preserve diagnostics and write a limit-exceeded warning to pipeline logs.
- If deterministic gates still fail after exhaustion, the warning must include the remaining failed gates.

### Agent Prompt Rules

- Put setup, login, data creation, and navigation in off-camera setup unless that setup is the feature being demonstrated.
- Every Scene must end on a visible success state.
- Do not provide durations.
- Do not use raw Playwright video recording.
- Use stable Scene IDs from the Demo Script.
- Use assertions to prove visible outcomes before ending each Scene.
- Scenes without visible assertions fail Capture Path Validation.
- Avoid repeating authentication unless authentication itself is the Scene.

## Testing Decisions

- Tests should verify behavior through public pipeline seams and durable artifacts rather than private helper internals.
- Demo Script parsing tests should prove that agent-authored recorded-Scene durations are rejected and that the demo Playwright script, declared Scenes, expected outcomes, and presentation metadata are validated.
- Capture SDK tests should prove setup emits no Scene markers, callback Scenes emit paired markers in order, thrown Scene bodies still produce well-formed failure/end markers, and marker data is sufficient for trimming.
- Capture Path Validation tests should cover missing, duplicated, nested, out-of-order, undeclared, and uncovered Scene markers; missing visible assertions; Runtime Network Lockdown; fast validation mode; and fresh deterministic starting state.
- Footage Capture tests should prove one continuous take plus marker events produces per-Scene clips; durations come from probed clips; setup outside markers is excluded; visible actions inside markers are included; state flows across Scenes; validation mutations do not leak; marker ranges at take boundaries work; and missing/malformed raw take, marker log, or ffmpeg trim failures are handled.
- Compositing tests should prove render plans use captured clip durations and never use Script Generation durations for Playwright-recorded Scenes.
- Quality gate tests should cover total duration limits, per-Scene duration limits, missing audio when music is enabled, and fully static Scene footage.
- Quality evidence tests may cover blank frames, frozen footage, screenshots, contact sheets, and ffmpeg findings as agent-review evidence that does not hard-fail the pipeline.
- Draft Composite review tests should prove the agent receives the draft video, derived evidence, raw path, structured `accept` finalization, structured `repair` retry routing, deterministic gate failures as repair evidence, workspace repair forcing Capture Path Validation, visible-outcome concerns as review evidence, retry exhaustion outputting the latest draft, warning metadata, remaining failed gates, and succeeded-with-warning Pipeline Job status.
- Pipeline integration tests should cover the happy path through Script Generation, Capture Path Validation, Footage Capture, Draft Composite review, and final output.
- Pipeline integration tests should cover repair after overtime, repeated visible setup, missing visible success, and degraded success after Draft Composite retry exhaustion.

## Out of Scope

- User-facing timeline editing or manual trimming controls.
- Multi-camera or multi-browser recording.
- Voiceover generation.
- Replacing Runtime Network Lockdown or Demo Runtime Preflight.
- Trusting agent-authored marker data without backend validation.
- Letting the agent control Playwright `recordVideo`, final timestamps, or clip durations.
- Coupling Compositing directly to marker logs when Footage Capture can provide trimmed Scene clips.
- Changing Repo Security Screen.
- Supporting non-browser demos or non-JavaScript/TypeScript runtimes beyond the current V1 scope.

## Further Notes

- This PRD follows the current MakeADemo glossary: Capture Path Validation remains the deterministic validation gate, Footage Capture records final Scenes, and Compositing assembles final output.
- The key shift is that Scene boundaries become semantic agent-authored events, while timing becomes capture-tool-derived evidence.
- The preferred Compositing handoff is trimmed per-Scene clips plus actual durations, not one long video plus marker ranges.
- The Capture SDK Contract is a stable product seam because agent prompt reliability depends on it.
- Draft Composite review judges whether the actual video makes a good demo; deterministic validation only proves the script and runtime are trustworthy.
- The retry loop should be bounded and observable because full recapture can be expensive.
