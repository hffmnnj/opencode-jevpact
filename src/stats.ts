import type { Plugin } from "@opencode/plugin";
import type {
  CompactionMode,
  SkipReason,
  StatsEvent,
  StatsSnapshot,
} from "./stats-types.ts";

export const STATS_KEY = "stats/v1";

type StatsStorage = Pick<Plugin.Context["storage"], "get" | "set">;

const queueKey = Symbol.for("opencode-jevpact.stats.v1.queue");
type Queue = { tail: Promise<void> };
const shared = globalThis as typeof globalThis & { [queueKey]?: Queue };
// One main OpenCode server hosts every location instance: share one promise
// tail across instances and module reloads so the read/modify/write cycles
// for the single stats key cannot interleave and lose increments.
const queue = (shared[queueKey] ??= { tail: Promise.resolve() });

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.tail.then(run);
  // A rejected operation must not poison later ones; the caller still sees it.
  queue.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const skipReasons: readonly SkipReason[] = [
  "evidence",
  "threshold",
  "duplicate",
  "busy",
];
const compactionModes: readonly CompactionMode[] = [
  "provider-native",
  "opencode-summary",
];

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function section(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jev stats state");
  }
  return value as Record<string, unknown>;
}

function countIn(
  values: Record<string, unknown>,
  key: string,
): number {
  const value = values[key];
  if (!isCount(value)) throw new Error("Invalid Jev stats state");
  return value;
}

// Reconstruct only the allow-listed shape so persisted text, credentials, or
// other unknown fields can never flow back into snapshots or future writes.
function readSnapshot(value: unknown): StatsSnapshot {
  const saved = section(value);
  if (
    saved.version !== 1 ||
    !isAmount(saved.startedAt) ||
    !isAmount(saved.updatedAt)
  ) {
    throw new Error("Invalid Jev stats state");
  }
  const skips = section(saved.skips);
  const latency = section(saved.latency);
  const usage = section(saved.usage);
  const requestedByMode = section(saved.requestedByMode);
  for (const reason of skipReasons) countIn(skips, reason);
  for (const mode of compactionModes) countIn(requestedByMode, mode);
  if (
    !isCount(latency.samples) ||
    !isAmount(latency.totalMs) ||
    !isAmount(latency.maxMs)
  ) {
    throw new Error("Invalid Jev stats state");
  }
  if (
    !isCount(usage.samples) ||
    !isCount(usage.inputTokens) ||
    !isCount(usage.outputTokens)
  ) {
    throw new Error("Invalid Jev stats state");
  }
  return {
    version: 1,
    startedAt: saved.startedAt,
    updatedAt: saved.updatedAt,
    evaluations: countIn(saved, "evaluations"),
    compactDecisions: countIn(saved, "compactDecisions"),
    waitDecisions: countIn(saved, "waitDecisions"),
    cancelledEvaluations: countIn(saved, "cancelledEvaluations"),
    evaluationErrors: countIn(saved, "evaluationErrors"),
    compactionsRequested: countIn(saved, "compactionsRequested"),
    compactionsCompleted: countIn(saved, "compactionsCompleted"),
    compactionsFailed: countIn(saved, "compactionsFailed"),
    errors: countIn(saved, "errors"),
    diagnostics: countIn(saved, "diagnostics"),
    diagnosticErrors: countIn(saved, "diagnosticErrors"),
    skips: {
      evidence: countIn(skips, "evidence"),
      threshold: countIn(skips, "threshold"),
      duplicate: countIn(skips, "duplicate"),
      busy: countIn(skips, "busy"),
    },
    latency: {
      samples: latency.samples as number,
      totalMs: latency.totalMs as number,
      maxMs: latency.maxMs as number,
    },
    usage: {
      samples: usage.samples as number,
      inputTokens: usage.inputTokens as number,
      outputTokens: usage.outputTokens as number,
    },
    requestedByMode: {
      "provider-native": countIn(requestedByMode, "provider-native"),
      "opencode-summary": countIn(requestedByMode, "opencode-summary"),
    },
  };
}

function zeroSnapshot(t: number): StatsSnapshot {
  if (!isAmount(t)) throw new Error("Invalid Jev stats timestamp");
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

type ParsedUsage = { inputTokens: number; outputTokens: number };

type ParsedEvent =
  | {
      kind: "evaluation";
      outcome: "compact" | "wait" | "cancelled" | "error";
      latencyMs: number;
      usage?: ParsedUsage;
    }
  | {
      kind: "diagnostic";
      outcome: "success" | "error";
      latencyMs: number;
      usage?: ParsedUsage;
    }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "compaction-requested"; mode: CompactionMode }
  | { kind: "compaction-completed" }
  | { kind: "compaction-failed" }
  | { kind: "error" };

