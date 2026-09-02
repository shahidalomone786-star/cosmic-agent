import test from "node:test";
import assert from "node:assert/strict";
import { RufloLiveEventHub, sanitizeRufloEventPayload } from "../test-dist/ruflo-live-events.mjs";

const snapshot = { session: "safe-session", status: "running", nested: { value: "visible" } };

test("publishes ordered numeric ids and replays only newer events", () => {
  const hub = new RufloLiveEventHub();
  hub.publish("session-1", "session_started", "running", { message: "started" });
  hub.publish("session-1", "task_running", "running", { task: "inspect" }, "task-1");
  const received = [];
  const subscription = hub.subscribe("session-1", "1", snapshot, (event) => received.push(event));
  assert.deepEqual(subscription.replay.map((event) => event.id), ["2"]);
  assert.equal(subscription.replay[0].taskId, "task-1");
  hub.publish("session-1", "task_completed", "completed", { task: "inspect" }, "task-1");
  assert.equal(received.at(-1).id, "3");
  subscription.unsubscribe();
  assert.equal(hub.subscriberCount("session-1"), 0);
});

test("hydrates new and stale reconnects from a bounded snapshot", () => {
  const hub = new RufloLiveEventHub();
  const first = hub.subscribe("session-2", undefined, snapshot, () => undefined);
  assert.equal(first.replay[0].type, "session_state");
  first.unsubscribe();
  for (let index = 0; index < 125; index += 1) hub.publish("session-2", "session_state", "running", { index });
  assert.equal(hub.historySize("session-2") <= 120, true);
  const stale = hub.subscribe("session-2", "1", snapshot, () => undefined);
  assert.equal(stale.replay[0].type, "session_state");
  assert.deepEqual(stale.replay[0].payload, snapshot);
  stale.unsubscribe();
});

test("removes subscribers whose handlers fail and clears idle streams", () => {
  const hub = new RufloLiveEventHub();
  const subscription = hub.subscribe("session-3", undefined, snapshot, () => {
    throw new Error("disconnected");
  });
  hub.publish("session-3", "session_state", "running", {});
  assert.equal(hub.subscriberCount("session-3"), 0);
  subscription.unsubscribe();
  hub.clear("session-3");
  assert.equal(hub.historySize("session-3"), 0);
});

test("bounds subscribers and redacts nested secret-like metadata", () => {
  const hub = new RufloLiveEventHub();
  const subscriptions = Array.from({ length: 24 }, () => hub.subscribe(`session-4`, undefined, snapshot, () => undefined));
  assert.throws(() => hub.subscribe("session-4", undefined, snapshot, () => undefined), /connection limit/);
  subscriptions.forEach((subscription) => subscription.unsubscribe());
  const safe = sanitizeRufloEventPayload({
    apiKey: "secret-value",
    nested: { authorization: "Bearer abc.def", note: "token: hidden" },
    values: Array.from({ length: 40 }, (_, index) => index),
  });
  assert.equal(safe.apiKey, "[redacted]");
  assert.deepEqual(safe.nested, { authorization: "[redacted]", note: "token=[redacted]" });
  assert.equal(safe.values.length, 24);
});