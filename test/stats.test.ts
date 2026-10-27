import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { Plugin } from "@opencode/plugin";
import { createStats, STATS_KEY } from "../src/stats.ts";
import type {
  StatsEvent,
  StatsSnapshot,
} from "../src/stats-types.ts";

type StatsStorage = Pick<Plugin.Context["storage"], "get" | "set">;

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

// Clone-on-read/write JSON store: malformed totals and accidental
// shared-reference mutation surface as lost writes instead of hiding.
function memoryStore() {
  const data = new Map<string, unknown>();
  let failures = 0;
  const storage: StatsStorage = {
    get: async (key) =>
      clone(data.get(key)) as Awaited<ReturnType<StatsStorage["get"]>>,
    set: async (key, value) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("storage unavailable");
      }
      data.set(key, clone(value));
    },
  };
  return {
    storage,
    raw: (): unknown => clone(data.get(STATS_KEY)),
    has: (key: string): boolean => data.has(key),
    seed: (value: unknown): void => {
      data.set(STATS_KEY, clone(value));
    },
    failNext: (count: number): void => {
      failures = count;
    },
  };
}

function zeroAt(t: number): StatsSnapshot {
  return {
    version: 1,
    startedAt: t,
    updatedAt: t,
    evaluations: 0,
    compactDecisions: 0,
    waitDecisions: 0,
    cancelledEvaluations: 0,
    evaluationErrors: 0,
    compactionsRequested: 0,
    compactionsCompleted: 0,
    compactionsFailed: 0,
    errors: 0,
    diagnostics: 0,
    diagnosticErrors: 0,
    skips: { evidence: 0, threshold: 0, duplicate: 0, busy: 0 },
    latency: { samples: 0, totalMs: 0, maxMs: 0 },
    usage: { samples: 0, inputTokens: 0, outputTokens: 0 },
    requestedByMode: { "provider-native": 0, "opencode-summary": 0 },
  };
}

function evaluation(
  outcome: "compact" | "wait" | "cancelled" | "error",
  latencyMs = 100,
  usage?: { inputTokens: number; outputTokens: number },
): StatsEvent {
  return usage === undefined
    ? { type: "evaluation", outcome, latencyMs }
    : { type: "evaluation", outcome, latencyMs, usage };
}

describe("stats read", () => {
  it("read_absentKey_returnsZeroSnapshotWithoutCreatingKey", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    assert.deepEqual(await stats.read(), zeroAt(1_000));
    assert.equal(store.has(STATS_KEY), false);
  });

  it("read_invalidStoredState_throwsWithoutResettingTotals", async () => {
    const invalid: unknown[] = [
      { version: 2 },
      null,
      [],
      "stats",
      { ...zeroAt(1_000), evaluations: -1 },
      { ...zeroAt(1_000), evaluations: 1.5 },
      { ...zeroAt(1_000), evaluations: "3" },
      { ...zeroAt(1_000), version: 1, skips: { evidence: 0 } },
      { ...zeroAt(1_000), latency: { samples: 0, totalMs: -5, maxMs: 0 } },
      {
        ...zeroAt(1_000),
        usage: { samples: 1, inputTokens: 10, outputTokens: 5 },
        startedAt: Number.NaN,
      },
    ];
    for (const candidate of invalid) {
      const store = memoryStore();
      store.seed(candidate);
      const before = store.raw();
      const stats = createStats(store.storage, () => 2_000);
      await assert.rejects(stats.read(), /Invalid Jev stats state/);
      await assert.rejects(
        stats.record(evaluation("compact")),
        /Invalid Jev stats state/,
      );
      assert.deepEqual(store.raw(), before);
    }
  });

  it("read_storedUnknownFields_reconstructsAllowListedShape", async () => {
    const store = memoryStore();
    store.seed({
      ...zeroAt(1_000),
      evaluations: 2,
      excerpt: "User: secret plan",
      apiKey: "sk-secret",
      credentials: { token: "tok-secret" },
      skips: {
        evidence: 1,
        threshold: 0,
        duplicate: 0,
        busy: 0,
        leaked: 9,
      },
    });
    const stats = createStats(store.storage, () => 2_000);
    const snapshot = await stats.read();
    assert.deepEqual(snapshot, {
      ...zeroAt(1_000),
      evaluations: 2,
      updatedAt: 1_000,
      skips: { evidence: 1, threshold: 0, duplicate: 0, busy: 0 },
    });
    assert.ok(!("excerpt" in snapshot));
    assert.ok(!("apiKey" in snapshot));
    assert.ok(!("credentials" in snapshot));
  });
});

