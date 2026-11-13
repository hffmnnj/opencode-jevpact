# Jev checkpoints for OpenCode

## Goal
Use TypeSafe Jev to time native OpenCode compaction at useful work transitions.
Use the existing server-side TYPESAFE_API_KEY and pin jev-1.14.0 (the API rejects the shorthand jev-1.14).

## Scope
One native V2 plugin, bounded recent visible text, conservative checkpoint decisions,
native compaction, and a read-only status/check surface. Native pressure compaction stays enabled.
The same native request must honor model/provider settings: OpenAI Responses-native
compaction for the user's configured OpenAI models, OpenCode-native summarization otherwise.
Recover visible task requests retained by native compaction without promoting peer
traffic to user direction. Label summary-only context explicitly. Only completed
progress-list updates may follow a candidate report; other tool results still need
interpretation. New user or child activity cancels an in-flight judgment.
Provider-truncated, filtered, errored, unknown-finish, or still-streaming reports
are not completed checkpoints. Require explicit successful finish and completion.

## Not doing
No replacement summarizer, desktop controller, service, private Codex interfaces,
synthetic continuation prompts, credential copies, or OpenCode restarts.
Stats use native plugin storage only: no telemetry service, transcript archive,
credentials, estimated savings, dashboard, or reset/delete endpoint.

## Persistent statistics
Keep lifetime totals shared across locations and reloads, with collection timestamps,
checkpoint outcomes, skip reasons, errors, requested versus observed native compactions,
requested routes, request latency, and validated TypeSafe token usage when supplied.
Keep diagnostics separate from real checkpoint evaluations. Existing volatile counters
are not historical records; durable collection starts with this version.
Expose read-only `jevpact/stats` and include the same aggregate in `jevpact/status`.
Statistics failures must never block normal execution or alter checkpoint decisions.
Add bounded persistent provider/model aggregates for real evaluations, decision
outcomes, admitted requests by route, latency and optional Jev usage. Detail
collection has its own start timestamp; old totals remain unassigned, never
backfilled by guessing. Diagnostics stay global and observed native completions
are not attributed to Jev or a model without evidence. No transcript, session
identity, score history, or extra hosted calls are needed for these aggregates.
Check persistence across reload, concurrent updates without lost increments, optional
usage validation, privacy allow-lists, and unchanged compaction behavior.

## Acceptance checks
1. A real authenticated TypeSafe call returns model jev-1.14.0 and valid choice distributions.
2. Below the context floor, no hosted decision or native compaction is requested.
3. Only confidently settled transitions qualify; unknown, unresolved, or invalid evidence does not. Require strong boundary evidence (0.8) and affirmative supporting answers (0.7), with confidence at least 0.5. An explicitly configured legacy minProbability remains the floor for all answers unless minSupportingProbability is also set.
4. Native compaction is requested once per eligible checkpoint; failures preserve normal work.
5. Timeout, cancellation, malformed responses, redirects, and secret-bearing excerpts are handled safely.
6. The plugin typechecks, its tests pass, loads on the existing 2.1.4 server without a restart, and its live diagnostic reaches Jev with the existing server key.
7. Model-dependent routing retains configured OpenAI-native and OpenCode-native compaction without overriding either; gpt-6.1-terra is explicitly configured native as requested.
