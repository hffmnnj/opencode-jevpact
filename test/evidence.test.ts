import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMessageInfo } from "@opencode/client";
import { selectSnapshot, snapshot } from "../src/evidence.ts";

// Behavioral contract under test (coordinator owns src/evidence.ts):
// snapshot() gains requestSource: 'live' | 'native-compaction' |
// 'compaction-summary' | 'unavailable'. Recovered native-compaction requests
// are labelled retained context, never new authority. Peer
// (metadata.source === 'opencode-cross-communication') traffic is evidence,
// never a user request, but a newer peer/synthetic result after the candidate
// report still vetoes. A report may precede completed todowrite tools only.

const PEER_SOURCE = "opencode-cross-communication";

function sourceOf(view: { readonly evidence: { readonly excerpt: string } }): unknown {
  return (view as unknown as { readonly requestSource?: unknown }).requestSource;
}

function user(id: string, text: string, peer = false): SessionMessageInfo {
  return {
    type: "user",
    id,
    time: { created: 1 },
    text,
    ...(peer ? { metadata: { source: PEER_SOURCE } } : {}),
  } as unknown as SessionMessageInfo;
}

function synthetic(id: string, text: string): SessionMessageInfo {
  return { type: "synthetic", id, time: { created: 1 }, text } as unknown as SessionMessageInfo;
}

function report(id: string, text: string, input = 120_000): SessionMessageInfo {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { providerID: "openai", id: "gpt-6.1-terra" },
    content: [{ type: "text", text }],
    tokens: { input, output: 100, reasoning: 0, cache: { read: 3_000, write: 0 } },
    time: { created: 1, completed: 2 },
    finish: "stop",
  } as unknown as SessionMessageInfo;
}

function assistantWithContent(id: string, content: unknown, finish: string = "stop"): SessionMessageInfo {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { providerID: "openai", id: "gpt-6.1-terra" },
    content,
    tokens: { input: 120_000, output: 100, reasoning: 0, cache: { read: 3_000, write: 0 } },
    time: { created: 1, completed: 2 },
    finish,
  } as unknown as SessionMessageInfo;
}

function compacted(id: string, summary: string, nativeMessages?: unknown): SessionMessageInfo {
  return {
    type: "compaction",
    id,
    time: { created: 1 },
    status: "completed",
    reason: "manual",
    summary,
    ...(nativeMessages === undefined ? {} : { native: { messages: nativeMessages } }),
  } as unknown as SessionMessageInfo;
}

function completedTool(name: string, secret: string): unknown {
  return {
    type: "tool",
    id: `call_${name}`,
    name,
    state: {
      status: "completed",
      input: { todos: secret },
      content: [{ type: "text", text: secret }],
    },
    time: { created: 2 },
  };
}

test("retained native goal surfaces after a checkpoint with no live users", () => {
  const retained = "Survey the sample repository layout";
  const messages: SessionMessageInfo[] = [
    compacted("msg_compacted", "", [{ role: "user", content: retained }]),
    report("msg_report", "Checkpoint recorded. The sample parser handles its fixtures."),
  ];
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected a snapshot from retained native-compaction context");
  assert.equal(sourceOf(view), "native-compaction");
  assert.ok(view.evidence.excerpt.includes(retained));
  assert.match(view.evidence.excerpt, /retained/i);
});

test("peer-source native messages are never promoted to user requests", () => {
  const retained = "Draft the sample rollout checklist";
  const peerText = "Peer chatter about the sample dashboard";
  const messages: SessionMessageInfo[] = [
    compacted("msg_compacted", "", [
      { role: "user", content: retained },
      { role: "user", content: peerText, metadata: { source: PEER_SOURCE } },
    ]),
    report("msg_report", "Checkpoint recorded. The checklist draft is consistent."),
  ];
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected a snapshot from the genuine retained request");
  assert.equal(sourceOf(view), "native-compaction");
  assert.ok(view.evidence.excerpt.includes(retained));
  assert.ok(!view.evidence.excerpt.includes(peerText));
});

test("live peer wire message is evidence, not a user request", () => {
  const messages: SessionMessageInfo[] = [
    user("msg_human", "Rebuild the sample exporter"),
    user("msg_peer", "Peer note about the sample exporter", true),
    report("msg_report", "Checkpoint recorded. The exporter rebuild is verified on samples."),
  ];
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected a snapshot anchored on the human request");
  assert.equal(sourceOf(view), "live");
  assert.ok(view.evidence.excerpt.includes("msg_human"));
  assert.ok(!view.evidence.excerpt.includes("msg_peer"));
});

