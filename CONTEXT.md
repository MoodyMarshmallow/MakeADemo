# MakeADemo Context

`MakeADemo` is a single-package Bun/TypeScript product for generating short demo videos from runnable web apps, codebase context, and product descriptions.

## Domain Terms

- **MakeADemo Pipeline**: The linear product flow that turns a submitted project into a demo video through context gathering, repo screening, repo preparation, script generation, capture path validation, footage capture, and compositing.
- **Context Gathering**: The stage where the maker submits the GitHub repo URL and key product features to demo.
- **Project Intake**: The data captured during Context Gathering.
- **Supporting Document**: A non-image, non-video document uploaded or provided by the maker during Context Gathering to help Repo Preparation and Script Generation understand the product, setup, audience, and demo goals.
- **Normalized Supporting Document**: A text artifact extracted from a Supporting Document before Repo Preparation begins, preserving source metadata while giving agent and non-agent stages a consistent document representation.
- **Repo Security Screen**: The non-agent, deterministic pipeline stage that performs a fast, static-only rough safety pass on a cloned submitted repo before any agent or runtime preparation work begins.
- **Repo Preparation**: The pipeline stage where MakeADemo works in an isolated ephemeral cloud workspace to discover existing demo setup, prepare a deterministic demo runtime, and gather context for later script and capture stages without modifying the maker's source repo. During development, the Daytona sandboxes are intentionally network-enabled; runtime network lockdown is deferred.
- **Preparation Workspace Release**: The idempotent cleanup of a usable Daytona Repo Preparation workspace: active commands are cancelled, and both the primary Sandbox and its logical submitted-code child Sandbox are stopped then archived rather than deleted. Release does not attempt to reseal network access.
- **Preparation Fallback Prompt**: A targeted prompt generated when Repo Preparation fails, giving the maker and the maker's coding agent the blockers and context needed to prepare the demo manually.
- **Demo Runtime Preflight**: The project-level checks inside Capture Path Validation that verify the prepared app can start, load in a browser, and remain basically interactable before generated Browser Actions or Capture Scripts run. Daytona sandbox firewall lockdown is deferred during development, while browser-level request interception still records blocked-network evidence.
- **Submitted Toolchain Plan**: The backend-resolved exact Node, package-manager, project-root, and lockfile selection for submitted-code execution. The Daytona provider privately binds provisioning and synchronization to this plan; pipeline callers do not carry artifact authority objects.
- **Demo Run Contract**: The requirement that the prepared app can start a deterministic browser-accessible demo inside an isolated sandbox with a scrubbed environment and no inherited agent secrets. Network access remains available during development; the future no-cross-boundary-network contract is not yet enforced.
- **MakeADemo Config**: A legacy-compatible `makeademo.config.json` file that may describe a demo command and local URL, but is no longer the primary source of truth once Repo Preparation produces a Preparation Manifest.
- **Preparation Manifest**: The durable internal pipeline artifact produced by Repo Preparation that records the prepared demo command, local URL, existing demo evidence, workspace changes, mocks, assumptions, risks, and context for later script and capture stages.
- **Runtime Network Lockdown**: A deferred hardening policy for sealing the prepared app runtime from external network access after setup. The Daytona sandbox firewall portion is not enforced in the current development policy; browser-level request interception and blocked-network reporting remain active, but cannot prove sandbox-boundary isolation.
- **Sandbox**: The isolated execution environment that runs the submitted app, browser validation, capture path validation, and Playwright capture. The primary and submitted-code Daytona sandboxes are separate execution boundaries with scrubbed runtime environments; both remain network-enabled during development.
- **Script Generation**: The stage where MakeADemo turns prepared repo context and key product features into a Video Script.
- **Video Script**: A structured plan for the demo video that organizes what the video will communicate over time.
- **Video Script Package**: The legacy structured artifact produced by Script Generation before Footage Capture, containing the Video Script, Script Sections, Scene Descriptions, Browser Actions, and validation context.
- **Demo Script**: The capture-ready script artifact produced by Script Generation, replacing Video Script Package as the handoff into Capture Path Validation, Footage Capture, and Compositing. It describes the whole demo flow, including off-camera setup, on-camera Scene boundaries, and presentation metadata for final video assembly.
- **Capture Path Validation**: The deterministic dry-run validation stage that runs Demo Runtime Preflight and then runs the generated capture path against the prepared app with browser-level network evidence before Footage Capture accepts the Demo Script. Daytona sandbox-firewall Runtime Network Lockdown is deferred during development.
- **Script Section**: A top-level part of the Video Script, such as intro, feature demonstration, or use case, that groups related scenes.
- **Scene Description**: A script item that summarizes one web-based scene and lists the browser actions needed to capture it.
- **Browser Action**: One explicit interaction or wait condition in a Scene Description, such as clicking a button, typing into an input, or waiting for streamed output to finish.
- **Capture Script**: A Playwright script generated from a Scene Description that performs the Browser Actions needed to record its Scene.
- **Scene**: The raw captured video clip produced by running a Scene Description's Capture Script in a Sandbox.
- **Companion Video**: The user-facing view of a Scene shown alongside its Scene Description during review.
- **Footage Capture**: The stage where MakeADemo records raw browser footage needed by the approved script.
- **Compositing**: The stage where MakeADemo assembles captured footage into the final demo video with text, transitions, and other presentation effects.
- **Draft Composite**: A temporary composited demo video produced for quality review before MakeADemo accepts it as the final output.
- **Benchmark Demo Verification**: A manual review performed by the external coding agent reading the benchmark guide. It compares an L5 final video with source-controlled interface evidence from the submitted repository at its pinned commit and reports L6 only when the application matches, no obvious broken visual artifacts are present, and overlay text is relevant to the concurrent footage.

