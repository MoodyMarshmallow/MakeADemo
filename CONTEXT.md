# MakeADemo Context

`MakeADemo` is a single-package Bun/TypeScript product for generating short demo videos from runnable web apps, codebase context, and product descriptions.

## Domain Terms

- **MakeADemo Pipeline**: The linear product flow that turns a submitted project into a demo video through context gathering, repo screening, repo preparation, script generation, capture path validation, footage capture, and compositing.
- **Context Gathering**: The stage where the maker submits the GitHub repo URL and key product features to demo.
- **Project Intake**: The data captured during Context Gathering.
- **Supporting Document**: A non-image, non-video document uploaded or provided by the maker during Context Gathering to help Repo Preparation and Script Generation understand the product, setup, audience, and demo goals.
- **Normalized Supporting Document**: A text artifact extracted from a Supporting Document before Repo Preparation begins, preserving source metadata while giving agent and non-agent stages a consistent document representation.
- **Repo Security Screen**: The non-agent, deterministic pipeline stage that performs a fast, static-only rough safety pass on a cloned submitted repo before any agent or runtime preparation work begins.
- **Repo Preparation**: The pipeline stage where MakeADemo works in a locked-down ephemeral cloud workspace to discover existing demo setup, prepare a deterministic demo runtime, and gather context for later script and capture stages without modifying the maker's source repo.
- **Preparation Fallback Prompt**: A targeted prompt generated when Repo Preparation fails, giving the maker and the maker's coding agent the blockers and context needed to prepare the demo manually.
- **Demo Runtime Preflight**: The project-level checks inside Capture Path Validation that verify the prepared app can start, load in a browser, remain basically interactable, and satisfy Runtime Network Lockdown before generated Browser Actions or Capture Scripts run.
- **Demo Run Contract**: The requirement that the prepared app can start a deterministic browser-accessible demo inside an isolated sandbox, with no inbound or outbound network communication across the sandbox boundary after dependency installation.
- **MakeADemo Config**: A legacy-compatible `makeademo.config.json` file that may describe a demo command and local URL, but is no longer the primary source of truth once Repo Preparation produces a Preparation Manifest.
- **Preparation Manifest**: The durable internal pipeline artifact produced by Repo Preparation that records the prepared demo command, local URL, existing demo evidence, workspace changes, mocks, assumptions, risks, and context for later script and capture stages.
- **Runtime Network Lockdown**: The pipeline boundary where the prepared app runtime is sealed from external network access after setup, and any attempted inbound or outbound sandbox-boundary communication is reported as a failure.
- **Sandbox**: The isolated execution environment that runs the submitted app, browser validation, capture path validation, and Playwright capture with the network boundary sealed after dependency installation.
- **Script Generation**: The stage where MakeADemo turns prepared repo context and key product features into a Video Script.
- **Video Script**: A structured plan for the demo video that organizes what the video will communicate over time.
- **Video Script Package**: The legacy structured artifact produced by Script Generation before Footage Capture, containing the Video Script, Script Sections, Scene Descriptions, Browser Actions, and validation context.
- **Demo Script**: The capture-ready script artifact produced by Script Generation, replacing Video Script Package as the handoff into Capture Path Validation, Footage Capture, and Compositing. It describes the whole demo flow, including off-camera setup, on-camera Scene boundaries, and presentation metadata for final video assembly.
- **Capture Path Validation**: The deterministic dry-run validation stage that runs Demo Runtime Preflight and then runs the generated capture path against the prepared app under Runtime Network Lockdown before Footage Capture accepts the Demo Script.
- **Script Section**: A top-level part of the Video Script, such as intro, feature demonstration, or use case, that groups related scenes.
- **Scene Description**: A script item that summarizes one web-based scene and lists the browser actions needed to capture it.
- **Browser Action**: One explicit interaction or wait condition in a Scene Description, such as clicking a button, typing into an input, or waiting for streamed output to finish.
- **Capture Script**: A Playwright script generated from a Scene Description that performs the Browser Actions needed to record its Scene.
- **Scene**: The raw captured video clip produced by running a Scene Description's Capture Script in a Sandbox.
- **Companion Video**: The user-facing view of a Scene shown alongside its Scene Description during review.
- **Footage Capture**: The stage where MakeADemo records raw browser footage needed by the approved script.
- **Compositing**: The stage where MakeADemo assembles captured footage into the final demo video with text, transitions, and other presentation effects.
- **Draft Composite**: A temporary composited demo video produced for quality review before MakeADemo accepts it as the final output.
- **Benchmark Demo Verification**: An independent, benchmark-only Codex evaluation that compares final-video frames with source-controlled interface evidence from the submitted repository at its pinned commit and judges whether the video is visually coherent. It is separate from the generation session and awards L6 only when the application matches, no obvious broken visual artifacts are present, and overlay text is relevant to the concurrent footage.

- **Pipeline Stage**: One user-visible step in the MakeADemo Pipeline with clear inputs, outputs, and failure states.
- **Pipeline Job**: One execution of the MakeADemo Pipeline for a submitted project.
- **External Seam**: A stable boundary around infrastructure or third-party behavior, such as sandbox execution, browser automation, model calls, artifact storage, auth, or rendering.
- **Schema Module**: A public runtime validation boundary, named `*.schema.ts`, that exports schemas, codecs, or schema constants used to validate external data before it enters product types.

