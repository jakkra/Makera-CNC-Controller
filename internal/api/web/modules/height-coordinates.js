// Pure coordinate conversion and export-bound helpers for outline/field-probe
// data. The application supplies the current state and numeric helpers.

export function outlineExportPoints(origin, outlineState, axisValue) {
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const oz = axisValue(origin, "z");
  return outlineState.points.map((p) => {
    const mx = Number(p.machine_x);
    const my = Number(p.machine_y);
    const mz = Number(p.machine_z);
    return {
      x: Number.isFinite(mx) && ox !== null ? mx - ox : p.x,
      y: Number.isFinite(my) && oy !== null ? my - oy : p.y,
      z: Number.isFinite(mz) && oz !== null ? mz - oz : p.z,
      captured_at: p.captured_at,
      probed: !!p.probed,
    };
  });
}

export function outlineEffectiveExportPoints(origin, outlineState, axisValue, effectiveOutlineGeometry) {
  const raw = outlineExportPoints(origin, outlineState, axisValue);
  const geometry = effectiveOutlineGeometry(raw, outlineState.closed, outlineState.curveFit);
  if (geometry.limited) throw new Error("curve fit generated too many outline points");
  return geometry.points;
}

export function fieldProbeHeightReference(origin, outlineState, finiteOr, axisValue) {
  const floorZ = finiteOr(outlineState.floorMachineZ, NaN);
  if (Number.isFinite(floorZ)) return { machineZ: floorZ, kind: "floor", label: "probed floor" };
  const storedZ = finiteOr(outlineState.fieldReferenceMachineZ, NaN);
  if (Number.isFinite(storedZ)) return { machineZ: storedZ, kind: "work_origin", label: "captured Z origin" };
  const originZ = axisValue(origin, "z");
  if (originZ !== null) return { machineZ: originZ, kind: "work_origin", label: "current Z origin" };
  throw new Error("field probe Z reference is unavailable");
}

export function fieldProbeExportPoints(origin, outlineState, axisValue, fieldProbeHeightReference) {
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const reference = fieldProbeHeightReference(origin, outlineState);
  return outlineState.fieldProbeResults.map((p) => {
    const mx = Number(p.machine_x);
    const my = Number(p.machine_y);
    const mz = Number(p.machine_z);
    return {
      x: Number.isFinite(mx) && ox !== null ? mx - ox : p.x,
      y: Number.isFinite(my) && oy !== null ? my - oy : p.y,
      z: Number.isFinite(mz) ? mz - reference.machineZ : p.z,
      captured_at: p.captured_at,
      probe_kind: p.probe_kind,
    };
  });
}

export function exportExtents(table, points) {
  let minX = table.x_min;
  let maxX = table.x_max;
  let minY = table.y_min;
  let maxY = table.y_max;
  for (const p of points) {
    if (Number.isFinite(p.x)) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    if (Number.isFinite(p.y)) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    minX = 0;
    maxX = 1;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    minY = 0;
    maxY = 1;
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return { x_min: minX, x_max: maxX, y_min: minY, y_max: maxY, width, height };
}
