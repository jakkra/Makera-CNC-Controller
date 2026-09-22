import test from "node:test";
import assert from "node:assert/strict";
import { mountFeedOverride } from "./modules/active-job.js";

function makeFeedOverride(overrides = {}) {
  const state = { pending: "", pendingPercent: null, machine: { feed: { override: 144 } } };
  const events = [];
  const feature = mountFeedOverride({
    request: async (...args) => {
      events.push(["request", ...args]);
      if (overrides.request) return overrides.request(...args);
      return { json: async () => ({ message: "Feed override accepted.", verified: true }) };
    },
    getActiveGcodePending: () => state.pending,
    setActiveGcodePending: (value) => { state.pending = value; events.push(["pending", value]); },
    getMachine: () => state.machine,
    setFeedOverridePendingPercent: (value) => { state.pendingPercent = value; events.push(["pending-percent", value]); },
    setActiveFeedback: (...args) => events.push(["feedback", ...args]),
    renderActiveGcode: () => events.push(["render", state.pending, state.pendingPercent]),
    pollMachine: async () => { events.push(["poll"]); if (overrides.pollMachine) await overrides.pollMachine(); },
  });
  return { feature, state, events };
}

test("feed override rounds, clamps, sends the existing request, and holds pending through poll", async () => {
  let enterPoll;
  let releasePoll;
  const pollEntered = new Promise((resolve) => { enterPoll = resolve; });
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  const { feature, state, events } = makeFeedOverride({ pollMachine: () => { enterPoll(); return pollGate; } });
  const action = feature.adjustFeedOverride(3);
  await pollEntered;
  assert.equal(state.pending, "feed_override");
  assert.equal(state.pendingPercent, 150);
  const request = events.find(([kind]) => kind === "request");
  assert.equal(request[1], "/api/feed-override");
  assert.deepEqual(request[2], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ percent: 150 }) });
  assert.deepEqual(events.slice(0, 4), [
    ["pending", "feed_override"], ["pending-percent", 150],
    ["feedback", "Setting feed override to 150%...", ""], ["render", "feed_override", 150],
  ]);
  assert.deepEqual(events.find(([kind, message]) => kind === "feedback" && message === "Feed override accepted."), ["feedback", "Feed override accepted.", "ok"]);
  releasePoll();
  await action;
  assert.deepEqual(events.slice(-3), [["pending", ""], ["pending-percent", null], ["render", "", null]]);
});

test("feed override clamps endpoints and rounds to the nearest ten", async () => {
  const { feature, events } = makeFeedOverride();
  await feature.setFeedOverride(1);
  await feature.setFeedOverride(199);
  await feature.setFeedOverride(145);
  const bodies = events.filter(([kind]) => kind === "request").map(([, , options]) => JSON.parse(options.body).percent);
  assert.deepEqual(bodies, [50, 200, 150]);
  const { feature: invalid, events: invalidEvents } = makeFeedOverride();
  await invalid.setFeedOverride("not a number");
  assert.deepEqual(invalidEvents, []);
});

test("feed override pending guard avoids duplicate work and request errors reset pending state", async () => {
  const unverified = makeFeedOverride({ request: async () => ({ json: async () => ({ message: "Feed override was not verified.", verified: false }) }) });
  await unverified.feature.setFeedOverride(130);
  assert.deepEqual(unverified.events.find(([kind, message]) => kind === "feedback" && message === "Feed override was not verified."), ["feedback", "Feed override was not verified.", "error"]);
  assert.ok(unverified.events.some(([kind]) => kind === "poll"), "an unverified response still triggers the existing machine poll");

  const guarded = makeFeedOverride();
  guarded.state.pending = "run";
  await guarded.feature.setFeedOverride(120);
  await guarded.feature.adjustFeedOverride(10);
  assert.deepEqual(guarded.events, []);

  const failed = makeFeedOverride({ request: async () => { throw new Error("controller offline"); } });
  await failed.feature.setFeedOverride(120);
  assert.deepEqual(failed.events.find(([kind, message]) => kind === "feedback" && String(message).startsWith("Feed override failed:")), ["feedback", "Feed override failed: controller offline", "error"]);
  assert.equal(failed.state.pending, "");
  assert.equal(failed.state.pendingPercent, null);
  assert.deepEqual(failed.events.slice(-3), [["pending", ""], ["pending-percent", null], ["render", "", null]]);
});
