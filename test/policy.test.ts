import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eligible, shouldCompact, parsePolicy } from "../src/policy.ts";
import {
  DEFAULT_POLICY,
  type Answer,
  type Evaluation,
  type Evidence,
  type PolicyOptions,
} from "../src/types.ts";
import type { EligibilityState } from "../src/policy.ts";

const options: PolicyOptions = { ...DEFAULT_POLICY };

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    excerpt: "finished auth refactor, tests green",
    inputTokens: 130_000,
    contextWindow: 200_000,
    ...overrides,
  };
}

function state(overrides: Partial<EligibilityState> = {}): EligibilityState {
  return {
    baselineTokens: 90_000,
    requests: 5,
    lastEvaluationAt: 0,
    ...overrides,
  };
}

function answer(
  choice: Answer["choice"],
  confidence: number,
  selectedProbability: number,
): Answer {
  const probabilities: Record<Answer["choice"], number> = {
    yes: 0.05,
    no: 0.05,
    unknown: 0.05,
  };
  probabilities[choice] = selectedProbability;
  return { type: "choice", choice, confidence, probabilities };
}

function evaluation(overrides: {
  boundary?: Answer;
  settled?: Answer;
  open_result?: Answer;
}): Evaluation {
  return {
    model: "jev-1.14.0",
    answers: {
      boundary: overrides.boundary ?? answer("yes", 0.8, 0.9),
      settled: overrides.settled ?? answer("yes", 0.7, 0.85),
      open_result: overrides.open_result ?? answer("no", 0.6, 0.9),
    },
    latencyMs: 120,
  };
}

describe("eligible usage gates", () => {
  it("eligible_atExactThresholds_qualifies", () => {
    const atFloor = evidence({
      inputTokens: options.minInputTokens,
    });
    const atGrowth = state({
      baselineTokens: options.minInputTokens - options.minGrowthTokens,
      requests: options.minRequests,
      lastEvaluationAt: 0,
    });
    assert.equal(eligible(atFloor, atGrowth, options, 1_000_000), true);
  });

  it("eligible_belowInputFloor_declines", () => {
    const low = evidence({ inputTokens: options.minInputTokens - 1 });
    assert.equal(eligible(low, state(), options, 1_000_000), false);
  });

  it("eligible_insufficientBaselineGrowth_declines", () => {
    const grown = state({
      baselineTokens: 130_000 - (options.minGrowthTokens - 1),
    });
    assert.equal(eligible(evidence(), grown, options, 1_000_000), false);
  });

  it("eligible_negativeGrowth_declines", () => {
    const regressed = state({ baselineTokens: 140_000 });
    assert.equal(eligible(evidence(), regressed, options, 1_000_000), false);
  });

  it("eligible_insufficientRequests_declines", () => {
    const few = state({ requests: options.minRequests - 1 });
    assert.equal(eligible(evidence(), few, options, 1_000_000), false);
  });

  it("eligible_nonPositiveContextWindow_declines", () => {
    assert.equal(
      eligible(evidence({ contextWindow: 0 }), state(), options, 1_000_000),
      false,
    );
    assert.equal(
      eligible(
        evidence({ contextWindow: Number.NaN }),
        state(),
        options,
        1_000_000,
      ),
      false,
    );
  });

  it("eligible_nonFiniteUsage_declines", () => {
    assert.equal(
      eligible(
        evidence({ inputTokens: Number.NaN }),
        state(),
        options,
        1_000_000,
      ),
      false,
    );
    assert.equal(
      eligible(
        evidence({ inputTokens: Number.POSITIVE_INFINITY }),
        state(),
        options,
        1_000_000,
      ),
      false,
    );
    assert.equal(
      eligible(evidence(), state({ baselineTokens: -1 }), options, 1_000_000),
      false,
    );
  });
});

