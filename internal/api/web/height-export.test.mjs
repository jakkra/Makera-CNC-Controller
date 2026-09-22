import test from "node:test";
import assert from "node:assert/strict";
import { buildHeightOBJ, buildHeightPGM, buildInterpolatedHeightGrid, interpolateZ } from "./modules/height-export.js";

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

test("OBJ builder preserves metadata, ordering, dedup tolerance, and exact bytes", () => {
  const outline = { closed: true, points: [{ x: 0 }, { x: 4 }, { x: 4 }] };
  const samples = [{ x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 2 }, { x: 4, y: 4, z: 3 }, { x: 0, y: 4, z: Infinity }];
  const meshVertices = [
    { x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 2 }, { x: 4, y: 4, z: 3 },
    { x: 4.0000005, y: 0, z: 2 },
  ];
  const calls = [];
  const obj = buildHeightOBJ({
    getOutline: () => outline,
    requireHeightExportOutline: (value) => assert.equal(value, outline),
    exportWorkOrigin: () => ({ x: 10, y: 20 }),
    outlineEffectiveExportPoints: () => [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }],
    fieldProbeExportPoints: () => samples,
    buildHeightMeshVertices: () => meshVertices,
    constrainedOutlineTriangles: (points) => { calls.push(["triangulate", points.length]); return [[0, 1, 2]]; },
    orderedOutlineBoundaryIndices: (points) => { calls.push(["boundary", points.length]); return [0, 1, 2]; },
    solidifyHeightMesh: (...args) => { calls.push(["solidify", args[1], args[2], args[3]]); return { vertices: meshVertices, undersideFaces: [[2, 1, 0]], wallFaces: [[0, 1, 2]] }; },
    fieldProbeHeightReference: () => ({ label: "probed floor", machineZ: -10 }),
    pathNum: (value) => Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""),
  });
  assert.equal(obj, [
    "# CNC Proxy outline field Z probe",
    "# units: millimeters (OBJ is unitless; choose Millimeter in Fusion Insert Mesh)",
    "# coordinate system: CNC work coordinates, right-handed Z-up",
    "# axis mapping: OBJ X=CNC X, OBJ Y=CNC Y, OBJ Z=CNC Z",
    "# triangulation: constrained Delaunay with locked outline edges",
    "# xy coordinates: CNC work coordinates",
    "# cnc_xy_origin_machine_mm: 10 20",
    "# CNC Z coordinates: probed floor",
    "# z_reference_machine_mm: -10",
    "# solid: sampled top, vertical outline walls, flat underside at Z=0",
    "# sample_count: 3",
    "# mesh_vertex_count: 4",
    "# solid_vertex_count: 4",
    "o outline_field_probe", "s off",
    "v 0 0 1", "v 4 0 2", "v 4 4 3", "v 4 0 2",
    "# faces: top", "f 1 2 3",
    "# faces: underside", "f 3 2 1",
    "# faces: perimeter", "f 1 2 3",
    "# points: unused coincident probe samples", "p 4", "",
  ].join("\n"));
  assert.deepEqual(calls, [["triangulate", 3], ["boundary", 3], ["solidify", [[0, 1, 2]], [0, 1, 2], 0]]);
});

test("OBJ builder keeps sample, distinct-position, and triangulation failures", () => {
  const base = {
    getOutline: () => ({ closed: true, points: [{}, {}, {}] }),
    requireHeightExportOutline: () => {},
    exportWorkOrigin: () => ({}),
    outlineEffectiveExportPoints: () => [],
    fieldProbeExportPoints: () => [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }],
  };
  assert.throws(() => buildHeightOBJ(base), /field probe needs at least three samples/);
  assert.throws(() => buildHeightOBJ({
    ...base,
    fieldProbeExportPoints: () => [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }, { x: 0, y: 1, z: 3 }],
    buildHeightMeshVertices: () => [{ x: 0, y: 0 }, { x: 0.0000005, y: 0 }, { x: 0, y: 0.0000005 }],
  }), /field probe needs at least three distinct XY sample positions/);
  assert.throws(() => buildHeightOBJ({
    ...base,
    fieldProbeExportPoints: () => [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }, { x: 0, y: 1, z: 3 }],
    buildHeightMeshVertices: () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    constrainedOutlineTriangles: () => [],
  }), /field probe samples could not form a mesh inside the outline/);
});
