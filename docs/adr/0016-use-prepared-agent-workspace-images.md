# Use Prepared Repo Workspace Images

Daytona preparation workspaces will start from a prepared image or template containing the non-secret operating-system and project toolchain support needed for Repo Preparation. The Pi runtime, Context7 integration, Exa MCP client, and model credentials run in the trusted backend and are normal application dependencies, so they are not installed in or injected into the Daytona image. We retain prepared images because they make Git checkout, project inspection, and separate submitted-code execution faster and more consistent.

The parent prepared image hosts the mutable repository copy and MakeADemo workspace tooling only. Backend control commands retain the image's trusted user, but every agent-authored shell command runs through a dedicated Daytona seam as an unprivileged `pwuser` with a clean environment and writable state rooted at `/workspace`. The image keeps `/usr/local/bin`, package runtimes, MakeADemo helpers, the user's home, and common temporary roots non-writable by that user. Submitted app dependency, build, and runtime commands run in a separate Daytona sandbox created from a submitted-code runtime snapshot; the parent image's package runtimes are not executable by the agent user. The submitted-code sandbox is an independent Daytona sandbox and a logical child of the Preparation Workspace because Daytona-linked sandboxes must be ephemeral and cannot be archived after stop. The backend seam addresses both sandboxes directly, keeping pipeline execution tied to the Daytona external seam and submitted code outside the agent workspace's control plane.

Secrets must not be baked into either snapshot. LLM provider credentials and agent research integrations remain in the backend Agent Harness and are never sent to Daytona. Submitted repo build and runtime commands execute in the separate submitted-code sandbox with a scrubbed environment and no inherited agent secrets. Both sandboxes remain network-enabled during development (`networkBlockAll: false`); Daytona sandbox-firewall Runtime Network Lockdown is deferred and dependency execution does not reseal the network. Browser-level request interception remains available where validation/capture supports it.

The Pi-backed agent may operate autonomously on the disposable workspace copy through Harness-provided remote tools, including destructive file operations needed to prepare the demo. Those tools must root paths at `/workspace`, canonicalize existing and prospective paths inside Daytona, reject symlink-based path changes, and delegate operations to the unprivileged agent-command seam. Autonomy must not extend to the maker's source repo, trusted workspace tooling, backend filesystem, host infrastructure, or persisted artifacts except through explicit product-level APIs.

Pi does not provide interactive permission prompts in this embedded flow. Tool allowlists, project-config quarantine, runtime isolation, secret scoping, timeouts, and workspace teardown are enforced by the Agent Harness, the backend Daytona seam, and nested runtime controls. Daytona network access is intentionally left enabled during development; sandbox-firewall Runtime Network Lockdown is deferred as a later hardening policy.

Snapshot selection is deployment configuration, not a CLI input. The parent Repo Preparation snapshot is read from `MAKEADEMO_DAYTONA_SNAPSHOT`. The submitted-code runtime snapshot is read from `MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT`.

The submitted-code snapshot pins `playwright` and `@playwright/test` 1.49.1 in
the root-owned, non-writable
`/opt/makeademo/playwright-runtime/node_modules` directory and stores the
matching Chromium browser bundle under the root-owned, recursively non-writable
`/ms-playwright` directory. The agent-facing `playwright-cli` remains a
separate pinned tool with its own nested runtime; validator and capture
execution do not discover modules through that CLI, the active `PATH`, global
npm state, or submitted repository dependencies. Because submitted commands
run with a clean environment, the Daytona provider explicitly and
non-overridably binds
`MAKEADEMO_PLAYWRIGHT_MODULE_ROOT=/opt/makeademo/playwright-runtime/node_modules`
and `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` at its submitted-code execution
seam. Validator and Demo Script execution resolve Playwright only from that
trusted module root. Caller-provided environment variables cannot select a
different module or browser store.

Image verification walks the complete browser tree for ownership and writable
mode violations. After provisioning an exact submitted Node runtime,
verification loads the exact trusted Playwright 1.49.1 module and launches and
closes its Chromium through the privately bound runtime seam. The
agent-facing CLI session smoke test remains a separate image-level check.

## Submitted Node release resolution

