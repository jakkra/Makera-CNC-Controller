export const TOOL_3D_PROBE = 9999;
export const COMMUNITY_3D_PROBE_MIN_TOOL = 999990;

export function isWiredProbeTool(id) {
  return id === TOOL_3D_PROBE || (Number.isInteger(id) && id >= COMMUNITY_3D_PROBE_MIN_TOOL);
}

export function toolDisplayName(toolID) {
  switch (Number(toolID)) {
  case -1:
    return "Empty";
  case 0:
    return "Probe";
  case 8888:
    return "Laser";
  case TOOL_3D_PROBE:
    return "3D Probe";
  default:
    return Number.isFinite(Number(toolID)) ? "Tool " + Number(toolID) : "-";
  }
}

export function fmtActiveTool(tool) {
  return Number.isFinite(tool?.active) ? toolDisplayName(tool.active) : "-";
}

export function validToolID(toolID, allowEmpty = false) {
  if (!Number.isInteger(toolID)) return false;
  if (toolID === -1) return allowEmpty;
  return toolID === 0 || toolID === 8888 || toolID === TOOL_3D_PROBE || (toolID >= 1 && toolID <= 999);
}
