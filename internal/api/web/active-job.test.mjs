import test from "node:test";
import assert from "node:assert/strict";
import { mountActiveJobDispatch, mountFeedOverride } from "./modules/active-job.js";

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

function makeDispatch(overrides = {}) {
  const events = [];
  const inputs = new Map([
    ["paused-job-spindle-speed", { value: "1200" }],
    ["paused-job-spindle-direction", { value: "M3" }],
  ]);
  const feature = mountActiveJobDispatch({
    documentRef: { getElementById: (id) => inputs.get(id) || null },
    machineActionState: () => overrides.machineState || "Pause",
    jobControlModel: () => overrides.model || { speed: null, actions: {
      pause: { visible: true, disabled: false }, resume: { visible: true, disabled: false },
      "stop-spindle": { visible: true, disabled: false }, "start-spindle": { visible: true, disabled: false },
    } },
    setActiveFeedback: (...args) => events.push(["feedback", ...args]),
    runActiveJobControl: (...args) => { events.push(["active", ...args]); return "active-result"; },
    sendControl: (...args) => { events.push(["control", ...args]); return "control-result"; },
    runPausedJobCommand: (...args) => { events.push(["paused", ...args]); return "paused-result"; },
  });
  return { feature, events, inputs };
}

test("active job dispatch preserves resume state routing and feedback", async () => {
  const pause = makeDispatch({ machineState: "Pause" });
  assert.equal(await pause.feature.resumeActiveJob(), "active-result");
  assert.deepEqual(pause.events, [["active", "resume_job"]]);

  const hold = makeDispatch({ machineState: "Hold" });
  assert.equal(await hold.feature.resumeActiveJob(), "control-result");
  assert.deepEqual(hold.events, [["control", "resume"]]);

  const invalid = makeDispatch({ machineState: "Run" });
  assert.equal(await invalid.feature.resumeActiveJob(), false);
  assert.deepEqual(invalid.events, [["feedback", "Resume is unavailable while the machine is Run.", "error"]]);
});

test("job control dispatch keeps model guards and routes pause, resume, and paused spindle actions", async () => {
  const guarded = makeDispatch({ model: { speed: null, actions: { pause: { visible: false, disabled: false } } } });
  assert.equal(await guarded.feature.runJobControl("pause"), false);
  assert.deepEqual(guarded.events, [["feedback", "This job control is unavailable for the current machine state.", "error"]]);

  const valid = makeDispatch();
  assert.equal(await valid.feature.runJobControl("pause"), "active-result");
  assert.equal(await valid.feature.runJobControl("resume"), "active-result");
  assert.equal(await valid.feature.runJobControl("stop-spindle"), "paused-result");
  assert.deepEqual(valid.events, [["active", "pause_job"], ["active", "resume_job"], ["paused", "stop_spindle"]]);

  const knownSpeed = makeDispatch({ model: { speed: 1800, actions: { "start-spindle": { visible: true, disabled: false } } } });
  assert.equal(await knownSpeed.feature.runJobControl("start-spindle"), "paused-result");
  assert.deepEqual(knownSpeed.events, [["paused", "start_spindle"]]);
});

test("start-spindle dispatch reads current form values and preserves RPM/direction validation", async () => {
  const dispatch = makeDispatch();
  dispatch.inputs.get("paused-job-spindle-speed").value = "13000";
  dispatch.inputs.get("paused-job-spindle-direction").value = "M4";
  assert.equal(await dispatch.feature.runJobControl("start-spindle"), "paused-result");
  assert.deepEqual(dispatch.events, [["paused", "start_spindle", { speed_rpm: 13000, direction: "M4" }]]);

  for (const [speed, direction, message] of [
    ["0", "M3", "Enter a spindle speed from 1 to 13,000 rpm before starting."],
    ["13001", "M3", "Enter a spindle speed from 1 to 13,000 rpm before starting."],
    ["1200", "G0", "Choose clockwise or counterclockwise spindle direction before starting."],
  ]) {
    const invalid = makeDispatch();
    invalid.inputs.get("paused-job-spindle-speed").value = speed;
    invalid.inputs.get("paused-job-spindle-direction").value = direction;
    assert.equal(await invalid.feature.runJobControl("start-spindle"), false);
    assert.deepEqual(invalid.events, [["feedback", message, "error"]]);
  }
});
