import test from "node:test";
import assert from "node:assert/strict";
import { bedReferenceHoles } from "./modules/bed-plate.js";
import { alignmentCenters, alignmentDelta, alignmentGcode, alignmentPlan } from "./modules/alignment-holes.js";

test("a Z1 reference pair supplies a signed spacing without moving the jogged first hole", () => {
  const holes = bedReferenceHoles({ x0: -206.29, y0: -208.9 });
  const find = (name) => holes.find((hole) => hole.name === name);
  const delta = alignmentDelta(find("A1"), find("C1"));
  assert.deepEqual(delta, { x: 90, y: 0 });
  assert.deepEqual(alignmentDelta(find("D1"), find("C1")), { x: -50, y: 0 });
  assert.deepEqual(alignmentDelta(find("A4"), find("A1")), { x: 0, y: -140 });
  assert.equal(alignmentDelta(find("A1"), find("A1")), null);
  assert.equal(find("B2"), undefined);
  assert.deepEqual(alignmentCenters({ x: -170, y: -120 }, delta), [
    { x: -170, y: -120 }, { x: -80, y: -120 },
  ]);
});

const fixture = {
  centers: [{ x: -170, y: -120 }, { x: -80, y: -120 }],
  adjustment: 0, depth: 6, stepdown: 2, rpm: 10000, feed: 120, safeZ: -10,
  machine: {
    connected: true, state: "Idle", age_ms: 0, fields: { R: "0" }, tool: { active: 3, offset: 41 },
    mpos: { x: -170, y: -120, z: -10 }, wpos: { x: 10, y: 30, z: 40 },
  },
  limits: { x_min: -206, x_max: 0, y_min: -206, y_max: 0, z_min: -100, z_max: 0 },
};

test("the L-bracket pin holes transfer both axes to the jogged start and generated program", () => {
  const holes = bedReferenceHoles({ x0: -206.29, y0: -208.9 });
  const xPin = holes.find(({ name }) => name === "L-X");
  const yPin = holes.find(({ name }) => name === "L-Y");
  const delta = alignmentDelta(yPin, xPin);
  assert.deepEqual(delta, { x: 88.5, y: -88.5 });
  assert.deepEqual(alignmentDelta(xPin, yPin), { x: -88.5, y: 88.5 });
  const centers = alignmentCenters({ x: -170, y: -110 }, delta);
  assert.deepEqual(centers, [{ x: -170, y: -110 }, { x: -81.5, y: -198.5 }]);
  const gcode = alignmentGcode(alignmentPlan({ ...fixture, centers }));
  assert.match(gcode, /G0 X98\.9125 Y-48\.5000/);
});

test("the retry enlarges both holes around the same centers and finishes at the same Z", () => {
  const initial = alignmentPlan(fixture);
  const retry = alignmentPlan({ ...fixture, adjustment: 0.02 });
  assert.equal(initial.diameter, 4);
  assert.equal(retry.diameter, 4.02);
  assert.deepEqual(initial.centers, retry.centers);
  const initialCode = alignmentGcode(initial);
  const retryCode = alignmentGcode(retry);
  assert.match(initialCode, /G0 X10\.4125 Y30\.0000/);
  assert.match(retryCode, /G0 X10\.4225 Y30\.0000/);
  assert.match(retryCode, /G0 X100\.4225 Y30\.0000/);
  assert.match(retryCode, /^; Sensei alignment setup v2 -180\.0000 -150\.0000 -50\.0000/);
  assert.match(retryCode, /G3 X10\.0000 Y30\.4225 Z0\.5625 I-0\.4225 J0\.0000/);
  assert.match(retryCode, /G3 X100\.4225 Y30\.0000 Z-6\.0000 .*\nG53 G0 Z-10\.0000\nM5/);
});

test("a hole sweep beyond travel, oversized holes and stale or rotated coordinates are rejected", () => {
  assert.throws(() => alignmentPlan({ ...fixture, centers: [{ x: -205, y: -120 }, fixture.centers[1]] }), /travel/);
  assert.throws(() => alignmentPlan({ ...fixture, adjustment: 2.35 }), /smaller than 6.35/);
  assert.throws(() => alignmentPlan({ ...fixture, machine: { ...fixture.machine, stale: true } }), /idle machine/);
  assert.throws(() => alignmentPlan({ ...fixture, machine: { ...fixture.machine, fields: { R: "1" } } }), /rotation/);
});

