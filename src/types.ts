export type Choice = "yes" | "no" | "unknown";

export interface Answer {
  readonly type: "choice";
  readonly choice: Choice;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Choice, number>>;
}

export interface Evidence {
  readonly excerpt: string;
  readonly inputTokens: number;
  readonly contextWindow: number;
}

export interface Evaluation {
  readonly model: string;
  readonly answers: Readonly<Record<"boundary" | "settled" | "open_result", Answer>>;
  readonly latencyMs: number;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface EvaluateOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PolicyOptions {
  readonly minInputTokens: number;
  readonly minGrowthTokens: number;
  readonly minRequests: number;
  readonly minProbability: number;
  readonly minSupportingProbability: number;
  readonly minConfidence: number;
  readonly cooldownMs: number;
}

export const DEFAULT_POLICY: PolicyOptions = {
  minInputTokens: 100_000,
  minGrowthTokens: 30_000,
  minRequests: 3,
  minProbability: 0.8,
  minSupportingProbability: 0.7,
  minConfidence: 0.5,
  cooldownMs: 60_000,
};
