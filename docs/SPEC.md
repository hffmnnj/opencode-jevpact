# Jev checkpoints for OpenCode

## Goal
Use TypeSafe Jev to time native OpenCode compaction at useful work transitions.
Use the existing server-side TYPESAFE_API_KEY and pin jev-1.14.0 (the API rejects the shorthand jev-1.14).

## Scope
One native V2 plugin, bounded recent visible text, conservative checkpoint decisions,
native compaction, and a read-only status/check surface. Native pressure compaction stays enabled.
The same native request must honor model/provider settings: OpenAI Responses-native
compaction for the user's configured OpenAI models, OpenCode-native summarization otherwise.

## Not doing
No replacement summarizer, desktop controller, service, private Codex interfaces,
synthetic continuation prompts, credential copies, or OpenCode restarts.

## Acceptance checks
1. A real authenticated TypeSafe call returns model jev-1.14.0 and valid choice distributions.
2. Below the context floor, no hosted decision or native compaction is requested.
3. Only confidently settled transitions qualify; unknown, unresolved, or invalid evidence does not.
4. Native compaction is requested once per eligible checkpoint; failures preserve normal work.
5. Timeout, cancellation, malformed responses, redirects, and secret-bearing excerpts are handled safely.
6. The plugin typechecks, its tests pass, loads on the existing 2.1.4 server without a restart, and its live diagnostic reaches Jev with the existing server key.
7. Model-dependent routing retains configured OpenAI-native and OpenCode-native compaction without overriding either; gpt-6.1-terra is explicitly configured native as requested.
