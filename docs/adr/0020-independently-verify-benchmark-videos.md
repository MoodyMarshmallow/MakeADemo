# Independently Verify Benchmark Videos

The benchmark will reserve L6 for an affirmative, structured verdict from a
fresh external Codex evaluator. This evaluator is separate from the OpenCode
session that prepares the repository, generates the Demo Script, and reviews
the Draft Composite. It compares sampled final-video frames with the submitted
repository at the benchmark's pinned commit and must return inconclusive when
the available source-controlled interface evidence is insufficient.

L6 additionally requires an affirmative coherence verdict. The evaluator
checks the supplied final-video evidence for obvious broken visual artifacts,
including blank or black frames, corrupt rendering, clipping, flicker,
overlaps, unreadable text, broken transitions, and frozen footage. It also
checks that visible overlay text is meaningfully relevant to the footage shown
with it. An application-identity match cannot reach L6 when coherence is
incoherent or cannot be established from the available evidence.

The evaluator treats repository content as untrusted evidence, ignores
repository-provided agent rules, and does not execute submitted code on the
benchmark host. It may inspect UI components, routes, styles, assets, tests,
stories, and documentation screenshots. A rejected, inconclusive, or failed
evaluation, or any incoherent result, is retained as structured benchmark
evidence but does not fail an otherwise successful Pipeline Job and does not
advance it beyond L5.

This decision supplements ADR 0019 rather than replacing it. The same-session
Draft Composite reviewer remains part of the product's bounded repair loop;
the independent evaluator is a benchmark-only guard against a generation and
review session agreeing on a fabricated or unrelated application.