test("live human direction supersedes retained source while preserving order", () => {
  const retained = "Survey the sample repository layout";
  const shared = "Confirm the sample deploy window";
  const live = "Proceed with the sample follow-up";
  const messages: SessionMessageInfo[] = [
    compacted("msg_compacted", "", [
      { role: "user", content: retained },
      { id: "msg_dup", role: "user", content: shared },
    ]),
    user("msg_dup", shared),
    user("msg_live", live),
    report("msg_report", "Follow-up checkpoint recorded. Samples parse cleanly."),
  ];
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected a snapshot combining retained and live requests");
  assert.equal(sourceOf(view), "live");
  assert.ok(view.evidence.excerpt.includes(retained));
  assert.ok(view.evidence.excerpt.includes(live));
  assert.ok(view.evidence.excerpt.indexOf(retained) < view.evidence.excerpt.indexOf(live));
  assert.equal(view.evidence.excerpt.split("msg_dup").length - 1, 1);
});

test("completed todowrite after a report qualifies without todo bodies", () => {
  for (const reportText of [
    "Checkpoint recorded. The sample migration plan is complete.",
    "Done.",
  ]) {
    const todoSecret = `TODO_BODY_SECRET_${reportText.length}`;
    const messages: SessionMessageInfo[] = [
      user("msg_user", "Plan the sample migration"),
      assistantWithContent("msg_report", [
        { type: "text", text: reportText },
        completedTool("todowrite", todoSecret),
        { type: "text", text: "Trailing chatter after the tool" },
      ]),
    ];
    const view = snapshot(messages, 400_000);
    assert.ok(view, `expected a snapshot for report ${JSON.stringify(reportText)}`);
    assert.equal(sourceOf(view), "live");
    assert.ok(view.evidence.excerpt.includes(reportText));
    assert.ok(!view.evidence.excerpt.includes("Trailing chatter after the tool"));
    assert.ok(!view.evidence.excerpt.includes(todoSecret));
  }
});

test("foreign or unfinished tools still veto the candidate report", () => {
  const reportText = "Checkpoint recorded. The sample plan is complete.";
  const runningTodo = {
    type: "tool",
    id: "call_todowrite",
    name: "todowrite",
    state: { status: "running", input: { todos: "pending" }, metadata: {} },
    time: { created: 2 },
  };
  const errorTodo = {
    type: "tool",
    id: "call_todowrite",
    name: "todowrite",
    state: { status: "error", input: { todos: "failed" }, error: { message: "failed" } },
    time: { created: 2 },
  };
  const cases: Array<[string, unknown]> = [
    ["foreign read tool", [{ type: "text", text: reportText }, completedTool("read", "READ_SECRET")]],
    ["foreign patch tool", [{ type: "text", text: reportText }, completedTool("patch", "PATCH_SECRET")]],
    ["subagent tool", [{ type: "text", text: reportText }, completedTool("task", "TASK_SECRET")]],
    ["running todo", [{ type: "text", text: reportText }, runningTodo]],
    ["error todo", [{ type: "text", text: reportText }, errorTodo]],
    ["todo without preceding report text", [completedTool("todowrite", "TODO_SECRET")]],
  ];
  for (const [name, content] of cases) {
    const messages: SessionMessageInfo[] = [
      user("msg_user", "Plan the sample migration"),
      assistantWithContent("msg_report", content),
    ];
    assert.equal(snapshot(messages, 400_000), undefined, `${name} must veto`);
  }
  const shellAfter: SessionMessageInfo[] = [
    user("msg_user", "Plan the sample migration"),
    report("msg_report", reportText),
    { type: "shell", id: "msg_shell", time: { created: 3 } } as unknown as SessionMessageInfo,
  ];
  assert.equal(snapshot(shellAfter, 400_000), undefined, "shell activity after the report must veto");
});

test("new synthetic or peer result after the report vetoes until a later report", () => {
  const reportText = "Checkpoint recorded. The sample plan is complete.";
  const stale: SessionMessageInfo[] = [
    user("msg_user", "Plan the sample migration"),
    report("msg_first", reportText),
    synthetic("msg_synth", "Fresh synthetic outcome"),
  ];
  assert.equal(snapshot(stale, 400_000), undefined, "synthetic result after the report must veto");
  const peerStale: SessionMessageInfo[] = [
    user("msg_user", "Plan the sample migration"),
    report("msg_first", reportText),
    user("msg_peer", "Peer follow-up on the sample plan", true),
  ];
  assert.equal(snapshot(peerStale, 400_000), undefined, "peer result after the report must veto");
  const recovered: SessionMessageInfo[] = [
    user("msg_user", "Plan the sample migration"),
    report("msg_first", reportText),
    synthetic("msg_synth", "Fresh synthetic outcome"),
    report("msg_later", "Later checkpoint recorded after the synthetic outcome."),
  ];
  const view = snapshot(recovered, 400_000);
  assert.ok(view, "expected a later report to lift the veto");
  assert.ok(view.evidence.excerpt.includes("Later checkpoint recorded after the synthetic outcome."));
});

