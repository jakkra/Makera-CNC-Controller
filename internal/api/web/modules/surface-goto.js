// Fixed "Go to" destinations for the Surface jog view. Each destination is a
// machine-coordinate target sent through the ordinary tap move, which raises to
// safe Z before moving XY when Safe Z is enabled.

export const SURFACE_GOTO_KINDS = Object.freeze(["origin", "clearance", "anchor1", "anchor2"]);

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function xyPoint(point) {
  const x = finite(point?.x);
  const y = finite(point?.y);
  return x === null || y === null ? null : { x, y };
}

// Returns { target, label } or { error } for one destination.
export function surfaceGotoDestination(kind, { workOrigin = null, learned = {} } = {}) {
  switch (kind) {
    case "origin": {
      const target = xyPoint(workOrigin);
      return target ? { target, label: "Work origin" } : { error: "Current work origin is unavailable." };
    }
    case "clearance": {
      const target = xyPoint(learned?.clearance);
      if (!target) return { error: "Clearance position is unavailable. Learn machine parameters first." };
      const z = finite(learned?.clearance?.z);
      if (z !== null) target.z = z;
      return { target, label: "Clearance" };
    }
    case "anchor1":
    case "anchor2": {
      const name = kind === "anchor1" ? "Anchor 1" : "Anchor 2";
      const target = learned?.anchors?.available ? xyPoint(learned.anchors[kind]) : null;
      return target ? { target, label: name } : { error: `${name} position is unavailable. Learn machine parameters first.` };
    }
    default:
      return { error: "Unknown destination." };
  }
}
