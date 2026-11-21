import test from "node:test";
import assert from "node:assert/strict";
import { BED_PLATE, bedPlatePlacement, bedMapExtent, nearestBedFeature, describeBedTarget, bedPlateSVG } from "./modules/bed-plate.js";

const learned = {
  anchors: { available: true, anchor1: { x: -191.29, y: -193.9 }, anchor2: { x: -102.79, y: -148.9 } },
  config_numbers: { "coordinate.anchor_width": 15, "coordinate.anchor_length": 100 },
};
const work = { x_min: -207, x_max: -1, y_min: -206, y_max: -1 };

test("bed plate is placed from the firmware anchor and anchor width", () => {
  const p = bedPlatePlacement(learned);
  assert.ok(Math.abs(p.x0 - -206.29) < 1e-9);
  assert.ok(Math.abs(p.y0 - -208.9) < 1e-9);
  assert.deepEqual(p.anchor2, { x: -102.79, y: -148.9 });
  assert.equal(bedPlatePlacement({}), null);
  assert.equal(bedPlatePlacement({ anchors: { available: false, anchor1: { x: 1, y: 2 } } }), null);
  assert.equal(bedPlatePlacement({ anchors: learned.anchors }).anchorWidth, 15);
});

test("bed plate geometry matches the Makera Z1 MDF v2.1 STEP", () => {
  assert.equal(BED_PLATE.width, 206);
  assert.equal(BED_PLATE.depth, 206);
  assert.equal(BED_PLATE.holes.length, 17);
  assert.equal(BED_PLATE.counterbores.length, 36);
  assert.equal(BED_PLATE.largeHoles.length, 1);
});

test("map extent is the travel area alone until the plate placement is known", () => {
  assert.deepEqual(bedMapExtent(work, null), work);
  const ext = bedMapExtent(work, bedPlatePlacement(learned));
  assert.ok(ext.x_min < -206.29 && ext.y_min < -208.9 && ext.x_max > -0.29 && ext.y_max > -1);
});

test("selected points name the nearest plate hole and the anchor 1 offset", () => {
  const p = bedPlatePlacement(learned);
  const b3 = nearestBedFeature(p, p.x0 + 66, p.y0 + 109);
  assert.equal(b3.label, "Ø5 hole B3");
  assert.ok(Math.abs(b3.x - (p.x0 + 65)) < 1e-9 && Math.abs(b3.y - (p.y0 + 110)) < 1e-9);
  assert.equal(nearestBedFeature(p, p.x0 + 100, p.y0 + 140), null);
  const text = describeBedTarget(p, -150, -120);
  assert.equal(text.primary, "X -150.0  Y -120.0 mm");
  assert.match(text.detail, /^Anchor 1 \+41\.3 \/ \+73\.9/);
  assert.match(describeBedTarget(p, -1, -1).detail, /Off the bed plate/);
  assert.deepEqual(describeBedTarget(null, 1, 2), { primary: "X 1.0  Y 2.0 mm", detail: "" });
});

test("bed SVG draws the plate, anchors, travel and selected target", () => {
  const svg = bedPlateSVG({ work, placement: bedPlatePlacement(learned), target: { x: -150, y: -120, feature: null } });
  assert.match(svg, /class="bed-plate"/);
  assert.equal((svg.match(/class="bed-counterbore"/g) || []).length, 36);
  assert.match(svg, />Anchor 1</);
  assert.match(svg, />Anchor 2</);
  assert.match(svg, /class="bed-travel"/);
  assert.match(svg, /class="bed-target"/);
  const bare = bedPlateSVG({ work, placement: null });
  assert.doesNotMatch(bare, /bed-plate|Anchor/);
  assert.match(bare, /viewBox="-207 1 206 205"/);
});
