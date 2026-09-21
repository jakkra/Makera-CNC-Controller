// Pure helpers for outline capture, independent of DOM, transport, and state.
export function capturedOutlinePosition(position) {
  const machine = {};
  const work = {};
  const origin = {};
  for (const axis of ["x", "y", "z"]) {
    const m = Number(position?.mpos?.[axis]);
    const w = Number(position?.wpos?.[axis]);
    if (!Number.isFinite(m) || !Number.isFinite(w)) {
      throw new Error("captured machine and work positions must include X, Y, and Z");
    }
    machine[axis] = m;
    work[axis] = w;
    origin[axis] = m - w;
  }
  return { machine, work, origin };
}
