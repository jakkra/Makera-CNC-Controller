import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE_GOTO_KINDS, surfaceGotoDestination } from "./modules/surface-goto.js";
import { createWorkMoveInteractions } from "./modules/work-move.js";

const here = dirname(fileURLToPath(import.meta.url));
const learned = {
  anchors: { available: true, anchor1: { x: -191.29, y: -193.9 }, anchor2: { x: -102.79, y: -148.9 } },
  clearance: { x: -11.6, y: -14.6, z: -3 },
};

test("Surface go-to destinations resolve to machine coordinates", () => {
  assert.deepEqual(surfaceGotoDestination("origin", { workOrigin: { x: -150, y: -120, z: -40 }, learned }), { target: { x: -150, y: -120 }, label: "Work origin" });
  assert.deepEqual(surfaceGotoDestination("clearance", { learned }), { target: { x: -11.6, y: -14.6, z: -3 }, label: "Clearance" });
  assert.deepEqual(surfaceGotoDestination("anchor1", { learned }), { target: { x: -191.29, y: -193.9 }, label: "Anchor 1" });
  assert.deepEqual(surfaceGotoDestination("anchor2", { learned }), { target: { x: -102.79, y: -148.9 }, label: "Anchor 2" });
});

test("Surface go-to destinations report missing data instead of guessing", () => {
  assert.match(surfaceGotoDestination("origin", { workOrigin: null, learned }).error, /work origin is unavailable/);
  assert.match(surfaceGotoDestination("clearance", { learned: {} }).error, /Clearance position is unavailable/);
  assert.match(surfaceGotoDestination("anchor1", { learned: { anchors: { available: false, anchor1: { x: 1, y: 2 } } } }).error, /Anchor 1 position is unavailable/);
  assert.match(surfaceGotoDestination("nope", { learned }).error, /Unknown destination/);
});

test("every go-to button in the Surface jog view has a destination", () => {
  const html = readFileSync(join(here, "index.html"), "utf8");
  const kinds = [...html.matchAll(/data-surface-goto="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, [...SURFACE_GOTO_KINDS]);
});

test("tap move carries an optional Z target and caller label", () => {
  const sent = [];
  let label = "";
  const move = createWorkMoveInteractions({
    documentRef: { getElementById: (id) => (id === "tap-feed-mm-min" ? { value: "600", setCustomValidity() {} } : null) },
    getMachineSettings: () => ({ tap_feed_mm_min: 600 }),
    getJogLink: () => "online",
    getJogArmed: () => true,
    sendJog: (msg) => { sent.push(msg); return 7; },
    setJogTargetLabel: (text) => { label = text; },
  });
  move.sendTapMove({ x: -11.6, y: -14.6, z: -3 }, "Clearance");
  assert.deepEqual(sent[0].target, { x: -11.6, y: -14.6, z: -3 });
  assert.equal(sent[0].type, "target");
  assert.equal(label, "Clearance");
  move.sendTapMove({ x: 1, y: 2 });
  assert.deepEqual(sent[1].target, { x: 1, y: 2 });
});
