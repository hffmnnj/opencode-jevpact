import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Plugin } from "@opencode/plugin";
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import { createPlugin } from "../src/plugin.ts";
import { snapshot } from "../src/evidence.ts";
import type { Evaluation, Evidence } from "../src/types.ts";
import type { StatsSnapshot } from "../src/stats-types.ts";

const directory = "/test/jevpact";
const yes = { type: "choice", choice: "yes", confidence: 0.95, probabilities: { yes: 0.95, no: 0.03, unknown: 0.02 } } as const;
const no = { type: "choice", choice: "no", confidence: 0.95, probabilities: { yes: 0.03, no: 0.95, unknown: 0.02 } } as const;
const approval: Evaluation = { model: "jev-1.14.0", answers: { boundary: yes, settled: yes, open_result: no }, latencyMs: 1 };

function assistant(id = "msg_finished", input = 120_000): SessionMessageInfo {
  return { type: "assistant", id, agent: "build", model: { providerID: "openai", id: "gpt-6.1-terra" }, content: [{ type: "text", text: "Implementation is complete. Tests passed. Next I will deploy." }], tokens: { input, output: 100, reasoning: 0, cache: { read: 3_000, write: 0 } }, time: { created: 1, completed: 2 } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(options: {
  native?: boolean;
  input?: number;
  enabled?: boolean;
  judge?: (evidence: Evidence, options: { signal?: AbortSignal }) => Promise<Evaluation>;
  storage?: Map<string, unknown>;
  admissionError?: boolean;
  minRequests?: number;
  now?: number;
  statsStorageFailure?: "read" | "write";
} = {}) {
  const hooks = new Map<string, (event: unknown) => Promise<void>>();
  const methods = new Map<string, (input: unknown, call: { signal: AbortSignal }) => Promise<unknown>>();
  const storage = options.storage ?? new Map<string, unknown>();
  const compactCalls: unknown[] = [];
  const judgments: Evidence[] = [];
  const admitted = deferred<void>();
  let messages = [assistant("msg_initial", 80_000), assistant("msg_finished", options.input ?? 120_000)];
  let controller!: ReadableStreamDefaultController<OpenCodeEvent>;
  const stream = new ReadableStream<OpenCodeEvent>({ start(value) { controller = value; } });
  const model = { id: "gpt-6.1-terra", providerID: "openai", settings: options.native === false ? {} : { compaction: { type: "native" } }, limit: { context: 400_000 } };
  const context = {
    options: { minRequests: options.minRequests ?? 1, cooldownMs: 0, enabled: options.enabled ?? true },
    location: { directory },
    model: { list: async () => ({ data: [model] }) },
    storage: {
      get: async (key: string) => {
        if (key === "stats/v1" && options.statsStorageFailure === "read") throw new Error("private storage detail");
        return structuredClone(storage.get(key));
      },
      set: async (key: string, value: unknown) => {
        if (key === "stats/v1" && options.statsStorageFailure === "write") throw new Error("private storage detail");
        storage.set(key, structuredClone(value));
      },
    },
    rpc: { register: async (_definition: unknown, handlers: Record<string, (input: unknown, call: { signal: AbortSignal }) => Promise<unknown>>) => { for (const [name, handler] of Object.entries(handlers)) methods.set(name, handler); } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      const reader = stream.getReader();
      const cancel = () => { void reader.cancel(); };
      signal.addEventListener("abort", cancel, { once: true });
      try { for (;;) { const value = await reader.read(); if (value.done) return; yield value.value; } }
      finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
    } },
    session: {
      get: async () => ({ location: { directory }, model, outcome: "succeeded" }),
      context: async () => messages,
      compact: async (input: unknown) => { if (options.admissionError) throw new Error("admission failed"); compactCalls.push(input); admitted.resolve(); },
      hook: async (name: string, handler: (event: unknown) => Promise<void>) => { hooks.set(name, handler); },
    },
  };
  const plugin = createPlugin({ apiKey: () => "test-key", now: () => options.now ?? 100_000, evaluate: async (evidence, call) => { judgments.push(evidence); return options.judge ? options.judge(evidence, call) : approval; } });
  // The fake models the documented plugin context only; it cannot implement native compaction itself.
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);
  assert.equal(typeof cleanup, "function");
  return {
    compactCalls, judgments, storage, model, admitted: admitted.promise,
    context: async () => {
      await hooks.get("context")!({ sessionID: "ses_test", model });
      // Drain the fake's immediately resolved I/O promises, without waiting on hosted work.
      await setImmediate();
    },
    prompt: async () => { await hooks.get("prompt")!({ sessionID: "ses_test" }); },
    status: async () => await methods.get("status")!({}, { signal: new AbortController().signal }) as Record<string, unknown>,
    stats: async () => await methods.get("stats")!({}, { signal: new AbortController().signal }) as { stats: StatsSnapshot | null; statsStorageErrors: number },
    check: async () => await methods.get("check")!({}, { signal: new AbortController().signal }) as { ok: boolean },
    emit: (type: "session.execution.succeeded" | "session.execution.interrupted" | "session.compaction.ended" | "session.synthetic") => controller.enqueue({ type, location: { directory }, data: { sessionID: "ses_test", reason: type === "session.compaction.ended" ? "manual" : "user", text: "" } } as OpenCodeEvent),
    messages: (value: SessionMessageInfo[]) => { messages = value; },
    close: async () => { await cleanup!(); },
  };
}

