## Agent skills

Repo skills are pinned in `skills-lock.json`. Do not commit installed skill copies under `.agents/`; that directory is local generated state and is ignored by git.

Agent-facing CLI tools are tracked separately in `tools-lock.json`. `railway` is installed from the pinned `@railway/cli` package in `package.json`/`bun.lock`; `daytona` follows the latest GitHub release because it is not distributed as an npm CLI.

Before using repo-level skills in OpenCode, restore them locally:

```bash
npx skills experimental_install
```

Before using the Railway or Daytona skills, verify their CLIs against `tools-lock.json` with `bunx railway --version` and `daytona --version`.

### Issue tracker

Issues and PRDs for this repo live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

This repo uses the default triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`. You should always take a look at this info BEFORE DOING ANYTHING to facilitate better communication.

## Project Introduction

`MakeADemo` helps builders turn a runnable web app, codebase context, and product description into a short demo video.

The codebase should remain minimal and adaptable while preserving clean seams between frontend UI, backend APIs, auth, persistence, integrations, and background processing.

## Main Objectives

- Keep the codebase minimal: add the smallest correct module or interface that solves the current need.
- Keep the codebase aligned to the MakeADemo Pipeline: Context Gathering, Repo Security Screen, Repo Preparation, Script Generation, Capture Path Validation, Footage Capture, Compositing, and final output.
- Prefer deep modules: put meaningful product behavior behind small interfaces, and avoid shallow pass-through helpers.
- Maintain clear seams between pipeline stages, external services, persistence, sandbox execution, browser automation, and rendering.
- Preserve full test coverage for behavior that defines a seam, adapter, or user-visible flow.
- Prioritize readability: direct imports, explicit names, small files, and domain vocabulary over clever abstractions.

## Development Practice

For runtime-code changes, always use the `tdd` skill if you have to it. If you don't, you must read and follow `docs/agents/tdd.md` before editing runtime code. Follow TDD best practices:

- Write one failing behavior test first.
- Implement the smallest change that makes that test pass.
- Refactor only after tests are green.
- Prefer tests through public interfaces and real seams rather than implementation details.
- Add regression tests for bugs before fixing them when a correct seam exists.
- When exporting a new interface, add a docstring that explains what implementations should do and the invariants they must uphold.
- Run `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run knip` before considering code changes complete.

### Commit

- Keep commit messages concise, easily readable, and very specific.
- Use one of these prefixes: `feature:`, `bugfix:`, `refactor:`, `test:`, `docs:`, `chore:`, `infra:`, or `generated:`.
- Use `feature:` for new user-visible product behavior, API capabilities, or pipeline functionality.
- Use `bugfix:` for correcting broken behavior, regressions, data loss, incorrect output, crashes, or flaky runtime behavior.
- Use `refactor:` for restructuring code without intentionally changing behavior.
- Use `test:` for adding or changing tests, fixtures, or test-only helpers when runtime behavior is unchanged.
- Use `docs:` for documentation-only changes, including agent instructions, ADRs, PRDs, and README updates.
- Use `chore:` for routine maintenance that does not affect runtime behavior, such as package metadata, config cleanup, or repository housekeeping.
- Use `infra:` for deployment, CI, environment, sandbox, cloud, or operational tooling changes.
- Use `generated:` for regenerated artifacts such as schemas, lockfiles, or other machine-generated outputs when committed separately.
- Prefer a specific subject that explains the exact change, such as `bugfix: preserve Daytona preview paths` rather than `bugfix: fix pipeline`.
- Before committing, ask the user whether the work completes or relates to any Linear issues. If it does, the Linear issue key is sufficient context; do not require the issue title or description.
- When a commit or PR is about a Linear issue, include the relevant Linear issue key in the commit subject or PR title, for example `feature(OWL-22): add draft composite review`.
- When a commit or PR should close a Linear issue, include a Linear closing magic word and issue key in the title/subject, not only in the body. Use a closing form such as `Closes OWL-22: add draft composite review` in the PR title, or `feature: closes OWL-22 add draft composite review` in a commit subject when committing directly to the default branch.
- Use non-closing Linear words such as `Refs OWL-22` only when the work is related but should not move the issue to Done after merge.
- N.B. When asked to commit, split staged work into multiple small commits. N.B.: Commits should be atomic: each commit should be fully described by its short subject and should not be able to be split apart anymore without losing important context.

### Testing

- Test behavior through public interfaces and real seams; avoid tests that depend on private functions, storage internals, or incidental implementation order.
- Keep each test focused on one behavior. If a test needs many assertions, split it unless the assertions describe one observable flow.
- Prefer short setup helpers when they remove noise, but keep the behavior under test visible in the test body.
- Name tests as specifications of observable behavior, not implementation steps.
- Cover failure cases at seams: invalid lifecycle transitions, missing records, provider failures, malformed persisted data, sandbox failures, browser automation failures, and rendering failures.
- Use integration-style tests for core product flows where practical, especially pipeline orchestration, repo validation, script generation, capture, and compositing.
- Do not unit test prompt text or prompt wording in code. Prompts do not need direct unit tests; test the observable behavior or contract that the prompt-powered seam must satisfy instead.
- Add regression tests before fixing bugs, and keep them focused on the bug's externally visible behavior.
- Avoid over-mocking. Use small fakes at external seams when real adapters would make the test slow, flaky, or dependent on network/auth state.
- Refactor tests after they pass: remove duplicated setup, split broad tests, and keep assertions specific enough to catch real regressions.
