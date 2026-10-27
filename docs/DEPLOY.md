# Deploy runbook — opencode-jevpact

Private repository. Changes land via topic PR; no automatic merge.

## 1. Install and verify

Run in `/home/james/Documents/opencode-jevpact`:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

All three must pass before the plugin is registered anywhere.

## 2. Register the plugin

Add one entry to the OpenCode `plugins` array:

```json
{
  "plugins": [
    {
      "package": "/home/james/Documents/opencode-jevpact",
      "options": {}
    }
  ]
}
```

Policy fields (`minInputTokens`, `minGrowthTokens`, `minRequests`,
`minProbability`, `minSupportingProbability`, `minConfidence`,
`cooldownMs`) go inside `options`.
Unset fields use the README defaults. OpenCode native hot reload loads the
plugin; do not restart any service.

Auth: the server's existing `TYPESAFE_API_KEY` environment value is used as
is. Do not copy it into config, write it to files, or echo it.

## 3. Live check (authenticated)

RPC methods are `jevpact/status` and `jevpact/check`. `check` calls
`https://api.typesafe.ai/v1/systemone` with model `jev-1.14.0`.
Against the existing authenticated main server, run from the repository:

```sh
node scripts/check-live.ts
```

`status` is read-only and sends nothing. `check` sends only an embedded
harmless sample, never session text. Both use the server's existing key;
nothing in these commands prints a secret.

The script uses `OPENCODE_SERVER_PASSWORD` already in the environment for
OpenCode HTTP Basic authentication and never prints it. It also prints the
running server PID and resolved OpenAI model compaction settings. When
diagnosing why a checkpoint waited, inspect `status.lastDecision` request
source and applied thresholds; it is in-memory only.

## 4. Persistence verification

Statistics are lifetime aggregates in plugin storage key `stats/v1`,
shared across locations. To verify persistence, from the repository:

1. Read stats (`jevpact/stats`, or `status.stats` in the check-live output).
2. Call `check` once.
3. Read stats again: diagnostic and usage/latency totals move, nothing resets.
4. Reload this plugin through a normal configuration change and restore its
   original enabled setting. Read stats again: totals are nondecreasing and
   the post-check `startedAt` is stable. No server restart is needed.

If saved totals cannot be read, `stats` is `null`; do not treat that as zeros.
Failed writes raise `statsStorageErrors` and may leave gaps in totals. Normal
compaction behavior continues in both cases.

## 5. Disable or roll back

- Disable: set `options.enabled` to `false`, or remove just this plugin's
  entry from the `plugins` array.
- Leave the native OpenCode compaction `auto` setting unchanged; the native
  pressure fallback keeps working with or without this plugin.
- Hot reload applies the removal; no service restart.

## 6. Safety rules

- Never commit, print, or paste `TYPESAFE_API_KEY`, tokens, or auth file
  contents. No command here outputs a secret.
- Repository stays private; ship via topic PR with typecheck and test
  evidence in the description.
