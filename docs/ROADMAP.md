# Roadmap

## Current behavior
- Native OpenCode V2 plugin that asks TypeSafe Jev whether the current work is a useful
  transition and, if so, requests one native compaction. It never summarizes, rewrites,
  or continues the session, and adds no separate service or resume mechanism.
- The hosted endpoint and `TYPESAFE_API_KEY` source are fixed. `model` accepts a validated
  hosted model ID or alias; the default remains `jev-1.14.0`. Status reports the configured
  model while responses report the actual model, which can differ for an alias.
- Conservative policy defaults remain 100k input tokens, 30k growth tokens, three distinct
  requests, a 60-second cooldown, 0.8 boundary probability, 0.7 supporting probability and
  0.5 confidence. Below the context floor nothing is sent. Any contrary or `unknown` choice
  vetoes a checkpoint.
- Evidence is bounded, source-linked visible text with recent chronology. Peer traffic is
  not treated as user direction, summary-only context is labelled, and only completed
  progress-list updates may follow a report without further interpretation. Truncated,
  filtered, errored, unknown-finish, or still-streaming reports are not completed checkpoints.
- Judgments run out of band and never delay model dispatch. Timeout, cancellation, malformed
  responses, redirects, or invalid answers fail open and leave normal execution unchanged;
  there are no automatic transport retries.
- Model settings choose the compactor: provider-native where configured, OpenCode-native
  summarization otherwise. The plugin does not override that routing, and native pressure
  compaction remains the fallback.
- Lifetime statistics live in native plugin storage and survive reloads and restarts. They
  hold allow-listed counters, fixed skip reasons, latency, validated TypeSafe usage, route
  counts and bounded provider/model aggregates. Diagnostics are separate from real
  evaluations. No transcript text, session identity, credentials, error strings, or estimated
  savings are stored.
- Read-only `jevpact/status` and `jevpact/stats` RPCs are available, plus `jevpact/check`,
  which makes one live Jev call with an embedded harmless sample and never session text.

## Limitations
- Thresholds are provisional. No accuracy or token-savings claim is made without workload
  measurement, and sampled observations do not prove calibration.
- Only visible text is considered. After summary-mode compaction, evidence carries a labelled
  summary excerpt rather than raw requests, so those judgments rest on that context.
- Evaluation needs network access and the server's existing key; without the key the plugin
  reports unconfigured and does nothing. Hosted evaluation sends bounded session evidence
  outside the machine, with only the documented API-key redaction; arbitrary sensitive text
  is not promised to be detected.
- Native completion events are observed globally and are not attributed to this plugin or a
  model. An admitted request is not proof of completed compaction.
- If saved totals cannot be read, statistics are `null`, never fake zeros. Failed writes raise
  the in-memory storage-error counter and can leave gaps; normal compaction behavior continues.
- Actual provider compactions were not forced on active sessions during verification.
  Unit and integration tests cover both route settings; native routing and resume semantics
  were source-reviewed rather than exercised end to end.

## Next steps
- Measure checkpoint frequency and classifier token cost on real workloads before tuning
  thresholds or claiming efficiency gains.
- Keep policy changes evidence-driven; do not tune solely to increase compaction counts or
  force compaction on active sessions.
- Re-check live diagnostics and both routing modes when the host plugin API or configured
  models change.
- Preserve the fixed endpoint, existing credential source, native pressure fallback and
  conservative defaults unless a measured need justifies a change.
