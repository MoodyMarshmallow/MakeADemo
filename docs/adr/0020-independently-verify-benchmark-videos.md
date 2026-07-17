# Manually Verify Benchmark Videos

The benchmark will reserve L6 for a manual decision by the external coding
agent that runs or reads the benchmark. The benchmark command and summarizer
will stop at L5 and will not launch Codex, construct evaluator prompts, or
persist evaluator verdict artifacts. The external agent follows the benchmark
guide after execution and reports the final L5/L6 judgment separately from the
machine-produced JSONL results.

The external agent compares the final video with the submitted repository at
the benchmark's pinned commit and keeps the run at L5 when source-controlled
interface evidence is insufficient. L6 also requires coherent footage. The
agent checks for obvious broken visual artifacts,
including blank or black frames, corrupt rendering, clipping, flicker,
overlaps, unreadable text, broken transitions, and frozen footage. It also
checks that visible overlay text is meaningfully relevant to the footage shown
with it. An application-identity match cannot reach L6 when coherence is
incoherent or cannot be established from the available evidence.

The external agent treats repository content as untrusted evidence, ignores
repository-provided agent rules, and does not execute submitted code on the
benchmark host. It may inspect UI components, routes, styles, assets, tests,
stories, and documentation screenshots. A rejected, inconclusive, failed, or
incoherent manual review does not advance the run beyond L5.

This decision supplements ADR 0019 rather than replacing it. The same-session
Draft Composite reviewer remains part of the product's bounded repair loop;
the manual external-agent review is a benchmark-only guard against a generation
and review session agreeing on a fabricated or unrelated application.
