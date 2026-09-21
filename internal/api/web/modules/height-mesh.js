// Pure field-probe mesh helpers. The application owns sampling and
// triangulation; this module only turns those points into a closed OBJ-ready
// solid. Interpolation is injected so the module has no hidden application
// state or machine/UI dependency.

export function solidifyHeightMesh(meshVertices, topFaces, boundary, undersideZ) {
  if (!Number.isFinite(undersideZ)) throw new Error("solid mesh underside Z is unavailable");
  if (boundary.length < 3) throw new Error("solid mesh needs at least three boundary vertices");
  const vertices = meshVertices.map((point) => ({ ...point }));
  const usedTopIndices = [...new Set(topFaces.flat())].sort((a, b) => a - b);
  const bottomIndexByTop = new Map();
  for (const topIndex of usedTopIndices) {
    const top = meshVertices[topIndex];
    if (!top) throw new Error("solid mesh contains an invalid top vertex");
    if (top.z === undersideZ) {
      bottomIndexByTop.set(topIndex, topIndex);
      continue;
    }
    bottomIndexByTop.set(topIndex, vertices.length);
    vertices.push({ x: top.x, y: top.y, z: undersideZ });
  }
  const bottomIndex = (topIndex) => {
    const index = bottomIndexByTop.get(topIndex);
    if (index === undefined) throw new Error("solid mesh boundary is not part of the top surface");
    return index;
  };
  const undersideFaces = topFaces.map((face) =>
    face.slice().reverse().map((topIndex) => bottomIndex(topIndex))
  );
  const wallFaces = [];
  for (let index = 0; index < boundary.length; index++) {
    const topA = boundary[index];
    const topB = boundary[(index + 1) % boundary.length];
    const bottomA = bottomIndex(topA);
    const bottomB = bottomIndex(topB);
    for (const face of [[topA, bottomA, bottomB], [topA, bottomB, topB]]) {
      if (new Set(face).size === 3) wallFaces.push(face);
    }
  }
  return { vertices, undersideFaces, wallFaces };
}

export function buildHeightMeshVertices(samples, outline, interpolateZ) {
  const vertices = samples.map((point) => ({ ...point }));
  if (outline.length < 3) return vertices;
  for (let index = 0; index < outline.length; index++) {
    const previous = outline[(index - 1 + outline.length) % outline.length];
    const point = outline[index];
    const next = outline[(index + 1) % outline.length];
    const inX = point.x - previous.x;
    const inY = point.y - previous.y;
    const outX = next.x - point.x;
    const outY = next.y - point.y;
    const inLength = Math.hypot(inX, inY);
    const outLength = Math.hypot(outX, outY);
    if (inLength <= 1e-9 || outLength <= 1e-9) continue;
    const cosine = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLength * outLength)));
    if (1 - cosine < 0.08) continue;
    if (vertices.some((seen) => Math.hypot(seen.x - point.x, seen.y - point.y) <= 0.000001)) continue;
    vertices.push({
      x: point.x,
      y: point.y,
      z: interpolateZ(point.x, point.y, samples),
      probe_kind: "mesh_outline",
    });
  }
  return vertices;
}