Each Pipeline Job owns one lazy, immutable snapshot of the official Node.js
release index at `https://nodejs.org/dist/index.json`. The trusted catalog
adapter rejects redirects, bounds request time, response bytes, entry count,
and entry schema, and retains only stable releases that advertise a Linux x64
artifact. Repo Preparation and Demo Runtime Preflight share that same snapshot;
submitted repository data cannot change its origin or refresh it partway
through a job. Repo Preparation's initial metadata scan is advisory so the
agent can repair unsupported or incomplete metadata. A dependency-install
request performs an authoritative rescan and returns repairable metadata
outcomes to the agent. Demo Runtime Preflight performs the single authoritative
validation scan; the Daytona runner and fresh-capture restart consume its
retained plan instead of scanning again.

The resolver records a role for every accepted Node claim. Package
`engines.node` remains a hard compatibility range. Exact stable claims are hard
pins and intersect with those ranges; Volta must remain an exact stable pin.
Incomplete major selectors (`18`, `18.x`, or `v18`) in `.nvmrc`,
`.node-version`, `.tool-versions`, and mise TOML are soft preferences retained
as evidence rather than hard range narrowing. Without an exact pin, the
resolver selects the highest stable release satisfying the hard compatibility
bounds and records a warning when that release differs from a soft preference.
Tags, URLs, prereleases, malformed values, mutually exclusive hard claims, and
hard claims with no catalog release produce bounded typed outcomes; exact pins
are never overridden. An unconstrained project selects the highest stable Node
24 release in the job snapshot.

The enabled compatibility families are Node 18, 20, 22, and 24. Their
centralized compatibility minima are respectively 18.18.0, 20.19.0, 22.12.0,
and 24.0.0, and their known-good floors are 18.20.8, 20.19.5, 22.23.1, and
24.0.0. Node 18 and 20 plans are explicitly marked `legacy-eol`; Node 22 and
24 plans are marked `supported`. Resolution selects the highest exact stable
release in the requested intersection. The known-good floors support bounded
tests and image validation; they are not a production fallback when the
official catalog is unavailable. Catalog infrastructure errors, including
fetch failure and timeout, remain typed infrastructure failures and are not
collapsed into unsupported-repository outcomes.

Before package-manager acquisition and before submitted files enter the child
Sandbox, a root-only helper downloads the selected `linux-x64` archive and its
armored `SHASUMS256.txt.asc` from the fixed `https://nodejs.org` release
origin. Redirects are rejected and response, manifest, archive, entry-count,
and expanded-size limits are enforced. The helper verifies the manifest with
`gpgv` against the Node.js release project's full historical release keyring
pinned by Git commit and SHA-256 in the submitted-code image. It additionally
requires one valid signature whose primary fingerprint is in the image's
explicit bounded release-signer policy. That policy contains the current
release signers and the retired signer needed by accepted historical Node
releases; revoked-key status fails closed, while a valid signature made before
a signing subkey expired remains acceptable. The image build verifies real
signed manifests across all four known-good families, a current exact, and a
retired-key release. The helper selects exactly one lowercase SHA-256 manifest
row for the planned archive and checks that digest before bounded extraction.

The verified runtime is stored by archive SHA-256 beneath
`/opt/makeademo/toolchains/node/sha256`, owned by root with no writable tree
entries. During first provisioning in a submitted-code child, the helper
verifies the bounded attestation, ownership, modes, Node binary digest,
signed-manifest digest, and exact `node --version` before publishing the
runtime. Provisioning emits a bounded attestation containing the exact version,
archive, Node binary and signed-manifest digests, and signer primary
fingerprint. The helper exposes no reuse or later verification protocol. The
provider privately binds the verified Node
runtime and once-verified package-manager artifact to the exact plan; callers
do not carry artifact authority through pipeline requests.

## Submitted package-manager provisioning

The submitted-code image supplies a bounded compatibility runtime, not a
benchmark-derived list of package-manager patch releases. Repo metadata may
select only npm, pnpm, Yarn, or Bun and must provide an exact stable version
when it declares `packageManager`; tags, ranges, custom URLs, and prereleases
are rejected. When exact metadata is absent, the planner selects a revisioned
safe default that satisfies both the detected manager generation and the
resolved Node release. Exact npm, pnpm, and Yarn descriptors that do not
satisfy their official package's `engines.node` compatibility contract produce
a typed `incompatible_node_package_manager` blocker before acquisition. Yarn
Classic and Berry, pnpm 8–11, npm 8–11, and Bun releases from 1.2.16 through
the stable 1.x generation have bounded immutable-install support. Bun is a
standalone runtime and therefore does not inherit Node package-engine bounds.
Bun 1.2.16 is the
adoption boundary because it is the first Bun release whose official Linux x64
GitHub asset carries GitHub's authoritative SHA-256 digest; 1.2.15 and every
earlier 1.2 release omit that authority and are rejected before acquisition.

