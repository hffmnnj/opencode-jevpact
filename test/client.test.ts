import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Answer, Choice, Evidence } from "../src/types.ts";
import { ENDPOINT, MAX_EXCERPT_BYTES, MODEL, evaluate } from "../src/client.ts";

// Contract under test (see brief): evaluate(evidence, options) POSTs
// { model, state, questions } to ENDPOINT with Bearer auth, redacts the exact
// apiKey from the excerpt before sending, and strictly validates the
// response. options.fetch is the injectable transport: no test below touches
// global fetch or the real network.

const MODEL_PIN = "jev-1.14.0";
const ENDPOINT_PIN = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE_BYTES = 64 * 1024;

interface CapturedRequest {
  url: string | URL | Request;
  init: RequestInit;
}

function stubFetch(
  handler: (req: CapturedRequest) => Promise<Response> | Response,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const req: CapturedRequest = { url, init: init ?? {} };
    calls.push(req);
    return handler(req);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200, raw?: string): Response {
  const text = raw ?? JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function answer(
  choice: Choice,
  confidence: number,
  probabilities: Record<Choice, number>,
): Answer {
  return { type: "choice", choice, confidence, probabilities: { ...probabilities } };
}

// Fresh, independent distributions per call: distinct selected choices and
// distinct probability mass so swapped or ignored inputs cannot pass.
function validPayload(): { model: string; answers: Record<string, Answer> } {
  return {
    model: MODEL_PIN,
    answers: {
      boundary: answer("yes", 0.9, { yes: 0.85, no: 0.1, unknown: 0.05 }),
      settled: answer("no", 0.7, { yes: 0.2, no: 0.7, unknown: 0.1 }),
      open_result: answer("unknown", 0.6, { yes: 0.3, no: 0.2, unknown: 0.5 }),
    },
  };
}

function evidence(excerpt = "recent visible session text"): Evidence {
  return { excerpt, inputTokens: 120_000, contextWindow: 200_000 };
}

function sentBody(call: CapturedRequest): any {
  return JSON.parse(String(call.init.body));
}

function questionEntries(questions: any): Array<{ name: string; entry: any }> {
  if (Array.isArray(questions)) {
    return questions.map((q) => ({ name: String(q.name ?? q.id ?? q.key), entry: q }));
  }
  return Object.entries(questions ?? {}).map(([name, entry]) => ({ name, entry }));
}

async function rejectsWithoutLeak(promise: Promise<unknown>, secrets: string[]): Promise<Error> {
  let failure: unknown;
  try {
    await promise;
  } catch (err) {
    failure = err;
  }
  assert.ok(failure instanceof Error, `expected rejection with Error, got ${String(failure)}`);
  for (const secret of secrets) {
    assert.ok(
      !failure.message.includes(secret),
      `rejection leaked sensitive text: ${JSON.stringify(secret.slice(0, 24))}`,
    );
  }
  return failure;
}

describe("typesafe transport", () => {
  it("pins_model_endpoint_and_request_shape", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(validPayload()));
    const input = evidence();
    const apiKey = "pin-key-001";
    const result = await evaluate(input, { apiKey, fetch });

    assert.equal(MODEL, MODEL_PIN);
    assert.equal(ENDPOINT, ENDPOINT_PIN);
    assert.equal(MAX_EXCERPT_BYTES, 24 * 1024);
    assert.equal(calls.length, 1);

    const [call] = calls;
    assert.equal(String(call.url), ENDPOINT_PIN);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "error");
    assert.ok(call.init.signal instanceof AbortSignal, "fetch must receive a timeout signal");

    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
    assert.ok((headers.get("content-type") ?? "").includes("application/json"));

    const body = sentBody(call);
    assert.equal(body.model, MODEL_PIN);
    assert.deepEqual(body.state, {
      excerpt: input.excerpt,
      inputTokens: input.inputTokens,
      contextWindow: input.contextWindow,
    });

    const entries = questionEntries(body.questions);
    assert.deepEqual(entries.map((e) => e.name).sort(), ["boundary", "open_result", "settled"]);
    for (const { name, entry } of entries) {
      assert.equal(entry.type, "choice", `${name} must be a choice rubric`);
      assert.deepEqual(Object.keys(entry.criteria).sort(), ["no", "unknown", "yes"]);
    }

    assert.equal(result.model, MODEL_PIN);
  });

  it("redacts_api_key_from_excerpt_but_keeps_bearer_auth", async () => {
    const apiKey = "sk-redact-me-002";
    let sentExcerpt = "";
    const { fetch } = stubFetch((req) => {
      sentExcerpt = sentBody(req).state.excerpt;
      return jsonResponse(validPayload());
    });
    const result = await evaluate(
      evidence(`context before ${apiKey} context after`),
      { apiKey, fetch },
    );
    assert.ok(!sentExcerpt.includes(apiKey), "excerpt must not carry the exact key");
    assert.equal(result.model, MODEL_PIN);
  });

  it("accepts_valid_distributions", async () => {
    const { fetch } = stubFetch(() => jsonResponse(validPayload()));
    const result = await evaluate(evidence(), { apiKey: "valid-key-003", fetch });
    assert.equal(result.model, MODEL_PIN);
    assert.deepEqual(Object.keys(result.answers).sort(), ["boundary", "open_result", "settled"]);
    assert.equal(result.answers.boundary.choice, "yes");
    assert.equal(result.answers.settled.choice, "no");
    assert.equal(result.answers.open_result.choice, "unknown");
    assert.deepEqual({ ...result.answers.boundary.probabilities }, { yes: 0.85, no: 0.1, unknown: 0.05 });
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  });

  it("rejects_wrong_model", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse({ ...validPayload(), model: "jev-1.14" }),
    );
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "model-key-004", fetch }), []);
    assert.equal(calls.length, 1, "no retries on invalid model");
  });

  it("rejects_missing_answer", async () => {
    const payload = validPayload();
    const { open_result: _dropped, ...rest } = payload.answers;
    const { fetch } = stubFetch(() => jsonResponse({ model: MODEL_PIN, answers: rest }));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "missing-key-005", fetch }), []);
  });

  it("rejects_non_choice_answer_type", async () => {
    const payload = validPayload();
    payload.answers.settled = { ...payload.answers.settled, type: "text" } as unknown as Answer;
    const { fetch } = stubFetch(() => jsonResponse(payload));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "type-key-006", fetch }), []);
  });

  it("rejects_invalid_selected_choice", async () => {
    const payload = validPayload();
    payload.answers.boundary = {
      ...payload.answers.boundary,
      choice: "maybe",
    } as unknown as Answer;
    const { fetch } = stubFetch(() => jsonResponse(payload));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "choice-key-007", fetch }), []);
  });

  it("rejects_probability_keys_mismatch", async () => {
    const payload = validPayload();
    payload.answers.settled = answer("no", 0.7, { yes: 0.3, no: 0.7 } as unknown as Record<
      Choice,
      number
    >);
    const { fetch } = stubFetch(() => jsonResponse(payload));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "keys-key-008", fetch }), []);
  });

  it("rejects_probabilities_not_summing_to_one", async () => {
    const payload = validPayload();
    payload.answers.boundary = answer("yes", 0.9, { yes: 0.4, no: 0.05, unknown: 0.05 });
    const { fetch } = stubFetch(() => jsonResponse(payload));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "sum-key-009", fetch }), []);
  });

  it("rejects_non_maximal_selected_choice", async () => {
    const payload = validPayload();
    payload.answers.settled = answer("yes", 0.7, { yes: 0.2, no: 0.7, unknown: 0.1 });
    const { fetch } = stubFetch(() => jsonResponse(payload));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "max-key-010", fetch }), []);
  });

  it("rejects_confidence_out_of_range", async () => {
    const payload = validPayload();
    payload.answers.open_result = answer("unknown", 1.5, { yes: 0.3, no: 0.2, unknown: 0.5 });
    const { fetch } = stubFetch(() => jsonResponse(payload));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "conf-key-011", fetch }), []);
  });

  it("sanitizes_http_failure", async () => {
    const providerMarker = "provider-body-marker-012";
    const { fetch, calls } = stubFetch(() =>
      jsonResponse({ error: providerMarker }, 500, `upstream says: ${providerMarker}`),
    );
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "http-key-012", fetch }), [
      providerMarker,
    ]);
    assert.equal(calls.length, 1, "no retries on HTTP failure");
  });

  it("sanitizes_thrown_network_error", async () => {
    const rawMarker = "raw-network-marker-013";
    const { fetch, calls } = stubFetch(() => {
      throw new Error(`ECONNREFUSED ${rawMarker}`);
    });
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "net-key-013", fetch }), [rawMarker]);
    assert.equal(calls.length, 1, "no retries on network errors");
  });

  it("rejects_malformed_json", async () => {
    const rawBody = "{oops-not-json-014";
    const { fetch } = stubFetch(() => jsonResponse(null, 200, rawBody));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "json-key-014", fetch }), [rawBody]);
  });

  it("rejects_oversized_response", async () => {
    const hugeMarker = "huge-marker-015";
    const padding = `${hugeMarker}:` + "x".repeat(MAX_RESPONSE_BYTES + 1024);
    const { fetch } = stubFetch(() => jsonResponse({ ...validPayload(), padding }));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey: "big-key-015", fetch }), [hugeMarker]);
  });

  it("rejects_credential_echo_in_response", async () => {
    const apiKey = "sk-echo-key-016";
    const { fetch } = stubFetch(() => jsonResponse({ ...validPayload(), note: apiKey }));
    await rejectsWithoutLeak(evaluate(evidence(), { apiKey, fetch }), [apiKey]);
  });

  it("refuses_blank_excerpt_without_sending", async () => {
    for (const excerpt of ["", "   "]) {
      const { fetch, calls } = stubFetch(() => jsonResponse(validPayload()));
      await rejectsWithoutLeak(
        evaluate(evidence(excerpt), { apiKey: "blank-key-017", fetch }),
        [],
      );
      assert.equal(calls.length, 0, "blank excerpts must not be sent");
    }
  });

  it("refuses_oversized_excerpt_without_sending", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(validPayload()));
    const oversized = "x".repeat(MAX_EXCERPT_BYTES + 1);
    assert.ok(Buffer.byteLength(oversized) > MAX_EXCERPT_BYTES);
    await rejectsWithoutLeak(
      evaluate(evidence(oversized), { apiKey: "size-key-018", fetch }),
      [],
    );
    assert.equal(calls.length, 0, "oversized excerpts must not be sent");
  });

  it("accepts_large_excerpt_near_max_bytes", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(validPayload()));
    const large = "x".repeat(MAX_EXCERPT_BYTES - 512);
    const result = await evaluate(evidence(large), { apiKey: "max-key-019", fetch });
    assert.equal(result.model, MODEL_PIN);
    assert.equal(calls.length, 1);
    assert.equal(sentBody(calls[0]).state.excerpt, large);
  });

  it("propagates_caller_abort_as_rejection", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(validPayload()));
    const controller = new AbortController();
    controller.abort();
    // Contract pins propagation as a rejection; the abort reason itself is a
    // DOMException, not an Error, so no Error-shape assertion here.
    await assert.rejects(
      evaluate(evidence(), { apiKey: "abort-key-020", fetch, signal: controller.signal }),
    );
    for (const call of calls) {
      assert.ok(
        !(call.init.signal instanceof AbortSignal) || call.init.signal.aborted,
        "fetch must observe the aborted caller signal",
      );
    }
  });

  it("reports_distinct_token_usage", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ ...validPayload(), usage: { input_tokens: 123, output_tokens: 456 } }),
    );
    const result = await evaluate(evidence(), { apiKey: "usage-key-021", fetch });
    assert.deepEqual({ ...result.usage }, { inputTokens: 123, outputTokens: 456 });
    assert.equal(result.answers.boundary.choice, "yes");
  });

  it("accepts_zero_token_usage", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ ...validPayload(), usage: { input_tokens: 0, output_tokens: 0 } }),
    );
    const result = await evaluate(evidence(), { apiKey: "usage-key-022", fetch });
    assert.deepEqual({ ...result.usage }, { inputTokens: 0, outputTokens: 0 });
  });

  it("omits_missing_usage", async () => {
    const { fetch } = stubFetch(() => jsonResponse(validPayload()));
    const result = await evaluate(evidence(), { apiKey: "usage-key-023", fetch });
    assert.equal(result.usage, undefined);
    assert.equal(result.answers.boundary.choice, "yes");
  });

  it("omits_malformed_usage_but_accepts_answers", async () => {
    const malformed: unknown[] = [
      { input_tokens: -1, output_tokens: 5 },
      { input_tokens: 1.5, output_tokens: 5 },
      { input_tokens: "12", output_tokens: 5 },
      { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 5 },
      { input_tokens: Number.NaN, output_tokens: 5 },
      { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 5 },
      { input_tokens: 5, output_tokens: -2 },
      { input_tokens: 5 },
      { output_tokens: 5 },
      null,
      "usage",
      [{ input_tokens: 5, output_tokens: 5 }],
    ];
    for (const usage of malformed) {
      const { fetch } = stubFetch(() => jsonResponse({ ...validPayload(), usage }));
      const result = await evaluate(evidence(), { apiKey: "usage-key-024", fetch });
      assert.equal(result.usage, undefined, `malformed usage must be omitted: ${String(JSON.stringify(usage))}`);
      assert.equal(result.answers.boundary.choice, "yes");
    }
  });

  it("ignores_extra_usage_fields", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({
        ...validPayload(),
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, model: "other" },
      }),
    );
    const result = await evaluate(evidence(), { apiKey: "usage-key-025", fetch });
    assert.deepEqual({ ...(result.usage as object) }, { inputTokens: 10, outputTokens: 20 });
    assert.deepEqual(Object.keys({ ...(result.usage as object) }).sort(), [
      "inputTokens",
      "outputTokens",
    ]);
  });
});
