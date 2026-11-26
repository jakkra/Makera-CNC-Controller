import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROBE_3D_CATEGORIES, probe3DKindParts, probe3DKindFromParts, probe3DVariants, probe3DPlacement, probe3DDiagramSVG,
} from "./modules/probe-3d-picker.js";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.html"), "utf8");
const selectMarkup = html.slice(html.indexOf('<select id="probe-3d-kind"'), html.indexOf("</select>", html.indexOf('<select id="probe-3d-kind"')));
const selectKinds = [...selectMarkup.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);

test("every 3D probe select option round-trips through the visual picker", () => {
  assert.equal(selectKinds.length, 14);
  const pickerKinds = [];
  for (const category of PROBE_3D_CATEGORIES) {
    for (const variant of probe3DVariants(category.id)) pickerKinds.push(probe3DKindFromParts(category.id, variant.id));
  }
  assert.deepEqual([...pickerKinds].sort(), [...selectKinds].sort());
  for (const kind of selectKinds) {
    const { category, variant } = probe3DKindParts(kind);
    assert.equal(probe3DKindFromParts(category, variant), kind);
  }
});

test("the hidden select remains the request source and is not a duplicate tab stop", () => {
  assert.match(html, /<select id="probe-3d-kind" hidden aria-hidden="true" tabindex="-1">/);
  assert.match(html, /id="probe-3d-categories"[^>]*role="radiogroup"/);
  assert.match(html, /id="probe-3d-variants"[^>]*role="radiogroup"/);
});

test("the Community compatibility routine places the probe above the top face before the pocket move", () => {
  const start = probe3DPlacement("inside_top_left", true).start;
  assert.match(start, /Start a few mm above the top face/);
  assert.match(start, /sets Z zero at the first contact, then moves diagonally into the pocket/);
});

test("3D probe diagrams render every operation with the live offset values", () => {
  for (const kind of selectKinds) {
    const svg = probe3DDiagramSVG(kind, { x: 12.5, y: 7, z: 3 });
    assert.match(svg, /^<svg [^>]*role="img"/);
    assert.match(svg, /TOP VIEW/);
    const { category, variant } = probe3DKindParts(kind);
    if (variant !== "y") assert.match(svg, /X 12\.5/, kind);
    if (variant !== "x") assert.match(svg, /Y 7/, kind);
    if (category === "bore_pocket") assert.doesNotMatch(svg, /Z 3/, kind);
    else assert.match(svg, /Z 3/, kind);
  }
});

test("placement guidance matches the firmware routine", () => {
  assert.equal(probe3DPlacement("outside_top_left").sets, "Sets X, Y and Z");
  assert.match(probe3DPlacement("outside_top_left").start, /above the top face, over the stock.*top-left corner/);
  assert.match(probe3DPlacement("inside_bottom_right").start, /outside the bottom-right pocket corner/);
  assert.equal(probe3DPlacement("bore_pocket_x").sets, "Sets the X center");
  assert.match(probe3DPlacement("bore_pocket").start, /inside the bore, below the top surface/);
  assert.equal(probe3DPlacement("boss_block_y").sets, "Sets the Y center and Z");
});

test("unknown kinds fall back to a valid operation", () => {
  assert.deepEqual(probe3DKindParts("nope"), { category: "outside", variant: "bottom_left" });
  assert.equal(probe3DKindFromParts("outside", "middle"), "outside_bottom_left");
  assert.equal(probe3DKindFromParts("boss_block", "xy"), "boss_block");
});
