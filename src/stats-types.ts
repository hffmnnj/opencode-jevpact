export type SkipReason = "evidence" | "threshold" | "duplicate" | "busy";
export type CompactionMode = "provider-native" | "opencode-summary";

export type StatsSnapshot = {
  version: 1;
  startedAt: number;
  updatedAt: number;
  evaluations: number;
  compactDecisions: number;
  waitDecisions: number;
  cancelledEvaluations: number;
  evaluationErrors: number;
  compactionsRequested: number;
  compactionsCompleted: number;
  compactionsFailed: number;
  errors: number;
  diagnostics: number;
  diagnosticErrors: number;
  skips: Record<SkipReason, number>;
  latency: { samples: number; totalMs: number; maxMs: number };
  usage: { samples: number; inputTokens: number; outputTokens: number };
  requestedByMode: Record<CompactionMode, number>;
};

export type StatsEvent =
  | { type: "evaluation"; outcome: "compact" | "wait" | "cancelled" | "error"; latencyMs: number; usage?: { readonly inputTokens: number; readonly outputTokens: number } }
  | { type: "diagnostic"; outcome: "success" | "error"; latencyMs: number; usage?: { readonly inputTokens: number; readonly outputTokens: number } }
  | { type: "skip"; reason: SkipReason }
  | { type: "compaction"; phase: "requested"; mode: CompactionMode }
  | { type: "compaction"; phase: "completed" | "failed" }
  | { type: "error" };
