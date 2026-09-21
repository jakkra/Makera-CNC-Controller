export function toolDisplayName(toolID) {
  switch (Number(toolID)) {
  case -1:
    return "Empty";
  case 0:
    return "Probe";
  case 8888:
    return "Laser";
  case 9999:
    return "3D Probe";
  default:
    return Number.isFinite(Number(toolID)) ? "Tool " + Number(toolID) : "-";
  }
}

export function validToolID(toolID, allowEmpty = false) {
  if (!Number.isInteger(toolID)) return false;
  if (toolID === -1) return allowEmpty;
  return toolID === 0 || toolID === 8888 || toolID === 9999 || (toolID >= 1 && toolID <= 999);
}