test("summary-only fallback is labelled context, not a new request", () => {
  const summary = "Sample compaction digest. Prior sample work settled. ".repeat(1_500);
  const messages: SessionMessageInfo[] = [
    compacted("msg_compacted", summary),
    report("msg_report", "Checkpoint recorded after compaction. Samples remain green."),
  ];
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected a snapshot from the compaction summary");
  assert.equal(sourceOf(view), "compaction-summary");
  assert.ok(view.evidence.excerpt.includes("Sample compaction digest."));
  assert.match(view.evidence.excerpt, /summar/i);
  assert.ok(Buffer.byteLength(JSON.stringify(view.evidence.excerpt), "utf8") <= 24 * 1024);
});

test("native media, reasoning, and encrypted fields never enter evidence", () => {
  const messages: SessionMessageInfo[] = [
    compacted(
      "msg_compacted",
      "",
      [
        { role: "user", content: "Draft the migration plan for the sample service" },
        {
          role: "user",
          content: [
            { type: "text", text: "Record the sample rollout steps" },
            { type: "input_text", text: "Note the sample rollback trigger" },
            { type: "image_url", image_url: { url: "MEDIA_SECRET_URL" } },
            { type: "tool_use", id: "tool_1", name: "read", input: { path: "TOOL_SECRET_PATH" } },
          ],
        },
        { role: "assistant", content: "REASONING_SECRET_TEXT" },
        {
          role: "user",
          content: "Visible follow-up on the sample plan",
          checkpoint: { ciphertext: "CIPHER_SECRET" },
        },
      ],
    ),
    report("msg_report", "Checkpoint recorded. The sample plan reads consistently."),
  ];
  (messages[0] as unknown as { native: Record<string, unknown> }).native["checkpoint"] =
    "ENCRYPTED_CHECKPOINT_SECRET";
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected a snapshot from the visible retained requests");
  assert.equal(sourceOf(view), "native-compaction");
  for (const visible of [
    "Draft the migration plan for the sample service",
    "Record the sample rollout steps",
    "Note the sample rollback trigger",
    "Visible follow-up on the sample plan",
  ]) {
    assert.ok(view.evidence.excerpt.includes(visible));
  }
  for (const secret of [
    "MEDIA_SECRET_URL",
    "TOOL_SECRET_PATH",
    "REASONING_SECRET_TEXT",
    "CIPHER_SECRET",
    "ENCRYPTED_CHECKPOINT_SECRET",
  ]) {
    assert.ok(!view.evidence.excerpt.includes(secret));
  }
});

test("oversized protected request or report declines despite retained context", () => {
  const retained = "Survey the sample repository layout";
  const bigUser: SessionMessageInfo[] = [
    compacted("msg_compacted", "", [{ role: "user", content: retained }]),
    user("msg_big", "x".repeat(25_000)),
    report("msg_report", "Checkpoint recorded."),
  ];
  assert.equal(snapshot(bigUser, 400_000), undefined, "oversized current request must decline");
  const bigReport: SessionMessageInfo[] = [
    compacted("msg_compacted", "", [{ role: "user", content: retained }]),
    user("msg_user", "Proceed with the sample follow-up"),
    report("msg_report", "y".repeat(25_000)),
  ];
  assert.equal(snapshot(bigReport, 400_000), undefined, "oversized current report must decline");
});

test("missing sources remain explicitly unavailable", () => {
  const messages: SessionMessageInfo[] = [
    compacted("msg_compacted", ""),
    report("msg_report", "Checkpoint recorded with no recoverable request."),
  ];
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected an explicit unavailable snapshot, not a silent drop");
  assert.equal(sourceOf(view), "unavailable");
  assert.match(view.evidence.excerpt, /unavailable/i);
});

