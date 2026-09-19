export function fmtCoord(v) {
  return Number.isFinite(v) ? v.toFixed(3) : "-";
}

export function fmtPos(p, estimated = false) {
  if (!p) return "-";
  return `X ${fmtCoord(p.x)} Y ${fmtCoord(p.y)} Z ${fmtCoord(p.z)}${estimated ? " est" : ""}`;
}
