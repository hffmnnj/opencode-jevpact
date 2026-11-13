# Jev checkpoints for OpenCode

## Goal
Use TypeSafe Jev to time native OpenCode compaction at useful work transitions.
Use the existing server-side TYPESAFE_API_KEY and fixed TypeSafe hosted endpoint.
Default to jev-1.14.0, with a validated optional hosted model ID or alias.
The status reports the configured model; responses report the actual model,
which may differ from the requested ID or alias, including the default.

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

## Overnight observation
Observe the two authorized running sessions now and after 60-minute sleeps until
2026-10-27 06:30 America/Phoenix. Shorten the last sleep to the deadline. Make
small workload-supported improvements only; an observation with no justified
change is a valid result. Do not lower scores just to increase compaction count,
force compaction on active sessions, archive transcripts, or build a scheduler.
Preserve routing, native pressure fallback, and lifetime statistics. Report
observed usage and uncertainty rather than promising perfect calibration.

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
1. A real authenticated TypeSafe call returns a nonempty actual model ID and valid choice distributions for the configured model.
2. Below the context floor, no hosted decision or native compaction is requested.
3. Only confidently settled transitions qualify; unknown, unresolved, or invalid evidence does not. Require strong boundary evidence (0.8) and affirmative supporting answers (0.7), with confidence at least 0.5. An explicitly configured legacy minProbability remains the floor for all answers unless minSupportingProbability is also set.
4. Native compaction is requested once per eligible checkpoint; failures preserve normal work.
5. Timeout, cancellation, malformed responses, redirects, and secret-bearing excerpts are handled safely.
6. The plugin typechecks, its tests pass, loads on the existing 2.1.4 server without a restart, and its live diagnostic reaches Jev with the existing server key.
7. Model-dependent routing retains configured OpenAI-native and OpenCode-native compaction without overriding either; gpt-6.1-terra is explicitly configured native as requested.
