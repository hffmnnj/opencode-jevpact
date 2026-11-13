![Jevpact: Keep what matters.](assets/banner.png)

# opencode-jevpact

Jev-timed native context compaction for OpenCode V2.

The plugin asks TypeSafe Jev whether the current work looks like a useful
transition, and if so requests one native OpenCode compaction. It never
summarizes, rewrites, or continues the session itself.

This is a private source plugin loaded from a local checkout, not a published
npm package. It runs inside the existing OpenCode server; no separate local
service is involved.

Inspired by [transcendr/jevpact](https://github.com/transcendr/jevpact)
(CC BY 4.0, by Slopware Engineer, https://x.com/aienginerd). This is an
original native OpenCode V2 plugin in that spirit, not a verbatim port.

## How it works

- Hosted endpoint: `https://api.typesafe.ai/v1/systemone`
- Model: `jev-1.14.0` (the shorthand `jev-1.14` is rejected by the API)
- Auth uses the existing `TYPESAFE_API_KEY` from the OpenCode server
  environment. The plugin never copies the key, writes it to disk, or logs it.
- OpenCode native compaction and the native pressure fallback remain
  authoritative. This plugin only times the request; it is not a replacement
  summarizer, service, desktop controller, or resume mechanism.
- Model settings select the compactor: provider-native compaction for models
  configured for it (for example, OpenAI Responses-native models), and
  OpenCode-native summary compaction otherwise. The plugin never overrides
  that routing or the compaction hook's result.
- Judgments run out of band and never delay model dispatch. A Jev failure
  preserves normal work. There are no automatic transport retries.

## What is sent

- Source-linked current and prior requests, the current report, and recent
  visible chronology, capped at 24 KiB. Current source requests and the report
  are never truncated; if they cannot fit, the checkpoint is skipped.
- Request text is the actual visible text retained by native compaction, not a
  reconstruction. Peer messages marked
  `metadata.source='opencode-cross-communication'` are never labelled as user
  requests; retained task context stays separated from them.
- When native compaction kept only a summary and no raw requests, the excerpt
  carries a clearly labelled bounded visible summary excerpt as context.
  Recovered goal text is evidence for the checkpoint judgment only, not a new
  instruction or authority.
- A completed `todowrite`-only update after the report counts as administrative
  bookkeeping. Shell/patch/read/subagent results, running or errored todos, and
  newer peer/child results still wait for interpretation.
- The report must have an explicit successful finish and completion timestamp.
  Truncated, filtered, unknown-finish, errored, or still-streaming text is not
  treated as a completed checkpoint, even if it sounds settled.
- Never sent: native encrypted state, tool result bodies, todo input/result
  bodies, system instructions, attachments, hidden reasoning.
- If the exact API key string appears inside the evidence excerpt, it is
  redacted before sending. Arbitrary source text may still contain other
  sensitive information, so this is not a promise of full secret detection.
  Do not paste secrets into the session and expect the plugin to catch them.

## What is stored

Status keeps only counts, choices, and error strings. No transcript text and no
credentials are stored. The in-memory `lastDecision` also records
session/checkpoint identity, request source, and applied thresholds so a missed
checkpoint can be traced; it persists no transcript and leaves the lifetime
stats schema unchanged. A checkpoint message ID is persisted for reload
deduplication. Top-level status counters cover the current plugin instance;
lifetime aggregate totals live in `status.stats` (see Statistics below).

## Statistics

Lifetime totals live in native OpenCode plugin storage under key `stats/v1`,
shared across locations. The stored totals survive plugin reloads and server
restarts. Durable collection starts with this version: earlier in-memory counts
are not recoverable history and are not backfilled. There is no telemetry
service, transcript archive, dashboard, reset/delete endpoint, or estimated
savings or cost.

The stored shape holds only a schema version, timestamps, allow-listed counters,
the fixed skip reasons, cumulative and maximum latency, validated TypeSafe
input/output token totals with a usage sample count, and requested route counts
by mode. No error strings, session content, credentials, or arbitrary response
metadata are stored.

- TypeSafe usage is optional: missing or malformed usage is unknown, not a
  fabricated zero. Only validated input/output pairs add a usage sample.
- Diagnostic calls have separate counts from real checkpoint evaluations, but
  known token usage and latency include both, so diagnostics' API consumption
  is not hidden.
- `compactionsRequested` counts plugin native admissions, while
  `compactionsCompleted` and `compactionsFailed` count all native completion
  and failure events observed by the plugin, including native manual and
  pressure events. They are observed, not attributed savings.
- The durable aggregate is served in `status.stats` and the read-only
  `jevpact/stats` RPC. Both carry `statsStorageErrors`, which counts collection
  and persistence failures. That counter lives in memory and is not durable
  when writes fail. If saved totals cannot be read, `stats` is `null` rather
  than fake zeros. Failed writes also raise this indicator and can leave gaps
  in the totals; normal compaction behavior continues.

Read the aggregate via `POST /api/rpc/jevpact/stats` with body `{"input":{}}`
using the server's existing OpenCode authentication.
`node scripts/check-live.ts` prints the full status output, including
`status.stats`.

### Model breakdown

`stats.modelDetails` adds its own `startedAt` and up to 128 provider/model
rows. Each row reports real evaluation outcomes, admitted compaction requests
by route, Jev latency, and validated Jev token usage. Usage measures the
classifier call, not the primary model or the compaction operation.

Old totals are preserved without backfilling model identities. The difference
between global evaluation/request counts and the sum of their model rows is
unassigned history (or an identity beyond the bounded row limit). Global usage
and latency additionally include diagnostics. Detail starts on the first
model-attributed event; it can be absent until then. Diagnostics remain global
and do not inflate any model row. Observed native completions remain global:
an admitted request is not proof of completed compaction.

Only validated provider/model identifiers and numeric aggregates are added; no
session IDs, transcripts, or individual score histories are stored.

## What carries over from JevPact

The source review covered its controller state machine, `timing-context.js`,
`transcript.js`, `policy.js`, Jev rubrics, and associated tests, not just the
README.

- Preserve source-linked current and prior requests and referential context.
- Refuse old-turn checkpoints after new direction, incomplete source coverage,
  and tool activity that has no later assistant interpretation, before calling
  Jev.
- Count token-bearing model responses since compaction, including tool-only
  steps, from the first post-compaction usage as the growth baseline.
- Observe actual native completion; an admitted request is not completion.
- Cancel stale decisions on prompts, new execution steps, stops, deletion, and
  unload.

Unlike the Codex controller, no pause, deferral, or resume messages, local
service, rollout parser, or recovery-state database are needed. OpenCode
already queues compaction safely and owns continuation. Native context
pressure remains the fallback. The thresholds are intentionally conservative;
no token-saving or accuracy improvement is claimed without workload
measurement.

## Install

Place the checkout at a stable absolute path, then add one entry to the
OpenCode `plugins` array. Replace `/path/to/opencode-jevpact` with the
checkout location:

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-jevpact",
      "options": {}
    }
  ]
}
```

OpenCode native hot reload picks it up; no service restart is needed. The
plugin reads the existing `TYPESAFE_API_KEY` from the OpenCode server
environment and never copies it into config or files.

### Policy options

Fields below go inside `options`; all are optional and unset fields use the
defaults shown:

| Option | Default | Meaning |
|---|---|---|
| `minInputTokens` | `100000` | Minimum context size before any evaluation |
| `minGrowthTokens` | `30000` | Minimum growth since the post-compaction baseline |
| `minRequests` | `3` | Minimum distinct model steps before evaluating |
| `minProbability` | `0.8` | Minimum boundary probability to qualify |
| `minSupportingProbability` | `0.7` | Minimum settled=`yes` and open_result=`no` probability to qualify |
| `minConfidence` | `0.5` | Minimum answer confidence to qualify |
| `cooldownMs` | `60000` | Minimum gap between evaluations |
| `enabled` | `true` | Set `false` to disable without removing the entry |

Below the context floor nothing is sent and no compaction is requested.
Boundary and settled must answer `yes`, and open_result must answer `no`;
any contrary or `unknown` choice vetoes the checkpoint. The boundary bar
stays at 0.8 while the two supporting answers default to 0.7: a real
completed-work case with 0.74 no-open-result support was wrongly rejected by a
blanket 0.8. No accuracy or savings claim is made for this change. Setting only
the legacy `minProbability` keeps one explicit threshold for all three answers;
setting both opts into the asymmetry. Context floor (100k), growth (30k),
request count (3), and cooldown (60s) are unchanged.

## Development

Node 26 or newer. From the checkout:

```sh
cd /path/to/opencode-jevpact
npm ci --ignore-scripts
npm run typecheck
npm test
```

Run these before registering the plugin. The checkout is loaded directly; no
packaging or publish step is required.

## Limitations

- Needs the server's existing `TYPESAFE_API_KEY`; without it the plugin
  reports unconfigured and does nothing.
- Calls the hosted Jev endpoint, so evaluation needs network access.
- Only visible text is considered, so it cannot see hidden state. After
  summary-mode compaction the evidence carries a labelled summary excerpt
  rather than raw requests; judgments there rest on that context.
- Threshold defaults are provisional and may need tuning for your workload.
- Checkpoints are considered before model requests and at successful turn
  completion. An active turn continues through OpenCode's own runner after
  compaction; an idle turn stays idle. New direction or stops cancel stale
  decisions.

## Diagnostics

Live RPC methods (use the server's existing authentication):

- `jevpact/status` is read-only: enabled and configured state, event-stream
  health, counters, and the in-memory `lastDecision` with its
  session/checkpoint identity, request source, applied thresholds, and Jev's
  answers.
- `jevpact/stats` is read-only: lifetime aggregate totals, or `null` when
  saved totals cannot be read.
- `jevpact/check` makes one live Jev call using an embedded harmless sample,
  never session text.

See [docs/DEPLOY.md](docs/DEPLOY.md) for commands. Never put real secrets in
config files, issue text, or pasted command output.