Before submitted repository files are synchronized, a root-only trusted control
command in the submitted-code Sandbox acquires the exact package-manager
release from fixed official npm registry metadata. npm, pnpm, and Yarn Classic
use their same-name official packages. The command validates the registry
SHA-512 SRI, gives that integrity to Corepack, records the hydrated artifact
SHA-512 digest, then places the resulting Corepack files in a root-owned,
non-writable, sandbox-local trusted artifact directory.

Yarn Berry instead uses the official `@yarnpkg/cli-dist` package. The trusted
control command validates that package's registry SHA-512 SRI, downloads its
exact tarball from the fixed npm registry origin, and extracts only the bounded
`package/bin/yarn.js` member. It records the extracted CLI's SHA-512 digest and
creates an exact-version launcher that executes that verified file directly
with the planned Node runtime. When repo metadata includes a Corepack hash
suffix, the provider validates it independently against the extracted
`package/bin/yarn.js` bytes that the launcher will execute. The
`@yarnpkg/cli-dist` tarball integrity is not passed to Corepack, because it
authenticates the enclosing npm tarball rather than that launched CLI, and
Corepack's Yarn Berry download is a different standalone artifact with a
different digest.

Bun uses a separate provisioner: it reads the exact stable release from the
fixed `oven-sh/bun` GitHub API, requires the authoritative SHA-256 on the single
Linux x64 asset, downloads the archive without running an installer, and
verifies both the archive and extracted binary before placing the binary in a
root-owned, non-writable content-addressed trusted artifact directory. ZIP
extraction is limited to the exact Bun member after its numeric uncompressed
size is checked against a fixed bound. Each trusted artifact exposes only an
exact-version launcher in its own root-owned, non-writable `bin`; that `bin` is
prepended to submitted install, build, runtime, and raw-command `PATH`, so
ordinary `npm`, `pnpm`, `yarn`, and `bun` commands cannot drift to snapshot
defaults. Submitted execution receives an exact `PATH` consisting of the
provisioned package-manager `bin`, the privately bound Node `bin`, and fixed
system utility directories in that order; caller `PATH` and image-level Node
or package-manager installations cannot override it. The image has no static
mise, Corepack, pnpm, or Yarn project-toolchain fallback. The base image's Node
installation remains an image/agent-CLI dependency, but it is excluded from
the submitted project `PATH`. A resolved plan is not executable until the
provider has privately provisioned and synchronized its exact Node,
package-manager, project root, and lockfile binding. After synchronization
and again before immutable installation, the provider rejects a canonical
lockfile whose no-symlink SHA-256 digest differs from the plan.

The same verified artifact may be rebound to repaired workspace contents and
resynchronized without reopening acquisition. Re-provisioning the same exact
plan preserves synchronized state, and repeat synchronization can restore later
workspace repairs. Selecting a different manager, version, generation, or Node
runtime still requires a fresh submitted-code Sandbox. The provider does not
open or close a network acquisition window under
the current always-networked development policy. Submitted code cannot request
alternate manager names, tags, URLs, or later manager downloads, and Yarn
project `yarnPath` does not replace the provider-selected executable.

Immutable dependency installs preserve the planner's catalog argv and run with
backend-owned, manager-aware concurrency bounds. The agent requests an install
without command arguments, and neither repository flags nor caller environment
can replace the selected argv or raise the concurrency profile. Lifecycle
scripts remain enabled; there is no lower or skip-build profile to claim as an
available recovery path. A bounded diagnostic classifier recognizes only Yarn
Classic's canonical Node-engine incompatibility output. It emits
`repository_node_dependency_incompatible` without changing the resolved Node
plan or asking the agent to retry an infrastructure-owned decision.

The prepared image does not include agent, subagent, skill, prompt, extension, or MCP configuration. The Agent Harness supplies its universal policy and Global Agent Tools explicitly, while each Pipeline Stage supplies only its own prompt and Stage Agent Tools.
