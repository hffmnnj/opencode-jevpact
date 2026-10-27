# opencode-jevpact

Jev-timed native context compaction for OpenCode V2.

The plugin asks TypeSafe Jev whether the current work looks like a useful
transition, and if so requests one native OpenCode compaction. It never
summarizes, rewrites, or continues the session itself.

Inspired by [transcendr/jevpact](https://github.com/transcendr/jevpact)
(CC BY 4.0, by Slopware Engineer — https://x.com/aienginerd). This is an
original native OpenCode V2 plugin in that spirit, not a verbatim port.

## How it works

- Hosted endpoint: `https://api.typesafe.ai/v1/systemone`
- Model: `jev-1.14.0` (the shorthand `jev-1.14` is rejected by the API)
- Auth uses the existing `TYPESAFE_API_KEY` from the OpenCode server
  environment. The plugin never copies the key, writes it to disk, or logs it.
- OpenCode native compaction and the native pressure fallback remain
  authoritative. This plugin only times the request; it is not a replacement
  summarizer, service, desktop controller, or resume mechanism.
- Model settings select the compactor: OpenAI Responses-native compaction for
  configured OpenAI models, OpenCode-native summary compaction otherwise.
  The plugin never overrides that routing or the compaction hook's result.
- Judgments run out of band and never delay model dispatch. A Jev failure
  preserves normal work. There are no automatic transport retries.

## What is sent

- Source-linked current/prior requests, current report, and recent visible
  chronology, capped at 24 KiB. Current source requests and the report are
  never truncated; if they cannot fit, the checkpoint is skipped.
- Never sent: tool bodies, system instructions, attachments, hidden reasoning.
- If the exact API key string appears inside the evidence excerpt, it is
  redacted before sending. Arbitrary source text may still contain other
  sensitive information, so this is not a promise of full secret detection.
  Do not paste secrets into the session and expect the plugin to catch them.

## What is stored

Status keeps only counts, choices, and error strings. No transcript text and
no credentials are stored. A checkpoint message ID is persisted for reload
deduplication. Top-level status counters cover the current plugin instance;
lifetime aggregate totals live in `status.stats` (see Statistics below).

## Statistics

Lifetime aggregate totals live in native OpenCode plugin storage under key
`stats/v1`, shared across locations and surviving plugin reloads and server
restarts. Durable collection starts with this version: earlier in-memory
counts are not recoverable history and are not backfilled. There is no
telemetry service, transcript archive, daily history, dashboard, reset/delete
endpoint, or estimated savings or cost.

The stored shape holds only timestamps, allow-listed counters, the fixed
skip reasons, cumulative and maximum latency, validated TypeSafe
input/output token totals with a usage sample count, and requested route
counts by mode. No error strings, session content, credentials, or arbitrary
response metadata are stored.

- TypeSafe usage is optional: missing or malformed usage is unknown, not a
  fabricated zero. Only validated input/output pairs add a usage sample.
- Diagnostic calls have separate counts from real checkpoint evaluations,
  but known token usage and latency include both, so diagnostics' API
  consumption is not hidden.
- `compactionsRequested` counts plugin native admissions, while
  `compactionsCompleted`/`compactionsFailed` count all native completion and
  failure events observed by the plugin, including native manual and
  pressure events. They are observed, not attributed savings.
- The durable aggregate is served in `status.stats` and the read-only
  `jevpact/stats` RPC. Both carry a `statsStorageErrors` collection/persistence
  failure count (in memory, itself not durable when writes fail). If
  saved totals cannot be read, `stats` is `null` rather than fake zeros.
  Failed writes also raise this indicator and can leave gaps in the totals;
  normal compaction behavior continues.

Read the aggregate via `POST /api/rpc/jevpact/stats` with body `{"input":{}}`
using the server's existing OpenCode authentication. `node scripts/check-live.ts`
prints the full status output, including `status.stats`.

## What carries over from JevPact

The source review covered its controller state machine, `timing-context.js`,
`transcript.js`, `policy.js`, Jev rubrics, and associated tests, not just the README.

- Preserve source-linked current/prior requests and referential context.
- Refuse old-turn checkpoints after new direction, incomplete source coverage,
  and tool activity that has no later assistant interpretation, before calling Jev.
- Count token-bearing model responses since compaction, including tool-only
  steps. Use the first post-compaction usage as the growth baseline.
- Observe actual native completion; an admitted request is not completion.
- Cancel stale decisions on prompts, new execution steps, stops, deletion, and unload.

Unlike the Codex controller, no pause/deferral/resume messages, local service,
rollout parser, or recovery-state database are needed. OpenCode already queues
compaction safely and owns continuation. Native context pressure remains the fallback.
The thresholds are intentionally conservative; no token-saving or accuracy improvement
is claimed without workload measurement.

## Setup

Add one entry to the OpenCode `plugins` array (native hot reload picks it
up; no service restart):

```json
{
  "plugins": [
    {
      "package": "/home/example/Documents/opencode-jevpact",
      "options": {}
    }
  ]
}
```

### Policy options

All fields are optional; unset fields use the provisional defaults:

| Option | Default | Meaning |
|---|---|---|
| `minInputTokens` | `100000` | Minimum context size before any evaluation |
| `minGrowthTokens` | `30000` | Minimum growth since the post-compaction baseline |
| `minRequests` | `3` | Minimum distinct model steps before evaluating |
| `minProbability` | `0.8` | Minimum settled probability to qualify |
| `minConfidence` | `0.5` | Minimum answer confidence to qualify |
| `cooldownMs` | `60000` | Minimum gap between evaluations |
| `enabled` | `true` | Set `false` to disable without removing the entry |

Below the context floor nothing is sent and no compaction is requested.
Only confidently settled transitions qualify; unknown, unresolved, or
invalid evidence does not trigger compaction.

## Limitations

- Needs the server's existing `TYPESAFE_API_KEY`; without it the plugin
  reports unconfigured and does nothing.
- Calls the hosted Jev endpoint, so evaluation needs network access.
- Only visible text is considered, so it cannot see hidden state.
- Threshold defaults are provisional and may need tuning for your workload.
- Checkpoints are considered before model requests and at successful turn
  completion. An active turn continues through OpenCode's own runner after
  compaction; an idle turn stays idle. New direction or stops cancel stale decisions.

## Diagnostics

Read-only live RPC methods (use the server's existing key):

- `jevpact/status` — loaded, configured, and last-decision counts.
- `jevpact/stats` — lifetime aggregate totals (read-only; `null` when storage is unavailable).
- `jevpact/check` — one live Jev call using an embedded harmless sample,
  never session text.

See `docs/DEPLOY.md` for commands. Never put real secrets in config files,
issue text, or pasted command output.