for (const native of [true, false]) {
  test(`settled checkpoint requests native API without replacing ${native ? "OpenAI" : "OpenCode"} route`, async () => {
    const app = await harness({ native });
    try {
      await app.context();
      assert.deepEqual(app.compactCalls, [{ sessionID: "ses_test" }]);
      assert.equal(app.judgments.length, 1);
      assert.deepEqual(app.model.settings, native ? { compaction: { type: "native" } } : {});
      const status = await app.status();
      assert.equal((status.lastDecision as Record<string, unknown>).mode, native ? "provider-native" : "opencode-summary");
      await app.context();
      assert.equal(app.compactCalls.length, 1);
    } finally { await app.close(); }
  });
}

test("below context floor and disabled plugin never call hosted Jev or compact", async () => {
  for (const options of [{ input: 200 }, { enabled: false }]) {
    const app = await harness(options);
    try { await app.context(); assert.deepEqual(app.judgments, []); assert.deepEqual(app.compactCalls, []); }
    finally { await app.close(); }
  }
});

test("unresolved evidence and transport failures preserve normal execution", async () => {
  for (const judge of [async () => ({ ...approval, answers: { ...approval.answers, open_result: yes } }), async (): Promise<Evaluation> => { throw new Error("private upstream detail"); }]) {
    const app = await harness({ judge });
    try { await app.context(); assert.equal(app.judgments.length, 1); assert.deepEqual(app.compactCalls, []); assert.ok(!JSON.stringify(await app.status()).includes("private upstream detail")); }
    finally { await app.close(); }
  }
});

test("new user direction cancels an in-flight positive judgment", async () => {
  const started = deferred<void>();
  const result = deferred<Evaluation>();
  const app = await harness({ judge: async () => { started.resolve(); return result.promise; } });
  try {
    const pending = app.context();
    await started.promise;
    await app.prompt();
    result.resolve(approval);
    await pending;
    assert.deepEqual(app.compactCalls, []);
  } finally { await app.close(); }
});

test("checkpoint identity survives reload and prevents duplicate admission", async () => {
  const storage = new Map<string, unknown>();
  const first = await harness({ storage });
  await first.context();
  assert.equal(first.compactCalls.length, 1);
  await first.close();
  const second = await harness({ storage });
  try { await second.context(); assert.deepEqual(second.compactCalls, []); assert.deepEqual(second.judgments, []); }
  finally { await second.close(); }
});

test("failed native admission is contained and status never reports completion", async () => {
  const app = await harness({ admissionError: true });
  try { await app.context(); const status = await app.status(); assert.equal(status.errors, 1); assert.equal(status.compactionsRequested, 0); assert.equal(status.compactionsCompleted, 0); }
  finally { await app.close(); }
});

test("successful idle checkpoint can compact without any continuation prompt", async () => {
  const app = await harness();
  try {
    app.emit("session.execution.succeeded");
    await app.admitted;
    assert.deepEqual(app.compactCalls, [{ sessionID: "ses_test" }]);
    assert.equal(app.judgments.length, 1);
  } finally { await app.close(); }
});

test("user stop event cancels a positive hosted decision before admission", async () => {
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const result = deferred<Evaluation>();
  const app = await harness({ judge: async (_evidence, call) => {
    call.signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
    started.resolve();
    return result.promise;
  } });
  try {
    const pending = app.context();
    await started.promise;
    app.emit("session.execution.interrupted");
    await cancelled.promise;
    result.resolve(approval);
    await pending;
    assert.deepEqual(app.compactCalls, []);
  } finally { await app.close(); }
});

