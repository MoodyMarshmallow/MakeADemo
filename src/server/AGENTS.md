# Server Agent Notes

## Logging

- The server-side logging seam is `src/server/shared/logging/pipeline-event-logger.ts`.
- Use `createPipelineEventLogger` for structured pipeline, agent, and sandbox audit events. It writes Pino JSONL with `level`, `time`, `service`, `component`, `stage`, `event`, and `message` fields.
- Use `createFilePipelineLogSink` for durable JSONL artifacts and `createPrettyPipelineLogSink` for human-readable CLI or PTY progress.
- Do not add ad-hoc JSONL writers for pipeline or agent activity. Route new stage, agent, validation, sandbox, and Agent Harness audit events through the Pino seam.
- Exception: generated browser/Playwright cross-process protocols may continue to use `console.*` marker lines such as `[makeademo:scene]`, `[makeademo:action]`, `[makeademo:validation]`, and `[makeademo:network-blocked]` when parent processes parse stdout/stderr for capture timing, validation diagnostics, or Runtime Network Lockdown. The generated submitted-code browser validator also uses `console.log(JSON.stringify(...))` as a one-object stdout result protocol parsed by its parent. Do not migrate those protocols to Pino unless the parser contract is changed at the same seam.

## Log Artifacts

- Full pipeline run events are written to `.makeademo-full-pipeline-runs/<run-id>/pipeline-log.jsonl` by `src/server/pipeline/00-orchestration/job/full-pipeline-runner.ts`.
- Provider-neutral Agent Harness output is written locally through Pino by `src/server/composition/agent-output.ts`.
- Repo Preparation sandbox audit events are written through `PreparationWorkspace.writeSandboxLog` to `/tmp/makeademo/sandbox-log.jsonl` by the Daytona workspace provider.
- Demo Runtime Preflight and Script Generation should add sandbox-visible progress through `writeSandboxLog`, not by writing their own log files.

## Agent Harness Output

- CLI stdout should stay readable. `src/server/composition/full-pipeline-cli.mts` uses the pretty Pino sink for pipeline progress and the composition output router for filtered agent text/tool progress.
- During early development, the Agent Harness output includes assistant text, exposed provider reasoning (raw or summary), tool names and lifecycle states, and diagnostics in stdout/stderr and the backend-owned JSONL audit artifacts. Tool arguments and results are intentionally omitted from both routes. The `onEvent` route is the durable record; `onStandard` and `onDiagnostic` remain the stdout/stderr routes and must not be duplicated by direct stream writes from the audit path.
- This early-development policy does not add sanitization or redaction at the composition seam. Provider-hidden reasoning that is never exposed in a provider event is unavailable to MakeADemo and cannot be recovered by the output router.

## Legacy Paths

- Do not reintroduce provider-owned workspace activity logs or Repo Preparation debug files. Harness output belongs in backend-owned run artifacts.
- Tests may mention those paths only as negative assertions that the legacy writers are not used.
