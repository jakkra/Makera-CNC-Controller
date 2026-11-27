// Conservative starting points for facing with a 2-flute flat end mill on a
// desktop machine. They favour a clean, safe first cut over speed; the
// operator can nudge them in the planner.
export const FACING_MATERIALS = Object.freeze([
  { id: "softwood", label: "Softwood" },
  { id: "hardwood", label: "Hardwood" },
  { id: "mdf", label: "MDF / plywood" },
  { id: "plastic", label: "Plastic" },
  { id: "aluminium", label: "Aluminium" },
]);

export const FACING_CUTTERS = Object.freeze([3.175, 4, 6]);

// rpm, cut feed (mm/min), max depth per pass (mm) for each cutter diameter.
const TABLE = {
  softwood: { stepoverRatio: 0.4, 3.175: [12000, 1500, 1.0], 4: [12000, 1800, 1.2], 6: [12000, 2200, 1.5] },
  hardwood: { stepoverRatio: 0.4, 3.175: [12000, 1000, 0.5], 4: [12000, 1200, 0.7], 6: [12000, 1500, 1.0] },
  mdf: { stepoverRatio: 0.4, 3.175: [12000, 1200, 0.8], 4: [12000, 1500, 1.0], 6: [12000, 1800, 1.2] },
  plastic: { stepoverRatio: 0.4, 3.175: [10000, 900, 0.5], 4: [10000, 1000, 0.6], 6: [10000, 1200, 0.8] },
  aluminium: { stepoverRatio: 0.3, 3.175: [10000, 300, 0.2], 4: [10000, 350, 0.25], 6: [10000, 400, 0.3] },
};

export const DEFAULT_FACING_MATERIAL = "hardwood";
export const DEFAULT_FACING_TOOL = 1;

// Values to fill into the planner for a material and cutter diameter. A
// custom diameter uses the nearest listed cutter's speeds and its own stepover.
export function facingPreset(material, diameter) {
  const row = TABLE[material] || TABLE[DEFAULT_FACING_MATERIAL];
  const d = Number(diameter);
  if (!Number.isFinite(d) || d <= 0) return null;
  const nearest = FACING_CUTTERS.reduce((best, c) => (Math.abs(c - d) < Math.abs(best - d) ? c : best), FACING_CUTTERS[0]);
  const [rpm, feed, stepdown] = row[nearest];
  return {
    rpm,
    feed,
    plunge: Math.min(300, Math.round(feed / 3 / 10) * 10),
    stepdown,
    stepover: Math.round(d * row.stepoverRatio * 100) / 100,
  };
}

// Helix hole milling with the 3.175 mm end mill: the cutter is almost fully
// engaged, so feeds sit well below facing. pitch is the depth per turn.
const HELIX = {
  softwood: { rpm: 12000, feed: 800, pitch: 0.5 },
  hardwood: { rpm: 12000, feed: 600, pitch: 0.3 },
  mdf: { rpm: 12000, feed: 700, pitch: 0.4 },
  plastic: { rpm: 10000, feed: 500, pitch: 0.3 },
  aluminium: { rpm: 10000, feed: 200, pitch: 0.1 },
};

export const DEFAULT_HOLE_DEPTH_MM = 6;

export function helixPreset(material) {
  const { rpm, feed, pitch } = HELIX[material] || HELIX[DEFAULT_FACING_MATERIAL];
  return { rpm, feed, stepdown: pitch };
}