- **Pipeline Stage**: One user-visible step in the MakeADemo Pipeline with clear inputs, outputs, and failure states.
- **Pipeline Job**: One execution of the MakeADemo Pipeline for a submitted project.
- **External Seam**: A stable boundary around infrastructure or third-party behavior, such as sandbox execution, browser automation, model calls, artifact storage, auth, or rendering.
- **Agent Harness**: The provider-neutral execution module that runs agent tasks for Pipeline Stages, combines universal agent policy with a stage task prompt, exposes Global Agent Tools plus the current Stage Agent Tools, preserves session continuity, and owns tool dispatch mechanics without deciding Pipeline outcomes.
- **Agent Session**: An opaque Agent Harness handle that preserves agent conversation and workspace continuity across Pipeline Stages without exposing provider-specific session identifiers.
- **Global Agent Tool**: An Agent Harness capability whose meaning and authorization are identical in every agent task. MakeADemo provides anonymous Exa web research and Context7 library-documentation tools globally.
- **Stage Agent Tool**: A capability owned by one Pipeline Stage and exposed only while the Agent Harness runs that stage's task.
- **Schema Module**: A public runtime validation boundary, named `*.schema.ts`, that exports schemas, codecs, or schema constants used to validate external data before it enters product types.

## Relationships

- The **MakeADemo Pipeline** runs linearly from **Context Gathering** to **Repo Security Screen**, **Repo Preparation**, **Script Generation**, **Capture Path Validation**, **Footage Capture**, **Compositing**, and final output.
- **Context Gathering** accepts the repo URL, structured demo intent, and broad document uploads for **Supporting Documents**, but excludes videos and pictures.
- **Supporting Documents** are normalized into text artifacts before **Repo Preparation** begins.
- **Repo Security Screen** runs before **Repo Preparation** and does not use an agent.
- **Repo Security Screen** does not install dependencies or execute submitted repo code.
- **Repo Security Screen** inventories committed dotenv paths without reading dotenv contents and does not reject a repo solely because `.env*` files are present.
- **Repo Preparation** happens in an ephemeral cloud workspace and does not modify the maker's source repo.
- **Preparation Workspace Release** preserves both the usable primary workspace and its logical submitted-code child as archived audit artifacts after each Sandbox stops. The submitted-code child is an independent Daytona Sandbox because Daytona-linked sandboxes are necessarily ephemeral and cannot be archived after stop.
- During **Repo Preparation**, the preparation agent may edit the ephemeral `/workspace` copy and run unprivileged inspection commands there. Trusted helpers and package runtimes remain root-owned, while submitted dependency, build, and runtime execution is routed to the separate submitted-code Sandbox. The prepared output must still pass non-agent **Capture Path Validation** before Footage Capture trusts it.
- During **Repo Preparation**, the preparation agent may use the always-networked Daytona sandboxes for setup, dependency installation, build, runtime, and research. This is an explicit development-stage tradeoff: **Runtime Network Lockdown** is deferred and is not a gate before Footage Capture.
- During **Repo Preparation**, the first submitted metadata scan is advisory so the agent can repair it. Each dependency-install request performs an authoritative rescan and returns repairable metadata blockers to the agent, while trusted catalog or sandbox infrastructure failures remain terminal.
- The preparation agent cannot invoke an enforced Daytona-firewall **Runtime Network Lockdown** check in the current policy. Browser-level request interception can still report observed blocked-network markers for later hardening, while scrubbed secrets and sandbox isolation continue to apply.
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
- **Capture Path Validation** first runs **Demo Runtime Preflight** to prove the prepared app can load, then proves that the generated capture path in a **Demo Script** can run in the isolated sandboxes. It does not enforce Daytona sandbox-firewall **Runtime Network Lockdown** during development, but retains browser-level request interception and blocked-network reporting.
- **Demo Runtime Preflight** performs the authoritative validation scan once. Its retained **Submitted Toolchain Plan** is consumed by the Daytona runner and fresh Footage Capture restart without duplicate metadata scans; exact provisioning is verified once per submitted-code child, and repeated synchronization can apply repaired workspace state.
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
- **Benchmark Demo Verification** runs manually after the MakeADemo Pipeline produces an L5 final video. The benchmark command never invokes an evaluator or writes L6. The external coding agent keeps inconclusive or failing reviews at L5 and reports L6 only for a verified application match with coherent visuals and relevant overlay/footage pairing.
- The **MakeADemo Pipeline** invokes the **Agent Harness** for agentic stage work while retaining ownership of stage order, deterministic gates, repair eligibility, retry budgets, and accepted outputs.
- The **Agent Harness** exposes its **Global Agent Tools** together with only the active Pipeline Stage's **Stage Agent Tools**; Stage Agent Tools do not remain available after that task settles.
- The embedded Pi SDK implements the Agent Harness runtime protocol. Pi runs in the backend process and delegates all repository filesystem and shell operations to Daytona, which remains the external workspace and submitted-code execution seam.

## Architectural Intent

Organize product code around the linear MakeADemo Pipeline.

Keep pipeline stages explicit and testable. Each stage should expose clear inputs, outputs, failure states, and dependencies on external seams.

Keep infrastructure-specific code behind seams so sandbox execution, browser automation, model providers, artifact storage, auth, persistence, and rendering can evolve without rewriting pipeline orchestration.

During development, Daytona sandboxes intentionally keep outbound network access enabled (`networkBlockAll: false`) to keep the small tool simple, subject to any Daytona organization-level egress policy. This is a conscious security tradeoff, not a permanent contract: retain sandbox separation and scrubbed secrets now, and defer Runtime Network Lockdown until the product requires the stronger boundary.

Use `*.interface.ts` for type-only seams when a boundary has multiple implementations or external behavior. Public runtime validation belongs in `*.schema.ts`.
