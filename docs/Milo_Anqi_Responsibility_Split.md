# Milo and Anqi Responsibility Split

## Split Summary

Milo owns Script Generation and Capture Path Validation, including the **Demo Runtime Preflight** that accepts a Demo Script for capture.

Anqi owns everything after the **Demo Script**, including turning the script into raw videos, compositing, effects, and final rendering.

## Handoff Boundary

The handoff artifact is the accepted **Demo Script**: the capture-ready output that Capture Path Validation passes to Footage Capture.

A Demo Script contains:

- `scriptId`, `title`, `version`, and `format`
- `demoPlaywrightScript`: the complete demo flow, including off-camera setup
- `scenes`: each Scene's id, human-readable description, and expected visible outcome
- `presentation`: text overlays, transitions, and music intent

Demo Runtime Preflight evidence, preparation assumptions, and unresolved repair risks remain with their owning validation, preparation, and repair records; they are not fields of the Demo Script handoff.

## Milo Ownership

Milo owns:

- Preparation Prompt Generator
- Context Gathering
- Project Intake
- MakeADemo Config loading and validation
- Demo Run Contract validation
- Dependency install inference
- Sandbox Runner
- Network Isolation Policy
- Browser Validation
- Script Generation
- Demo Script creation
- Capture Path Validation, including Demo Runtime Preflight

Milo's milestone is: generate and validate a complete Demo Script from a prepared JavaScript/TypeScript web app.

## Anqi Ownership

Anqi owns:

- Compositing
- Capture Script Generation
- Scene Recording
- Companion Videos
- Raw Scene footage
- Timeline assembly
- Text overlays and captions
- Transitions
- Visual effects
- Music bed and audio balancing
- Render preview flow
- Final video rendering
- Export quality and presentation polish

Anqi's milestone is: turn a Demo Script into raw Scene footage and then compose it into a polished final demo video.

## Interface Between Workstreams

Anqi's video generation work should consume Demo Scripts rather than reaching back into repo validation or script generation internals.

The Demo Script interface should be stable enough that Milo can iterate on context gathering, validation, and script generation without forcing Anqi to rewrite capture or compositing logic.

The Demo Script should be explicit about the full Playwright flow, declared Scenes, expected outcomes, and presentation metadata so that Anqi can generate raw Scenes, timeline assembly, captions, and effects predictably.

## Main Risk

The main risk is an unclear handoff boundary. If Anqi receives only loose prose, she inherits script interpretation uncertainty. If Milo provides a structured Demo Script with declared Scenes and a complete Playwright flow, Anqi can focus on video generation and craft: raw Scene footage, assembly, effects, polish, and final rendering.
