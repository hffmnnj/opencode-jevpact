export type SkipReason = "evidence" | "threshold" | "duplicate" | "busy";
export type CompactionMode = "provider-native" | "opencode-summary";

export type ModelIdentity = { providerID: string; modelID: string };
export type ModelStats = ModelIdentity & {
  evaluations: number;
  compactDecisions: number;
  waitDecisions: number;
  cancelledEvaluations: number;
  evaluationErrors: number;
  compactionsRequested: number;
  requestedByMode: Record<CompactionMode, number>;
  latency: { samples: number; totalMs: number; maxMs: number };
  usage: { samples: number; inputTokens: number; outputTokens: number };
};

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
  modelDetails?: { startedAt: number; models: ModelStats[] };
};

export type StatsEvent =
  | { type: "evaluation"; outcome: "compact" | "wait" | "cancelled" | "error"; latencyMs: number; usage?: { readonly inputTokens: number; readonly outputTokens: number }; model?: ModelIdentity }
  | { type: "diagnostic"; outcome: "success" | "error"; latencyMs: number; usage?: { readonly inputTokens: number; readonly outputTokens: number } }
  | { type: "skip"; reason: SkipReason }
  | { type: "compaction"; phase: "requested"; mode: CompactionMode; model?: ModelIdentity }
  | { type: "compaction"; phase: "completed" | "failed" }
  | { type: "error" };
