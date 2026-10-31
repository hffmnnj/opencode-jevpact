import {
  DEFAULT_POLICY,
  type Evaluation,
  type Evidence,
  type PolicyOptions,
} from "./types.ts";

export interface EligibilityState {
  readonly baselineTokens: number;
  readonly requests: number;
  readonly lastEvaluationAt: number;
}

export function eligible(
  evidence: Evidence,
  state: EligibilityState,
  options: PolicyOptions,
  now: number,
): boolean {
  if (!Number.isFinite(evidence.inputTokens) || evidence.inputTokens < 0) {
    return false;
  }
  if (!Number.isFinite(evidence.contextWindow) || evidence.contextWindow <= 0) {
    return false;
  }
  if (!Number.isFinite(state.baselineTokens) || state.baselineTokens < 0) {
    return false;
  }
  if (!Number.isFinite(state.requests) || state.requests < 0) {
    return false;
  }
  if (!Number.isFinite(state.lastEvaluationAt) || state.lastEvaluationAt < 0) {
    return false;
  }
  if (!Number.isFinite(now) || now < 0) {
    return false;
  }
  if (evidence.inputTokens < options.minInputTokens) {
    return false;
  }
  if (evidence.inputTokens - state.baselineTokens < options.minGrowthTokens) {
    return false;
  }
  if (state.requests < options.minRequests) {
    return false;
  }
  if (
    state.lastEvaluationAt !== 0 &&
    now - state.lastEvaluationAt < options.cooldownMs
  ) {
    return false;
  }
  return true;
}

export function shouldCompact(
  evaluation: Evaluation,
  options: PolicyOptions,
): boolean {
  const boundary = evaluation.answers["boundary"];
  const settled = evaluation.answers["settled"];
  const openResult = evaluation.answers["open_result"];
  if (boundary === undefined || settled === undefined || openResult === undefined) {
    return false;
  }
  if (boundary.choice !== "yes" || settled.choice !== "yes") {
    return false;
  }
  if (openResult.choice !== "no") {
    return false;
  }
  for (const [answer, floor] of [
    [boundary, options.minProbability],
    [settled, options.minSupportingProbability],
    [openResult, options.minSupportingProbability],
  ] as const) {
    const selected = answer.probabilities[answer.choice];
    if (typeof selected !== "number" || !(selected >= floor)) {
      return false;
    }
    if (
      typeof answer.confidence !== "number" ||
      !(answer.confidence >= options.minConfidence)
    ) {
      return false;
    }
  }
  return true;
}

function parseTokenField(
  name: "minInputTokens" | "minGrowthTokens",
  value: unknown,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `invalid ${name}: expected a finite nonnegative integer, received ${String(value)}`,
    );
  }
  return value;
}

function parseCooldown(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `invalid cooldownMs: expected a finite nonnegative integer, received ${String(value)}`,
    );
  }
  return value;
}

function parseMinRequests(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new Error(
      `invalid minRequests: expected a finite integer >= 1, received ${String(value)}`,
    );
  }
  return value;
}

function parseThreshold(
  name: "minProbability" | "minSupportingProbability" | "minConfidence",
  value: unknown,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(
      `invalid ${name}: expected a finite number in [0, 1], received ${String(value)}`,
    );
  }
  return value;
}

export function parsePolicy(
  options: Readonly<Record<string, unknown>>,
): PolicyOptions {
  const minProbability = parseThreshold(
    "minProbability",
    options["minProbability"],
    DEFAULT_POLICY.minProbability,
  );
  const minSupportingProbability =
    options["minSupportingProbability"] === undefined &&
    options["minProbability"] !== undefined
      ? minProbability
      : parseThreshold(
          "minSupportingProbability",
          options["minSupportingProbability"],
          DEFAULT_POLICY.minSupportingProbability,
        );
  return {
    minInputTokens: parseTokenField(
      "minInputTokens",
      options["minInputTokens"],
      DEFAULT_POLICY.minInputTokens,
    ),
    minGrowthTokens: parseTokenField(
      "minGrowthTokens",
      options["minGrowthTokens"],
      DEFAULT_POLICY.minGrowthTokens,
    ),
    minRequests: parseMinRequests(
      options["minRequests"],
      DEFAULT_POLICY.minRequests,
    ),
    minProbability,
    minSupportingProbability,
    minConfidence: parseThreshold(
      "minConfidence",
      options["minConfidence"],
      DEFAULT_POLICY.minConfidence,
    ),
    cooldownMs: parseCooldown(options["cooldownMs"], DEFAULT_POLICY.cooldownMs),
  };
}
