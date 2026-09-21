import test from "node:test";
import assert from "node:assert/strict";
import { buildHeightPGM, buildInterpolatedHeightGrid, interpolateZ } from "./modules/height-export.js";

function deps(overrides = {}) {
  const outline = overrides.outline || {
    closed: true,
    points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
    fieldSpotGapMM: 2,
  };
  const samples = overrides.samples || [
    { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 },
    { x: 4, y: 4, z: 8 }, { x: 0, y: 4, z: 4 },
  ];
  const base = {
    outline,
    getOutline: () => outline,
    requireHeightExportOutline: (current) => {
      if (!current.closed || current.points.length < 3) throw new Error("closed outline needs at least three points");
    },
    outlineExportPoints: () => outline.points,
    outlineEffectiveExportPoints: () => outline.points,
    fieldProbeExportPoints: () => samples,
    exportExtents: (_table, points) => ({
      x_min: Math.min(...points.map((p) => p.x)), x_max: Math.max(...points.map((p) => p.x)),
      y_min: Math.min(...points.map((p) => p.y)), y_max: Math.max(...points.map((p) => p.y)),
      width: 4, height: 4,
    }),
    fieldProbeSpotGap: (current) => Number(current.fieldSpotGapMM) || 0,
    fieldProbeCenterSpacing: (gap) => 2 + gap,
    pointInPolygonOrBoundary: () => true,
    fieldProbeHeightReference: () => ({ machineZ: -10, label: "probed floor" }),
    exportWorkOrigin: () => ({ x: 10, y: 20, z: -10 }),
    axisValue: (value, axis) => value?.[axis] ?? null,
    pathNum: (value) => Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""),
    PROBE_SPOT_DIAMETER_MM: 2,
  };
  return { ...base, ...overrides };
}

test("interpolateZ uses the exact sample and inverse-distance weighting", () => {
  assert.equal(interpolateZ(0, 0, [{ x: 0, y: 0, z: 7 }, { x: 1, y: 0, z: 9 }]), 7);
  assert.equal(interpolateZ(0.5, 0, [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 10 }]), 5);
});

test("height grid preserves outline bounds, spacing, and interior samples", () => {
  const grid = buildInterpolatedHeightGrid(deps());
  assert.equal(grid.rows, 2);
  assert.equal(grid.cols, 2);
  assert.deepEqual({ x: grid.xMin, y: grid.yMin, z: grid.points[0][0].z }, { x: 0, y: 0, z: 0 });
  assert.equal(grid.points[1][1].z, 8);
});

test("PGM builder preserves metadata and emits rows from Y max to Y min", () => {
  const pgm = buildHeightPGM({
    ...deps(),
    buildInterpolatedHeightGrid: (origin) => buildInterpolatedHeightGrid({ ...deps(), origin }),
  });
  assert.match(pgm, /^P2\n/);
  assert.match(pgm, /# cnc_xy_origin_machine_mm: 10 20/);
  assert.match(pgm, /# z_reference_machine_mm: -10/);
  assert.match(pgm, /# raster_rows: Y max to Y min/);
  assert.match(pgm, /2 2\n65535\n/);
  assert.match(pgm, /32768 65535\n0 32768\n/);
});

test("PGM export carries one outline snapshot through grid, reference, and spacing", () => {
  const first = deps({ outline: {
    closed: true,
    points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
    fieldSpotGapMM: 2,
  } });
  const second = { ...first.outline, fieldSpotGapMM: 200 };
  let reads = 0;
  const gridSnapshots = [];
  const referenceSnapshots = [];
  const spacingSnapshots = [];
  const pgm = buildHeightPGM({
    ...first,
    getOutline: () => (reads++ === 0 ? first.outline : second),
    buildInterpolatedHeightGrid: (origin, snapshot) => {
      gridSnapshots.push(snapshot);
      return buildInterpolatedHeightGrid({
        ...first,
        origin,
        getOutline: () => snapshot,
        fieldProbeSpotGap: (current) => {
          spacingSnapshots.push(current);
          return Number(current.fieldSpotGapMM) || 0;
        },
      });
    },
    fieldProbeHeightReference: (_origin, snapshot) => {
      referenceSnapshots.push(snapshot);
      return { machineZ: -10, label: "probed floor" };
    },
  });
  assert.match(pgm, /^P2\n/);
  assert.equal(reads, 1, "the exporter captures current outline state once");
  assert.equal(gridSnapshots[0], first.outline);
  assert.equal(referenceSnapshots[0], first.outline);
  assert.equal(spacingSnapshots[0], first.outline);
});

test("height builders fail before geometry work for invalid outline and missing samples", () => {
  const open = deps({ outline: { closed: false, points: [] } });
  assert.throws(() => buildInterpolatedHeightGrid(open), /closed outline needs at least three points/);
  const noSamples = deps({ samples: [] });
  assert.throws(() => buildInterpolatedHeightGrid(noSamples), /field probe needs at least three samples/);
  assert.throws(() => buildHeightPGM({
    ...noSamples,
    buildInterpolatedHeightGrid: () => ({ points: [[null]], rows: 1, cols: 1 }),
  }), /field probe has no samples inside the outline/);
});
