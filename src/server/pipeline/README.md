# Pipeline Modules

Product code in this directory is organized around the linear MakeADemo Pipeline from `CONTEXT.md`.

- `00-orchestration/job/` coordinates Pipeline Jobs across stages.
- `00-orchestration/queue/` owns the Project-backed demo generation queue and worker logging.
- `00-orchestration/cli/` owns pre-capture CLI parsing, interactive prompts, and terminal failure output.
- `02-repo-security-screen/repository-loading/` owns the `RepoSecurityInputLoader` External Seam, the policy deciding which inventoried paths may have text read, and generic clone helpers; provider-specific loading implementations belong under `src/server/shared/integrations/`, while Repo Preparation reuses the generic clone helpers.
- Numbered stage folders own stage-specific product behavior, handoff artifacts, failure states, and tests.
- Stage modules may depend on external seams through interfaces, but provider-specific adapters belong under `src/server/shared/integrations/`.
- Shared handoff contracts should use domain names from `CONTEXT.md`; avoid numbered phase names in active product code.
