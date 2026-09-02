import test from "node:test";
import assert from "node:assert/strict";
import { acceptRufloLiveEvent, parseRufloSseBlock } from "../test-dist/ruflo-live-client.mjs";

test("parses data frames and ignores heartbeat-only blocks", () => {
  assert.deepEqual(parseRufloSseBlock("id: 12\nevent: task_running\ndata: {\"payload\":{\"session\":{\"status\":\"running\"}}}"), {
    id: "12",
    type: "task_running",
    payload: { session: { status: "running" } },
  });
  assert.equal(parseRufloSseBlock(": heartbeat 2026-09-02T00:00:00.000Z"), undefined);
  assert.equal(parseRufloSseBlock("id: 1\ndata: not-json"), undefined);
});

test("filters duplicate numeric events while allowing a fresh stream", () => {
  assert.equal(acceptRufloLiveEvent("", "1"), true);
  assert.equal(acceptRufloLiveEvent("7", "7"), false);
  assert.equal(acceptRufloLiveEvent("7", "6"), false);
  assert.equal(acceptRufloLiveEvent("7", "8"), true);
  assert.equal(acceptRufloLiveEvent("7", "non-numeric"), true);
});