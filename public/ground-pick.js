// Depth buffers can be unavailable on some devices or while tiles are loading.
// Try actual rendered depth, then terrain, then a sampled ground height.
export async function pickGround(C, viewer, screen, { studioPick, sampleGround } = {}) {
  const scene = viewer.scene;
  let point;
  if (scene.pickPositionSupported !== false) {
    try { point = scene.pickPosition(screen); } catch { /* Unsupported depth picking. */ }
  }
  if (C.defined(point)) return C.Cartographic.fromCartesian(point);
  const ray = viewer.camera.getPickRay(screen);
  if (!ray) return null;
  if (studioPick) return studioPick(ray);
  if (scene.globe?.show) {
    try { point = scene.globe.pick(ray, scene); } catch { /* Try sampled terrain next. */ }
    if (C.defined(point)) return C.Cartographic.fromCartesian(point);
  }
  // An ellipsoid hit only provides longitude/latitude; never use its zero height
  // as real street elevation. Require actual tile/terrain data before placing.
  const hit = C.IntersectionTests.rayEllipsoid(ray, C.Ellipsoid.WGS84);
  if (!hit || !sampleGround) return null;
  const t = hit.start >= 0 ? hit.start : hit.stop;
  if (t < 0) return null;
  const carto = C.Cartographic.fromCartesian(C.Ray.getPoint(ray, t));
  try {
    const height = await sampleGround(carto);
    if (!Number.isFinite(height)) return null;
    carto.height = height;
    return carto;
  } catch { return null; }
}