describe("eligible cooldown", () => {
  it("eligible_neverEvaluated_skipsCooldown", () => {
    // now is far below cooldownMs, but lastEvaluationAt 0 means no prior check.
    assert.equal(eligible(evidence(), state(), options, 1_000), true);
  });

  it("eligible_exactCooldownBoundary_qualifies", () => {
    const now = 1_000_000;
    const prior = state({ lastEvaluationAt: now - options.cooldownMs });
    assert.equal(eligible(evidence(), prior, options, now), true);
  });

  it("eligible_justBeforeCooldownBoundary_declines", () => {
    const now = 1_000_000;
    const recent = state({ lastEvaluationAt: now - options.cooldownMs + 1 });
    assert.equal(eligible(evidence(), recent, options, now), false);
  });
});

describe("shouldCompact semantic approval", () => {
  it("shouldCompact_confidentlySettledTransition_qualifies", () => {
    assert.equal(shouldCompact(evaluation({}), options), true);
  });

  it("shouldCompact_exactThresholds_qualify", () => {
    const atThreshold = evaluation({
      boundary: answer("yes", options.minConfidence, options.minProbability),
      settled: answer("yes", options.minConfidence, options.minProbability),
      open_result: answer("no", options.minConfidence, options.minProbability),
    });
    assert.equal(shouldCompact(atThreshold, options), true);
  });

  it("shouldCompact_lowSelectedProbability_vetoes", () => {
    const uncertain = evaluation({
      settled: answer("yes", 0.9, options.minProbability - 0.01),
    });
    assert.equal(shouldCompact(uncertain, options), false);
  });

  it("shouldCompact_lowConfidence_vetoes", () => {
    const unsure = evaluation({
      boundary: answer("yes", options.minConfidence - 0.01, 0.95),
    });
    assert.equal(shouldCompact(unsure, options), false);
  });

  it("shouldCompact_unknownNever_qualifies", () => {
    const unknownSettled = evaluation({
      settled: answer("unknown", 0.99, 0.99),
    });
    assert.equal(shouldCompact(unknownSettled, options), false);
  });

  it("shouldCompact_unresolvedOpenResult_vetoes", () => {
    assert.equal(
      shouldCompact(
        evaluation({ open_result: answer("yes", 0.99, 0.99) }),
        options,
      ),
      false,
    );
    assert.equal(
      shouldCompact(
        evaluation({ open_result: answer("unknown", 0.99, 0.99) }),
        options,
      ),
      false,
    );
  });

  it("shouldCompact_unsettledOrOffBoundary_vetoes", () => {
    assert.equal(
      shouldCompact(evaluation({ settled: answer("no", 0.99, 0.99) }), options),
      false,
    );
    assert.equal(
      shouldCompact(
        evaluation({ boundary: answer("no", 0.99, 0.99) }),
        options,
      ),
      false,
    );
  });
});

describe("parsePolicy", () => {
  it("parsePolicy_emptyOptions_returnsDefaults", () => {
    assert.deepEqual(parsePolicy({}), DEFAULT_POLICY);
  });

  it("parsePolicy_unknownFields_ignored", () => {
    assert.deepEqual(parsePolicy({ enabled: true, extra: "x" }), DEFAULT_POLICY);
  });

  it("parsePolicy_providedFields_merged", () => {
    assert.deepEqual(parsePolicy({ minRequests: 5, cooldownMs: 10_000 }), {
      ...DEFAULT_POLICY,
      minRequests: 5,
      cooldownMs: 10_000,
    });
  });

  it("parsePolicy_invalidValues_rejected", () => {
    const invalid: Array<Record<string, unknown>> = [
      { minInputTokens: -1 },
      { minInputTokens: 1.5 },
      { minInputTokens: Number.NaN },
      { minInputTokens: "100000" },
      { minGrowthTokens: -1 },
      { minGrowthTokens: 2.5 },
      { minRequests: 0 },
      { minRequests: 1.5 },
      { minRequests: Number.POSITIVE_INFINITY },
      { minProbability: -0.1 },
      { minProbability: 1.1 },
      { minProbability: Number.NaN },
      { minConfidence: -0.1 },
      { minConfidence: 1.1 },
      { cooldownMs: -1 },
      { cooldownMs: 1.5 },
      { cooldownMs: Number.NaN },
    ];
    for (const candidate of invalid) {
      assert.throws(() => parsePolicy(candidate), /invalid /);
    }
  });
});