describe("stats record", () => {
  it("record_firstWrite_setsStartedAndUpdatedThenRetainsStartedAt", async () => {
    const store = memoryStore();
    let t = 1_000;
    const stats = createStats(store.storage, () => t);
    await stats.record(evaluation("compact"));
    assert.deepEqual(await stats.read(), {
      ...zeroAt(1_000),
      evaluations: 1,
      compactDecisions: 1,
      latency: { samples: 1, totalMs: 100, maxMs: 100 },
    });
    t = 5_000;
    await stats.record({ type: "error" });
    const snapshot = await stats.read();
    assert.equal(snapshot.startedAt, 1_000);
    assert.equal(snapshot.updatedAt, 5_000);
    assert.equal(snapshot.errors, 1);
  });

  it("record_evaluationOutcomes_countsExactlyOneDecisionEach", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    await stats.record(evaluation("compact"));
    await stats.record(evaluation("wait"));
    await stats.record(evaluation("cancelled"));
    await stats.record(evaluation("error"));
    const snapshot = await stats.read();
    assert.equal(snapshot.evaluations, 4);
    assert.equal(snapshot.compactDecisions, 1);
    assert.equal(snapshot.waitDecisions, 1);
    assert.equal(snapshot.cancelledEvaluations, 1);
    assert.equal(snapshot.evaluationErrors, 1);
    assert.equal(snapshot.errors, 1);
    assert.equal(snapshot.diagnostics, 0);
    assert.equal(snapshot.diagnosticErrors, 0);
  });

  it("record_diagnosticOutcomes_staySeparateFromProductionCounts", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    await stats.record({
      type: "diagnostic",
      outcome: "success",
      latencyMs: 50,
    });
    await stats.record({
      type: "diagnostic",
      outcome: "error",
      latencyMs: 70,
    });
    const snapshot = await stats.read();
    assert.equal(snapshot.diagnostics, 2);
    assert.equal(snapshot.diagnosticErrors, 1);
    assert.equal(snapshot.evaluations, 0);
    assert.equal(snapshot.evaluationErrors, 0);
    assert.equal(snapshot.errors, 0);
    assert.deepEqual(snapshot.latency, {
      samples: 2,
      totalMs: 120,
      maxMs: 70,
    });
  });

  it("record_latencyAndUsage_aggregatesSamplesTotalsAndMax", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    await stats.record(evaluation("compact", 100, { inputTokens: 10, outputTokens: 20 }));
    await stats.record(evaluation("wait", 300, { inputTokens: 30, outputTokens: 40 }));
    await stats.record(evaluation("wait", 200));
    const snapshot = await stats.read();
    assert.deepEqual(snapshot.latency, {
      samples: 3,
      totalMs: 600,
      maxMs: 300,
    });
    // The usage-free evaluation is unknown usage, never a zero sample.
    assert.deepEqual(snapshot.usage, {
      samples: 2,
      inputTokens: 40,
      outputTokens: 60,
    });
  });

  it("record_invalidUsage_throwsAndPreservesExistingTotals", async () => {
    const invalidUsage: unknown[] = [
      null,
      {},
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: Number.NaN, outputTokens: 0 },
      { inputTokens: 10, outputTokens: Number.POSITIVE_INFINITY },
      { inputTokens: "10", outputTokens: 0 },
      { inputTokens: 10 },
    ];
    for (const usage of invalidUsage) {
      const store = memoryStore();
      const stats = createStats(store.storage, () => 1_000);
      await stats.record(
        evaluation("compact", 100, { inputTokens: 5, outputTokens: 5 }),
      );
      const before = await stats.read();
      await assert.rejects(
        stats.record({
          type: "evaluation",
          outcome: "wait",
          latencyMs: 100,
          usage: usage as { inputTokens: number; outputTokens: number },
        }),
        /Invalid Jev stats/,
      );
      assert.deepEqual(await stats.read(), before);
    }
  });

  it("record_invalidEvents_throwBeforeStorageAccess", async () => {
    const invalid: unknown[] = [
      null,
      "evaluation",
      { type: "unknown" },
      { type: "evaluation", outcome: "maybe", latencyMs: 10 },
      { type: "evaluation", outcome: "compact", latencyMs: -1 },
      { type: "evaluation", outcome: "compact", latencyMs: Number.NaN },
      {
        type: "evaluation",
        outcome: "compact",
        latencyMs: Number.POSITIVE_INFINITY,
      },
      { type: "diagnostic", outcome: "unknown", latencyMs: 10 },
      { type: "skip", reason: "other" },
      { type: "compaction", phase: "requested", mode: "native" },
      { type: "compaction", phase: "started" },
      { type: "compaction" },
    ];
    for (const event of invalid) {
      const store = memoryStore();
      const stats = createStats(store.storage, () => 1_000);
      await assert.rejects(
        stats.record(event as StatsEvent),
        /Invalid Jev stats event/,
      );
      assert.equal(store.has(STATS_KEY), false);
    }
  });

  it("record_skipReasons_incrementOnlyTheirFixedKey", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    await stats.record({ type: "skip", reason: "evidence" });
    await stats.record({ type: "skip", reason: "threshold" });
    await stats.record({ type: "skip", reason: "duplicate" });
    await stats.record({ type: "skip", reason: "busy" });
    await stats.record({ type: "skip", reason: "busy" });
    const snapshot = await stats.read();
    assert.deepEqual(snapshot.skips, {
      evidence: 1,
      threshold: 1,
      duplicate: 1,
      busy: 2,
    });
    assert.equal(snapshot.evaluations, 0);
    assert.equal(snapshot.errors, 0);
  });

  it("record_compactionPhases_trackRequestedRoutesVersusObservedNative", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    await stats.record({
      type: "compaction",
      phase: "requested",
      mode: "provider-native",
    });
    await stats.record({
      type: "compaction",
      phase: "requested",
      mode: "opencode-summary",
    });
    await stats.record({
      type: "compaction",
      phase: "requested",
      mode: "provider-native",
    });
    await stats.record({ type: "compaction", phase: "completed" });
    await stats.record({ type: "compaction", phase: "completed" });
    await stats.record({ type: "compaction", phase: "failed" });
    const snapshot = await stats.read();
    assert.equal(snapshot.compactionsRequested, 3);
    assert.deepEqual(snapshot.requestedByMode, {
      "provider-native": 2,
      "opencode-summary": 1,
    });
    // Observed completions include native compactions the plugin never asked for.
    assert.equal(snapshot.compactionsCompleted, 2);
    assert.equal(snapshot.compactionsFailed, 1);
  });

  it("record_errorEvent_incrementsOnlyErrors", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    await stats.record({ type: "error" });
    const snapshot = await stats.read();
    assert.equal(snapshot.errors, 1);
    assert.equal(snapshot.evaluations, 0);
    assert.equal(snapshot.diagnostics, 0);
  });

  it("record_seededUnknownFields_dropsExtrasWhileKeepingTotals", async () => {
    const store = memoryStore();
    store.seed({ ...zeroAt(1_000), errors: 2, excerpt: "secret" });
    const stats = createStats(store.storage, () => 2_000);
    await stats.record({ type: "error" });
    const snapshot = await stats.read();
    assert.equal(snapshot.errors, 3);
    assert.ok(!("excerpt" in snapshot));
    const persisted = store.raw() as Record<string, unknown>;
    assert.ok(!("excerpt" in persisted));
    assert.equal(persisted.errors, 3);
  });

  it("record_counterOverflow_preservesLastValidTotals", async () => {
    const store = memoryStore();
    const saved = { ...zeroAt(1_000), errors: Number.MAX_SAFE_INTEGER };
    store.seed(saved);
    const stats = createStats(store.storage, () => 2_000);
    await assert.rejects(stats.record({ type: "error" }), /Invalid Jev stats state/);
    assert.deepEqual(store.raw(), saved);
  });
});