## Relationships

- The **MakeADemo Pipeline** runs linearly from **Context Gathering** to **Repo Security Screen**, **Repo Preparation**, **Script Generation**, **Capture Path Validation**, **Footage Capture**, **Compositing**, and final output.
- **Context Gathering** accepts the repo URL, structured demo intent, and broad document uploads for **Supporting Documents**, but excludes videos and pictures.
- **Supporting Documents** are normalized into text artifacts before **Repo Preparation** begins.
- **Repo Security Screen** runs before **Repo Preparation** and does not use an agent.
- **Repo Security Screen** does not install dependencies or execute submitted repo code.
- **Repo Security Screen** inventories committed dotenv paths without reading dotenv contents and does not reject a repo solely because `.env*` files are present.
- **Repo Preparation** happens in an ephemeral cloud workspace and does not modify the maker's source repo.
- During **Repo Preparation**, the preparation agent may edit and execute the ephemeral workspace, but the prepared output must still pass non-agent **Capture Path Validation** before Footage Capture trusts it.
- During **Repo Preparation**, the preparation agent may use controlled network access for setup and research, but the prepared app runtime must pass **Runtime Network Lockdown** before Footage Capture trusts it.
- The preparation agent can invoke **Runtime Network Lockdown** as an iterative tool/check; app runtime network attempts return structured tool-call failures so the agent can mock or remove dependencies before retrying.
- **Repo Preparation** first checks whether the submitted project already contains a prepared demo command, MakeADemo Config, or existing demo flow before creating a new one.
- **Repo Preparation** mutates the ephemeral workspace directly and stores the resulting diff as an artifact for auditability, fallback prompts, and future apply-to-repo flows.
- **Repo Preparation** may gather context for later script and capture stages, but **Script Generation** remains a separate stage.
- If **Repo Preparation** cannot produce a plausible deterministic demo runtime, MakeADemo returns a **Preparation Fallback Prompt** and does not proceed to Script Generation.
- **Capture Path Validation** and **Footage Capture** run Playwright inside the **Sandbox** rather than from the backend host.
- **Preparation Manifest** supplies the prepared demo command and local URL used by **Capture Path Validation**.
- Later pipeline stages may consume the **Preparation Manifest** directly, including non-agent stages and coding-agent stages that access it through tools or skills.
- A **Video Script** contains one or more **Script Sections**, and each **Script Section** contains one or more **Scene Descriptions**.
- A **Demo Script** is accepted for Footage Capture only after **Capture Path Validation** succeeds.
- A **Demo Script** can cover multiple **Scenes** in one continuous demo flow so setup can happen outside the final visible **Scene** footage.
- **Footage Capture** executes an accepted **Demo Script** from a fresh deterministic starting state, then preserves browser and app state across its **Scenes**.
- **Capture Path Validation** first runs **Demo Runtime Preflight** to prove the prepared app can load without external network access, then proves that the generated capture path in a **Demo Script** can run while **Runtime Network Lockdown** is enforced.
- **Capture Path Validation** does not produce final **Scene** footage; **Footage Capture** records Scenes separately with presentation-oriented browser behavior such as human-like typing and cursor movement.
- **Footage Capture** starts from fresh deterministic app state after **Capture Path Validation** succeeds, so validation dry-runs cannot pollute the final recorded take.
- If **Capture Path Validation** fails, the agent may repair the prepared workspace or **Demo Script**, but the full **Capture Path Validation** stage must rerun before **Footage Capture** trusts the result.
- If **Capture Path Validation** still fails after repair attempts are exhausted, the **Pipeline Job** fails and tells the user to report the issue to MakeADemo rather than returning a partially trusted script or preparation fallback.
- If **Draft Composite** review requires changing the prepared workspace, **Capture Path Validation** must rerun before **Footage Capture** records a new take.
- A **Scene Description** contains one or more **Browser Actions**.
- A **Capture Script** mirrors the Browser Actions in one Scene Description.
- Each **Scene Description** maps to exactly one **Scene** during **Footage Capture**.
- Each **Scene Description** has one **Scene**, shown to the user as its **Companion Video** and later used by **Compositing**.
- **Compositing** produces a **Draft Composite** before final output acceptance, so the full video can be reviewed for narrative, timing, presentation, and capture quality.
- **Benchmark Demo Verification** runs only after the MakeADemo Pipeline produces a final video. An inconclusive, rejected, incoherent, or failed evaluation leaves the benchmark at L5; only an independently verified application match with coherent visuals and relevant overlay/footage pairing reaches L6.

## Architectural Intent

Organize product code around the linear MakeADemo Pipeline.

Keep pipeline stages explicit and testable. Each stage should expose clear inputs, outputs, failure states, and dependencies on external seams.

Keep infrastructure-specific code behind seams so sandbox execution, browser automation, model providers, artifact storage, auth, persistence, and rendering can evolve without rewriting pipeline orchestration.

Use `*.interface.ts` for type-only seams when a boundary has multiple implementations or external behavior. Public runtime validation belongs in `*.schema.ts`.