test("evidence excludes reasoning, tool bodies, system text, and attachments", () => {
  const visible = assistant();
  assert.equal(visible.type, "assistant");
  if (visible.type !== "assistant") throw new Error("fixture");
  const messages: SessionMessageInfo[] = [
    { type: "system", id: "msg_system", time: { created: 0 }, text: "SYSTEM_SECRET" },
    { type: "synthetic", id: "msg_control", time: { created: 0 }, text: "CONTROLLER_SECRET" },
    { type: "user", id: "msg_user", time: { created: 0 }, text: "Build the feature", files: [{ data: "ATTACHMENT_SECRET", mime: "text/plain", source: { type: "inline" } }] },
    { ...visible, id: "msg_tool", content: [{ type: "reasoning", text: "REASONING_SECRET" }, { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "TOOL_SECRET" }] }, time: { created: 0 } }] },
    { ...visible, content: [{ type: "text", text: "The inspected code confirms the implementation is complete." }] },
  ];
  const view = snapshot(messages, 400_000)!;
  assert.ok(view.evidence.excerpt.includes("Build the feature"));
  assert.ok(view.evidence.excerpt.includes("implementation is complete"));
  for (const secret of ["ATTACHMENT_SECRET", "REASONING_SECRET", "TOOL_SECRET", "SYSTEM_SECRET", "CONTROLLER_SECRET"]) assert.ok(!view.evidence.excerpt.includes(secret));
  assert.ok(view.evidence.excerpt.indexOf("Earlier tool result bodies omitted") < view.evidence.excerpt.indexOf("implementation is complete"));
  assert.equal(view.evidence.inputTokens, 123_100);
});

test("completed compaction drops old usage and cannot trigger an immediate loop", async () => {
  const compacted: SessionMessageInfo = { type: "compaction", id: "msg_compacted", time: { created: 3 }, status: "completed", reason: "manual", summary: "OLD_SUMMARY" };
  assert.equal(snapshot([assistant(), compacted], 400_000), undefined);
  const app = await harness();
  try {
    app.messages([assistant(), compacted, assistant("msg_after", 105_000)]);
    await app.context();
    assert.deepEqual(app.judgments, []);
    app.messages([compacted, assistant("msg_later", 140_000)]);
    await app.context();
    assert.equal(app.compactCalls.length, 1);
  } finally { await app.close(); }
});

test("older chronology may be trimmed but source request and current report stay complete", () => {
  const messages: SessionMessageInfo[] = Array.from({ length: 12 }, (_, index) => {
    const value = assistant(`msg_${index}`);
    if (value.type !== "assistant") throw new Error("fixture");
    return { ...value, content: [{ type: "text" as const, text: '日本語\\"\n'.repeat(10_000) }] };
  });
  messages.unshift({ type: "user", id: "msg_user", time: { created: 0 }, text: "Keep the complete current request" });
  messages.push(assistant("msg_current"));
  const view = snapshot(messages, 400_000)!;
  assert.ok(view.evidence.excerpt.includes("older messages or entries omitted"));
  assert.ok(view.evidence.excerpt.includes("Keep the complete current request"));
  assert.ok(view.evidence.excerpt.includes("Implementation is complete. Tests passed. Next I will deploy."));
  assert.ok(Buffer.byteLength(JSON.stringify(view.evidence.excerpt)) <= 24 * 1024);
});

test("new user direction never inherits an earlier assistant checkpoint", () => {
  const user: SessionMessageInfo = { type: "user", id: "msg_new", time: { created: 3 }, text: "Actually do something else" };
  assert.equal(snapshot([assistant(), user], 400_000), undefined);
});

test("opaque tool activity after a report vetoes a confident checkpoint before Jev", () => {
  const value = assistant();
  if (value.type !== "assistant") throw new Error("fixture");
  const report: SessionMessageInfo = { ...value, content: [...value.content, { type: "tool", id: "call_1", name: "test", state: { status: "completed", input: {}, content: [{ type: "text", text: "uninterpreted result" }] }, time: { created: 2 } }] };
  assert.equal(snapshot([report], 400_000), undefined);
});