describe("stats concurrency and recovery", () => {
  it("queueConcurrency_interleavedWritesAcrossInstances_noLostIncrements", async () => {
    // Production fault: two location instances interleave read/modify/write
    // over slow storage, so an unserialized queue would lose increments.
    const backing = memoryStore();
    const slow: StatsStorage = {
      get: async (key) => {
        await setImmediate();
        return backing.storage.get(key);
      },
      set: async (key, value) => {
        await setImmediate();
        return backing.storage.set(key, value);
      },
    };
    const first = createStats(slow, () => 1_000);
    const second = createStats(slow, () => 1_000);
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? first : second).record(
          evaluation("compact", 10),
        ),
      ),
    );
    const snapshot = await first.read();
    assert.equal(snapshot.evaluations, 40);
    assert.equal(snapshot.compactDecisions, 40);
    assert.equal(snapshot.latency.samples, 40);
    assert.equal(snapshot.latency.totalMs, 400);
    // A fresh instance over the same key sees the same persisted totals.
    const fresh = createStats(backing.storage, () => 2_000);
    assert.deepEqual(await fresh.read(), { ...snapshot, updatedAt: 1_000 });
  });

  it("queueConcurrency_failedWrite_rejectsWithoutPoisoningLaterWrites", async () => {
    const store = memoryStore();
    const stats = createStats(store.storage, () => 1_000);
    await stats.record(evaluation("compact"));
    store.failNext(1);
    await assert.rejects(
      stats.record(evaluation("wait")),
      /storage unavailable/,
    );
    await stats.record(evaluation("wait"));
    await Promise.all([
      stats.record({ type: "skip", reason: "busy" }),
      stats.record({ type: "error" }),
    ]);
    const snapshot = await stats.read();
    assert.equal(snapshot.evaluations, 2);
    assert.equal(snapshot.compactDecisions, 1);
    assert.equal(snapshot.waitDecisions, 1);
    assert.equal(snapshot.skips.busy, 1);
    assert.equal(snapshot.errors, 1);
  });
});