test("historical tool marker precedes a later report without unknown claims", () => {
  const toolSecret = "HISTORICAL_TOOL_SECRET";
  const reportText = "Later checkpoint recorded. The sample review is consistent.";
  const messages: SessionMessageInfo[] = [
    user("msg_user", "Review the sample service"),
    assistantWithContent("msg_tools", [{ type: "tool", id: "call_1", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: toolSecret }] }, time: { created: 2 } }]),
    report("msg_report", reportText),
  ];
  const view = snapshot(messages, 400_000);
  assert.ok(view, "expected a snapshot anchored on the later report");
  assert.ok(view.evidence.excerpt.includes(reportText));
  assert.ok(!view.evidence.excerpt.includes(toolSecret));
  const marker = view.evidence.excerpt.search(/omitt/i);
  assert.ok(marker >= 0, "expected a marker stating result bodies are omitted");
  assert.ok(marker < view.evidence.excerpt.indexOf(reportText));
  assert.ok(!view.evidence.excerpt.toLowerCase().includes("unknown"));
});

test("truncated, filtered, or still-streaming finishes decline as incomplete-report", () => {
  const reportText = "Checkpoint recorded. The sample plan is complete.";
  const cases: Array<[string, SessionMessageInfo]> = [
    ["length", { ...report("msg_report", reportText), finish: "length" } as unknown as SessionMessageInfo],
    ["content-filter", { ...report("msg_report", reportText), finish: "content-filter" } as unknown as SessionMessageInfo],
    ["error without last.error", { ...report("msg_report", reportText), finish: "error" } as unknown as SessionMessageInfo],
    ["unknown", { ...report("msg_report", reportText), finish: "unknown" } as unknown as SessionMessageInfo],
    ["absent finish", (() => { const value = { ...report("msg_report", reportText) } as unknown as Record<string, unknown>; delete value.finish; return value as unknown as SessionMessageInfo; })()],
    ["text-only tool-calls", { ...report("msg_report", reportText), finish: "tool-calls" } as unknown as SessionMessageInfo],
  ];
  for (const [name, candidate] of cases) {
    const selected = selectSnapshot([user("msg_user", "Plan the sample migration"), candidate], 400_000);
    assert.equal(selected.type, "skip", `${name} must not select a snapshot`);
    assert.equal(selected.reason, "incomplete-report", `${name} must report incomplete-report`);
  }
});

test("absent or nonfinite completed timestamp declines as incomplete-report", () => {
  const reportText = "Checkpoint recorded. The sample plan is complete.";
  const withoutCompleted = { ...report("msg_report", reportText), time: { created: 1 } } as unknown as SessionMessageInfo;
  const nanCompleted = { ...report("msg_report", reportText), time: { created: 1, completed: Number.NaN } } as unknown as SessionMessageInfo;
  const infiniteCompleted = { ...report("msg_report", reportText), time: { created: 1, completed: Number.POSITIVE_INFINITY } } as unknown as SessionMessageInfo;
  for (const [name, candidate] of [["absent completed", withoutCompleted], ["NaN completed", nanCompleted], ["infinite completed", infiniteCompleted]] as const) {
    const selected = selectSnapshot([user("msg_user", "Plan the sample migration"), candidate], 400_000);
    assert.equal(selected.type, "skip", `${name} must not select a snapshot`);
    assert.equal(selected.reason, "incomplete-report", `${name} must report incomplete-report`);
  }
});

test("explicit error signal keeps the existing no-report veto", () => {
  const candidate = {
    ...report("msg_report", "Checkpoint recorded. The sample plan is complete."),
    finish: "error",
    error: { message: "provider reported an error" },
  } as unknown as SessionMessageInfo;
  const selected = selectSnapshot([user("msg_user", "Plan the sample migration"), candidate], 400_000);
  assert.equal(selected.type, "skip");
  assert.equal(selected.reason, "no-report");
});

test("successful stop and todowrite tool-calls reports remain eligible", () => {
  const stopView = snapshot([user("msg_user", "Plan the sample migration"), report("msg_report", "Checkpoint recorded. The sample plan is complete.")], 400_000);
  assert.ok(stopView, "expected a snapshot for an explicit stop report");
  const toolCallsView = snapshot([user("msg_user", "Plan the sample migration"), assistantWithContent("msg_report", [
    { type: "text", text: "Checkpoint recorded. The sample plan is complete." },
    completedTool("todowrite", "TODO_BODY_SECRET"),
  ], "tool-calls")], 400_000);
  assert.ok(toolCallsView, "expected a snapshot for a completed todowrite tool-calls report");
  assert.ok(toolCallsView.evidence.excerpt.includes("Checkpoint recorded. The sample plan is complete."));
});