function parseUsage(value: unknown): ParsedUsage | undefined {
  if (value === undefined) return undefined;
  const usage = section(value);
  // Reuse the stored-state message: both reject malformed persisted data and
  // malformed events with one static error before anything is mutated.
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) {
    throw new Error("Invalid Jev stats event");
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

// Validate the runtime event before any storage access so a bad event can
// never trigger a write or silently drop a count.
function parseEvent(event: StatsEvent): ParsedEvent {
  if (!event || typeof event !== "object") {
    throw new Error("Invalid Jev stats event");
  }
  const input = event as unknown as Record<string, unknown>;
  switch (input.type) {
    case "evaluation":
    case "diagnostic": {
      const outcomes =
        input.type === "evaluation"
          ? ["compact", "wait", "cancelled", "error"]
          : ["success", "error"];
      if (
        typeof input.outcome !== "string" ||
        !outcomes.includes(input.outcome)
      ) {
        throw new Error("Invalid Jev stats event");
      }
      if (!isAmount(input.latencyMs)) {
        throw new Error("Invalid Jev stats event");
      }
      const usage = parseUsage(input.usage);
      return input.type === "evaluation"
        ? {
            kind: "evaluation",
            outcome: input.outcome as "compact" | "wait" | "cancelled" | "error",
            latencyMs: input.latencyMs,
            usage,
          }
        : {
            kind: "diagnostic",
            outcome: input.outcome as "success" | "error",
            latencyMs: input.latencyMs,
            usage,
          };
    }
    case "skip": {
      if (
        typeof input.reason !== "string" ||
        !(skipReasons as readonly string[]).includes(input.reason)
      ) {
        throw new Error("Invalid Jev stats event");
      }
      return { kind: "skip", reason: input.reason as SkipReason };
    }
    case "compaction": {
      if (input.phase === "requested") {
        if (
          typeof input.mode !== "string" ||
          !(compactionModes as readonly string[]).includes(input.mode)
        ) {
          throw new Error("Invalid Jev stats event");
        }
        return {
          kind: "compaction-requested",
          mode: input.mode as CompactionMode,
        };
      }
      if (input.phase === "completed") return { kind: "compaction-completed" };
      if (input.phase === "failed") return { kind: "compaction-failed" };
      throw new Error("Invalid Jev stats event");
    }
    case "error":
      return { kind: "error" };
    default:
      throw new Error("Invalid Jev stats event");
  }
}

function addLatency(state: StatsSnapshot, latencyMs: number): void {
  state.latency.samples += 1;
  state.latency.totalMs += latencyMs;
  state.latency.maxMs = Math.max(state.latency.maxMs, latencyMs);
}

function addUsage(state: StatsSnapshot, usage: ParsedUsage | undefined): void {
  // Missing usage is unknown: never fabricate a zero-token sample.
  if (!usage) return;
  state.usage.samples += 1;
  state.usage.inputTokens += usage.inputTokens;
  state.usage.outputTokens += usage.outputTokens;
}

function applyEvent(state: StatsSnapshot, event: ParsedEvent): void {
  switch (event.kind) {
    case "evaluation":
      state.evaluations += 1;
      if (event.outcome === "compact") state.compactDecisions += 1;
      else if (event.outcome === "wait") state.waitDecisions += 1;
      else if (event.outcome === "cancelled") state.cancelledEvaluations += 1;
      else {
        state.evaluationErrors += 1;
        state.errors += 1;
      }
      addLatency(state, event.latencyMs);
      addUsage(state, event.usage);
      break;
    case "diagnostic":
      // Diagnostics stay separate: they never touch evaluations or errors.
      state.diagnostics += 1;
      if (event.outcome === "error") state.diagnosticErrors += 1;
      addLatency(state, event.latencyMs);
      addUsage(state, event.usage);
      break;
    case "skip":
      state.skips[event.reason] += 1;
      break;
    case "compaction-requested":
      state.compactionsRequested += 1;
      state.requestedByMode[event.mode] += 1;
      break;
    case "compaction-completed":
      state.compactionsCompleted += 1;
      break;
    case "compaction-failed":
      state.compactionsFailed += 1;
      break;
    case "error":
      state.errors += 1;
      break;
  }
}

export function createStats(
  storage: StatsStorage,
  now: () => number = Date.now,
) {
  async function load(): Promise<StatsSnapshot> {
    const saved = await storage.get(STATS_KEY);
    if (saved === undefined) return zeroSnapshot(now());
    return readSnapshot(saved);
  }
  async function store(event: StatsEvent): Promise<void> {
    const parsed = parseEvent(event);
    const saved = await storage.get(STATS_KEY);
    const t = now();
    const next = saved === undefined ? zeroSnapshot(t) : readSnapshot(saved);
    applyEvent(next, parsed);
    next.updatedAt = t;
    await storage.set(STATS_KEY, readSnapshot(next));
  }
  return {
    // Read-only: an absent key yields a zero snapshot without creating it.
    read: (): Promise<StatsSnapshot> => exclusive(load),
    record: (event: StatsEvent): Promise<void> =>
      exclusive(() => store(event)),
  };
}
