import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityTracker } from "../src/activity.ts";

const root = "ses_root";
const child = "ses_child";

test("an open text stream is active until its matching end event", () => {
  const tracker = new ActivityTracker();
  assert.equal(tracker.state(root).idle, true);
  tracker.observe({ type: "session.text.started", data: { sessionID: root, assistantMessageID: "msg_1" } });
  assert.equal(tracker.state(root).streaming, true);
  assert.equal(tracker.state(root).idle, false);
  tracker.observe({ type: "session.text.ended", data: { sessionID: root, assistantMessageID: "msg_1" } });
  assert.equal(tracker.state(root).idle, true);
});

test("a background shell outlives the execution that started it", () => {
  const tracker = new ActivityTracker();
  tracker.observe({ type: "session.shell.started", data: { sessionID: root, shell: { id: "sh_1", status: "running" } } });
  tracker.observe({ type: "session.execution.succeeded", data: { sessionID: root } });
  assert.equal(tracker.state(root).shells, 1);
  assert.equal(tracker.state(root).idle, false);
  tracker.observe({ type: "session.shell.ended", data: { sessionID: root, shell: { id: "sh_1", status: "exited" } } });
  assert.equal(tracker.state(root).idle, true);
});

test("a running subagent keeps its parent active until it finishes", () => {
  const tracker = new ActivityTracker();
  tracker.observe({ type: "session.created", data: { sessionID: child, parentID: root } });
  tracker.observe({ type: "session.execution.started", data: { sessionID: child } });
  assert.equal(tracker.state(root).subagents, 1);
  assert.equal(tracker.state(root).idle, false);
  tracker.observe({ type: "session.execution.succeeded", data: { sessionID: child } });
  assert.equal(tracker.state(root).idle, true);
});

test("a context request is active until the execution terminates", () => {
  const tracker = new ActivityTracker();
  tracker.noteRequest(root);
  assert.equal(tracker.state(root).requesting, true);
  assert.equal(tracker.state(root).idle, false);
  tracker.observe({ type: "session.execution.succeeded", data: { sessionID: root } });
  assert.equal(tracker.state(root).idle, true);
});

test("deleting a session clears its activity and child links", () => {
  const tracker = new ActivityTracker();
  tracker.observe({ type: "session.created", data: { sessionID: child, parentID: root } });
  tracker.noteRequest(root);
  tracker.observe({ type: "session.execution.started", data: { sessionID: child } });
  tracker.forget(child);
  assert.equal(tracker.state(root).idle, false);
  tracker.forget(root);
  assert.equal(tracker.state(root).idle, true);
});
