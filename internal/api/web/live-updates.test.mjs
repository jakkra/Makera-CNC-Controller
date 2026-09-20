import test from "node:test";
import assert from "node:assert/strict";
import { createLiveUpdates } from "./modules/live-updates.js";

function setup(request = async () => ({ json: async () => ({ state: "Idle" }) })) {
  const streams = [];
  const calls = [];
  class EventSource {
    constructor(url) { this.url = url; this.events = {}; streams.push(this); }
    addEventListener(name, fn) { this.events[name] = fn; }
    close() { this.closed = true; }
  }
  const live = createLiveUpdates({
    EventSource, request,
    applySnapshot: (value) => calls.push(["snapshot", value]),
    applyMachineStatus: (value) => calls.push(["machine", value]),
    appendGcodeLine: (value) => calls.push(["gcode", value]),
    applyChange: (value) => calls.push(["change", value]),
    clearConnectivityIssue: (key) => calls.push(["clear", key]),
    setConnectivityIssue: (...args) => calls.push(["error", ...args]),
    refreshJobs: async () => calls.push(["jobs"]),
  });
  return { live, streams, calls };
}

test("scoped SSE starts once, preserves dispatch order, and resets only its owned stream", () => {
  const { live, streams, calls } = setup();
  assert.equal(streams.length, 0);
  live.connectControlSSE(); live.connectControlSSE(); live.connectFilesSSE(); live.connectFilesSSE();
  assert.deepEqual(streams.map(s => s.url), ["/api/events?scope=control", "/api/events?scope=files"]);
  streams[0].events.snapshot({ data: '{"machine":{"state":"Idle"}}' });
  streams[0].events.machine({ data: '{"state":"Run"}' });
  streams[0].events.gcode({ data: '{"seq":3}' });
  streams[1].events.change({ data: '{"kind":"entry"}' });
  assert.deepEqual(calls, [["clear", "control-sse"], ["snapshot", { machine: { state: "Idle" } }], ["machine", { state: "Run" }], ["gcode", { seq: 3 }], ["change", { kind: "entry" }]]);
  live.resetEventStream("controlES");
  assert.equal(streams[0].closed, true);
  assert.equal(streams[0].onerror, null);
  assert.equal(streams[1].closed, undefined);
  live.connectControlSSE();
  assert.equal(streams.length, 3);
});

test("poll preserves status endpoint and refreshes jobs after status success or failure", async () => {
  const urls = [];
  const success = setup(async url => { urls.push(url); return { json: async () => ({ state: "Idle" }) }; });
  await success.live.pollMachine();
  assert.deepEqual(urls, ["/api/machine/status"]);
  assert.deepEqual(success.calls, [["machine", { state: "Idle" }], ["clear", "machine-status"], ["jobs"]]);
  const failure = setup(async () => { throw new Error("offline"); });
  await failure.live.pollMachine();
  assert.deepEqual(failure.calls, [["error", "machine-status", "Machine status unavailable: offline"], ["jobs"]]);
});
