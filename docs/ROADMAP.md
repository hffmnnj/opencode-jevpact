# Roadmap

## Done
- Inspected JevPact and native V2 plugin documentation.
- Verified the existing key is present in both the tool and main-server environments.
- Proved jev-1.14.0 returns HTTP 200; the shorthand jev-1.14 returns unknown model.
- Created the private repository and topic branch.
- Built the bounded hosted client, conservative policy, evidence selector, and native hook/RPC integration.
- Typecheck and all 60 tests passed, including both routing settings, source-coverage/chronology guards, nonblocking dispatch, and stale-decision cancellation.
- Confirmed the 2.1.4 runner uses model settings to select provider-native versus summary compaction.
- Added explicit native compaction for gpt-6.1-terra; the running server reports native for Terra, Sol, and Luna.
- Independent safety review found no activation blockers.
- Deep original-source analysis identified current-turn, coverage, and chronology guards; implemented those without copying Codex controller machinery.
- Live disabled-action diagnostic loaded on the existing PID 219124, found the server key, observed events, and returned valid Jev answers.
- Confirmed live context order is chronological and the active model reference matches the resolved inventory.
- Enabled globally; live status reports configured, active, observing events, and zero errors on the unchanged main server PID.
- Final live Jev diagnostic returned valid jev-1.14.0 answers in 126 ms; resolved Terra/Sol/Luna routes are native, Anthropic/Go examples are summary.
- Confirmed native auto compaction, its 28000-token buffer, and background compaction remain unchanged.
- Original plugin merged: https://github.com/hffmnnj/opencode-jevpact/pull/1.
- Added lifetime statistics in native plugin storage, separate diagnostics, validated TypeSafe token usage, skip/outcome totals, and route/latency counters.
- Stats follow-up: typecheck and all 85 tests passed; independent concurrency/privacy/failure-containment review passed.
- Live diagnostic recorded 910 input and 110 output tokens; after a real evaluation, totals were 6933 input and 220 output across two usage samples.
- Verified totals and collection timestamp survive plugin configuration reloads on unchanged PID 219124; plugin enabled and stats collection errors zero.
- Published the persistent-stats follow-up: https://github.com/hffmnnj/opencode-jevpact/pull/2.

## Follow-ups
- Observe real-workload checkpoint frequency and token cost; no efficiency gain is claimed yet.
- Actual provider compactions were not forced on active sessions during installation. Unit integration checks cover both route settings; native routing/resume semantics were source-reviewed.
