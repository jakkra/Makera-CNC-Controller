import test from "node:test";
import assert from "node:assert/strict";
import {
  mobileJogAxisForResponse,
  mobileWorkAreaJogAxes,
  mobileWorkAreaJogEnabled,
  mobileWorkAreaJogRadius,
} from "./modules/workarea-jog.js";

const clampAxis = (value) => Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));

test("mobile jog response preserves deadzone, sign, and clamping", () => {
  assert.equal(mobileJogAxisForResponse(0, clampAxis, 0.12), 0);
  assert.equal(mobileJogAxisForResponse(2, clampAxis, 0.12), 1);
  assert.equal(mobileJogAxisForResponse(-2, clampAxis, 0.12), -1);
  assert.equal(mobileJogAxisForResponse(0.25, clampAxis, 0.12), 0.12 + 0.88 * Math.cbrt(0.25));
});

test("mobile work-area axes stay bounded and invert screen Y", () => {
  assert.deepEqual(mobileWorkAreaJogAxes(10, 10, 10, 10, 50, clampAxis, 0.12), { x: 0, y: 0, z: 0 });
  const axes = mobileWorkAreaJogAxes(10, 10, 60, -40, 50, clampAxis, 0.12);
  assert.ok(axes.x > 0 && axes.x < 1);
  assert.ok(axes.y > 0 && axes.y < 1);
  assert.equal(axes.y, axes.x, "equal diagonal drag components remain balanced");
  assert.equal(axes.z, 0);
});

test("mobile work-area availability and radius retain established boundaries", () => {
  assert.equal(mobileWorkAreaJogEnabled({ innerWidth: 600 }, 600), true);
  assert.equal(mobileWorkAreaJogEnabled({ innerWidth: 601 }, 600), false);
  const svg = { getBoundingClientRect: () => ({ width: 300, height: 200 }) };
  assert.equal(mobileWorkAreaJogRadius(svg), 56);
  assert.equal(mobileWorkAreaJogRadius({ getBoundingClientRect: () => ({ width: 500, height: 500 }) }), 88);
});
