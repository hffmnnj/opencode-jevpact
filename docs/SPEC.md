# Jev checkpoints for OpenCode

## Goal
Use TypeSafe Jev to time native OpenCode compaction at useful work transitions.
Use the server-side `TYPESAFE_API_KEY` and the fixed TypeSafe hosted endpoint.
Default to `jev-1.14.0`, with a validated optional hosted model ID or alias.
The status reports the configured model; responses report the actual model,
which may differ from the requested ID or alias, including the default.

## Scope
One native V2 plugin, bounded recent visible text, conservative checkpoint decisions,
native compaction, read-only status and statistics, and a diagnostic check surface.
Native pressure compaction stays enabled.

The same native request must honor model/provider settings: provider-native
compaction for models configured for it, OpenCode-native summarization otherwise.
Recover visible task requests retained by native compaction without promoting peer
traffic to user direction. Label summary-only context explicitly. Only completed
progress-list updates may follow a candidate report; other tool results still need
interpretation. New user or child activity cancels an in-flight judgment.
Provider-truncated, filtered, errored, unknown-finish, or still-streaming reports
are not completed checkpoints. Require explicit successful finish and completion.
Never compact a completely idle session: no open assistant text stream, no
running shell, no running subagent, and no model request in flight. Re-check
this immediately before native admission; child sessions count only as parent
activity and are never judged.

## Policy calibration
Thresholds are conservative defaults, not calibrated guarantees. Tuning must be
supported by observed workload evidence; an observation that justifies no change
is a valid result. Do not lower scores solely to increase compaction count, force
compaction on active sessions, archive transcripts, or build a scheduler. Preserve
routing, native pressure fallback and lifetime statistics. No efficiency gain is
claimed without measurement, and sampled observations are not proof of calibration
or measured savings.

## Not doing
No replacement summarizer, desktop controller, service, private upstream controller
interfaces, synthetic continuation prompts, credential copies, or OpenCode restarts.
Stats use native plugin storage only: no telemetry service, transcript archive,
credentials, estimated savings, dashboard, or reset/delete endpoint.

## Persistent statistics
Keep lifetime totals shared across locations and reloads, with collection timestamps,
checkpoint outcomes, skip reasons, errors, requested versus observed native compactions,
requested routes, request latency, and validated TypeSafe token usage when supplied.
Keep diagnostics separate from real checkpoint evaluations. Existing volatile counters
are not historical records; durable collection starts with the version that introduced
it and is not backfilled.

Expose read-only `jevpact/stats` and include the same aggregate in `jevpact/status`.
Statistics failures must never block normal execution or alter checkpoint decisions.
Bounded persistent provider/model aggregates cover real evaluations, decision outcomes,
admitted requests by route, latency, and optional Jev usage. Detail collection has its
own start timestamp; old totals remain unassigned, never backfilled by guessing.
Diagnostics stay global and observed native completions are not attributed to Jev or a
model without evidence. No transcript, session identity, score history, or extra hosted
calls are needed for these aggregates.

Verification covers persistence across reload, concurrent updates without lost
increments, optional usage validation, privacy allow-lists, and unchanged compaction
behavior.

## Acceptance checks
1. A real authenticated TypeSafe call returns a nonempty actual model ID and valid choice distributions for the configured model.
2. Below the context floor, no hosted decision or native compaction is requested.
3. Only confidently settled transitions qualify; unknown, unresolved, or invalid evidence does not. Require strong boundary evidence (0.8) and affirmative supporting answers (0.7), with confidence at least 0.5. An explicitly configured legacy minProbability remains the floor for all answers unless minSupportingProbability is also set.
4. Native compaction is requested once per eligible checkpoint; failures preserve normal work.
5. Timeout, cancellation, malformed responses, redirects, and excerpts containing the API key are handled safely; the plugin does not promise general secret detection.
6. The plugin typechecks, its tests pass, and it loads on a supported OpenCode V2 server by native hot reload without a service restart; its live diagnostic reaches Jev with the server's existing key.
7. Model-dependent routing honors configured provider-native and OpenCode-native compaction without overriding either.