test("oversized current request or report refuses judgment rather than truncating", () => {
  const longUser: SessionMessageInfo = { type: "user", id: "msg_long", time: { created: 0 }, text: "x".repeat(25_000) };
  assert.equal(snapshot([longUser, assistant()], 400_000), undefined);
  const value = assistant();
  if (value.type !== "assistant") throw new Error("fixture");
  assert.equal(snapshot([{ ...value, content: [{ type: "text", text: "y".repeat(25_000) }] }], 400_000), undefined);
});

test("referential follow-up includes previous request and its final report", () => {
  const initial: SessionMessageInfo = { type: "user", id: "msg_first", time: { created: 0 }, text: "Implement and deploy a parser" };
  const prior = assistant("msg_prior");
  if (prior.type !== "assistant") throw new Error("fixture");
  const followup: SessionMessageInfo = { type: "user", id: "msg_followup", time: { created: 3 }, text: "Do it" };
  const view = snapshot([initial, { ...prior, finish: "stop" }, followup, assistant("msg_current")], 400_000)!;
  assert.ok(view.evidence.excerpt.includes("Previous user request [msg_first]: Implement and deploy a parser"));
  assert.ok(view.evidence.excerpt.includes("Current user request [msg_followup]: Do it"));
  assert.ok(view.evidence.excerpt.includes("Previous final report (referential context only) [msg_prior]"));
});

test("hosted evaluation does not block the model context hook", async () => {
  const result = deferred<Evaluation>();
  const app = await harness({ judge: async () => result.promise });
  try {
    await app.context();
    assert.equal(app.judgments.length, 1);
    assert.deepEqual(app.compactCalls, []);
    result.resolve(approval);
    await app.admitted;
    assert.equal(app.compactCalls.length, 1);
  } finally { result.resolve(approval); await app.close(); }
});

test("admission is not counted as completion until the native completion event", async () => {
  const app = await harness();
  try {
    await app.context();
    const admitted = await app.status();
    assert.equal(admitted.compactionsRequested, 1);
    assert.equal(admitted.compactionsCompleted, 0);
    app.emit("session.compaction.ended");
    await setImmediate();
    assert.equal((await app.status()).compactionsCompleted, 1);
  } finally { await app.close(); }
});

test("three model requests count even when the middle request is tool-only", async () => {
  const middle = assistant("msg_tools", 100_000);
  if (middle.type !== "assistant") throw new Error("fixture");
  const app = await harness({ minRequests: 3 });
  try {
    app.messages([assistant("msg_first", 80_000), { ...middle, content: [{ type: "tool", id: "call_1", name: "test", state: { status: "completed", input: {}, content: [{ type: "text", text: "result omitted" }] }, time: { created: 2 } }] }, assistant("msg_last", 120_000)]);
    await app.context();
    assert.equal(app.judgments.length, 1);
    assert.deepEqual(app.compactCalls, [{ sessionID: "ses_test" }]);
  } finally { await app.close(); }
});

test("lifetime statistics survive a fresh plugin instance and status reads are nonmutating", async () => {
  const storage = new Map<string, unknown>();
  const first = await harness({ storage, now: 100_000 });
  await first.context();
  const initial = (await first.stats()).stats!;
  assert.equal(initial.evaluations, 1);
  assert.equal(initial.compactDecisions, 1);
  assert.equal(initial.compactionsRequested, 1);
  assert.equal(initial.requestedByMode["provider-native"], 1);
  assert.deepEqual((await first.status()).stats, initial);
  await first.close();

  const second = await harness({ storage, now: 200_000 });
  try {
    assert.deepEqual((await second.stats()).stats, initial);
    assert.deepEqual((await second.stats()).stats, initial);
    await second.context();
    const restored = (await second.stats()).stats!;
    assert.equal(restored.startedAt, initial.startedAt);
    assert.equal(restored.evaluations, 1);
    assert.equal(restored.compactionsRequested, 1);
    assert.equal(restored.skips.duplicate, 1);
    assert.equal(restored.updatedAt, 200_000);
  } finally { await second.close(); }
});