test("holes are cut by a helix from 1 mm above Z0: nothing moves straight down below it", () => {
  const plan = alignmentPlan(fixture);
  const lines = alignmentGcode(plan).split("\n");
  let below = 0;
  for (const line of lines) {
    const z = line.match(/ Z(-?[0-9.]+)/);
    if (!z || line.startsWith("G53") || Number(z[1]) >= 1) continue;
    below++;
    assert.match(line, /^G3 X-?[0-9.]+ Y-?[0-9.]+ Z-?[0-9.]+ I-?[0-9.]+ J-?[0-9.]+ F/, `straight move below Z0: ${line}`);
  }
  const turns = Math.ceil((fixture.depth + 1) / fixture.stepdown);
  assert.equal(below, 2 * 4 * (turns + 1));
  const descent = lines.findIndex((line) => line === "G1 Z1.0000 F120.0000");
  assert.deepEqual(lines.slice(descent - 2, descent + 2).map((line) => line.split(" ").slice(0, 2).join(" ")),
    ["G0 X10.4125", "G0 Z2.0000", "G1 Z1.0000", "G3 X10.0000"]);
  assert.ok(lines.some((line) => / Z-6.0000 /.test(line)), "still reaches the full depth");
});

test("the hole program changes to the end mill itself instead of requiring it fitted", () => {
  const probeFitted = { ...fixture.machine, tool: { active: 0, offset: 0 } };
  const lines = alignmentGcode(alignmentPlan({ ...fixture, machine: probeFitted })).split("\n");
  const change = lines.indexOf("M6 T1");
  const pause = lines.indexOf("M600");
  const spindle = lines.findIndex((line) => line.startsWith("M3 "));
  assert.ok(change > 0 && change < pause && pause < spindle, "tool change, then pause, then spindle");
  assert.ok(lines.findIndex((line) => line.startsWith("G3 ")) > spindle);
});

test("chip clearing leaves the hole after each retract depth and re-enters only cut material", () => {
  const plan = alignmentPlan({ ...fixture, stepdown: 0.1, retract: 0.5 });
  const lines = alignmentGcode(plan).split("\n");
  assert.ok(lines.includes("; Retract to clear chips every 0.5000 mm"));
  let deepest = 1;
  let retracts = 0;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("G53 ")) deepest = 1;
    const z = line.match(/ Z(-?[0-9.]+)/);
    if (!z || line.startsWith("G53")) continue;
    const value = Number(z[1]);
    if (line.startsWith("G3 ")) {
      deepest = Math.min(deepest, value);
    } else if (line === "G0 Z2.0000" && lines[index - 1].startsWith("G3 ")) {
      retracts++;
      const back = Number(lines[index + 1].match(/^G0 Z(-?[0-9.]+)$/)[1]);
      assert.ok(Math.abs(back - (deepest + 0.2)) < 1e-4, lines[index + 1]);
      assert.equal(lines[index + 2], `G1 Z${deepest.toFixed(4)} F120.0000`);
      assert.equal(lines[index + 3].split(" ")[0], "G3");
    } else if (value < 1) {
      assert.ok(value >= deepest - 1e-4, `straight move below cut depth: ${line}`);
    }
  }
  // 7 mm of helix in 0.5 mm rounds per hole; no retract before the last turn.
  assert.equal(retracts, 2 * 13);
  assert.ok(lines.some((line) => / Z-6.0000 /.test(line)), "still reaches the full depth");
});

test("without chip clearing the program has no retracts and a bad retract depth is rejected", () => {
  const lines = alignmentGcode(alignmentPlan(fixture)).split("\n");
  assert.ok(!lines.some((line) => line.startsWith("; Retract")));
  assert.equal(lines.filter((line) => line === "G0 Z2.0000").length, 2);
  assert.throws(() => alignmentPlan({ ...fixture, retract: 0 }), /retract depth/);
  assert.throws(() => alignmentPlan({ ...fixture, retract: Number.NaN }), /retract depth/);
});