test("diagnostic usage is counted without inflating real checkpoint evaluations", async () => {
  const app = await harness({ judge: async () => ({ ...approval, latencyMs: 23, usage: { inputTokens: 512, outputTokens: 17 } }) });
  try {
    assert.equal((await app.check()).ok, true);
    const diagnostic = (await app.stats()).stats!;
    assert.equal(diagnostic.diagnostics, 1);
    assert.equal(diagnostic.evaluations, 0);
    assert.equal(diagnostic.compactionsRequested, 0);
    assert.deepEqual(diagnostic.usage, { samples: 1, inputTokens: 512, outputTokens: 17 });
    await app.context();
    const combined = (await app.stats()).stats!;
    assert.equal(combined.diagnostics, 1);
    assert.equal(combined.evaluations, 1);
    assert.deepEqual(combined.usage, { samples: 2, inputTokens: 1_024, outputTokens: 34 });
    assert.deepEqual(combined.latency, { samples: 2, totalMs: 46, maxMs: 23 });
  } finally { await app.close(); }
});

test("statistics storage failures cannot prevent a valid native compaction admission", async () => {
  for (const statsStorageFailure of ["read", "write"] as const) {
    const app = await harness({ statsStorageFailure });
    try {
      await app.context();
      assert.deepEqual(app.compactCalls, [{ sessionID: "ses_test" }]);
      const status = await app.status();
      assert.ok((status.statsStorageErrors as number) > 0);
      if (statsStorageFailure === "read") assert.equal(status.stats, null);
      assert.equal(status.compactionsRequested, 1);
      assert.ok(!JSON.stringify(status).includes("private storage detail"));
    } finally { await app.close(); }
  }
});

test("cancelled evaluations and native completion events remain distinct durable statistics", async () => {
  const started = deferred<void>();
  const result = deferred<Evaluation>();
  const app = await harness({ judge: async () => { started.resolve(); return result.promise; } });
  try {
    const pending = app.context();
    await started.promise;
    await app.prompt();
    result.resolve(approval);
    await pending;
    const cancelled = (await app.stats()).stats!;
    assert.equal(cancelled.evaluations, 1);
    assert.equal(cancelled.cancelledEvaluations, 1);
    assert.equal(cancelled.compactDecisions, 0);
    assert.equal(cancelled.compactionsRequested, 0);
    app.emit("session.compaction.ended");
    await setImmediate();
    const observed = (await app.stats()).stats!;
    assert.equal(observed.compactionsCompleted, 1);
    assert.equal(observed.compactionsRequested, 0);
    assert.ok(!JSON.stringify([...app.storage.values()]).includes("Implementation is complete"));
  } finally { await app.close(); }
});

test("recovered native task and moderate affirmative support can request the configured compactor", async () => {
  const goal = "Implement and deploy the catalog, then build the client integration.";
  const app = await harness({ judge: async (evidence) => {
    assert.ok(evidence.excerpt.includes(goal));
    assert.ok(!evidence.excerpt.includes("PEER_SECRET"));
    return { ...approval, answers: { ...approval.answers, open_result: { type: "choice", choice: "no", confidence: 0.61, probabilities: { yes: 0.1, no: 0.74, unknown: 0.16 } } } };
  } });
  try {
    app.messages([
      { type: "compaction", id: "msg_compacted", status: "completed", reason: "auto", time: { created: 0 }, summary: "", native: { messages: [
        { id: "msg_goal", role: "user", content: [{ type: "text", text: goal }] },
        { id: "msg_peer", role: "user", metadata: { source: "opencode-cross-communication" }, content: [{ type: "text", text: "PEER_SECRET" }] },
      ] } },
      assistant("msg_initial", 80_000), assistant("msg_finished", 120_000),
    ]);
    await app.context();
    assert.deepEqual(app.compactCalls, [{ sessionID: "ses_test" }]);
    const decision = (await app.status()).lastDecision as Record<string, unknown>;
    assert.equal(decision.sessionID, "ses_test");
    assert.equal(decision.checkpointID, "msg_finished");
    assert.equal(decision.requestSource, "native-compaction");
    assert.deepEqual(decision.thresholds, { boundary: 0.8, supporting: 0.7, confidence: 0.5 });
  } finally { await app.close(); }
});

test("new child result invalidates an in-flight positive checkpoint judgment", async () => {
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const result = deferred<Evaluation>();
  const app = await harness({ judge: async (_evidence, call) => {
    call.signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
    started.resolve();
    return result.promise;
  } });
  try {
    const pending = app.context();
    await started.promise;
    app.emit("session.synthetic");
    await cancelled.promise;
    result.resolve(approval);
    await pending;
    assert.deepEqual(app.compactCalls, []);
    assert.equal((await app.stats()).stats!.cancelledEvaluations, 1);
  } finally { await app.close(); }
});
