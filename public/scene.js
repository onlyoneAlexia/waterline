// Validate links and scene files before loading any models or moving the camera.
export function validateScene(data) {
  const fail = () => { throw new Error('Invalid scene. Use a Waterline scene file or share link.'); };
  const numbers = (values, count) => Array.isArray(values) && values.length === count && values.every(Number.isFinite);
  const position = (x, y, h) => Math.abs(x) <= 180 && Math.abs(y) <= 85 && h >= -1000 && h <= 10_000_000;
  if (!data || data.v !== 1 || !Number.isFinite(data.d) || data.d < 0 || data.d > 3) fail();
  if (data.m !== undefined && !['studio', 'street'].includes(data.m)) fail();
  if (data.p !== null && (!numbers(data.p, 3) || !position(...data.p))) fail();
  if (!numbers(data.c, 5) || !position(...data.c) || Math.abs(data.c[4]) > 90) fail();
  if (!Array.isArray(data.o) || data.o.length > 40) fail();
  for (const o of data.o) {
    if (!o || typeof o.u !== 'string' || !/^\/models\/(?:library|generated)\/[a-zA-Z0-9_-]+\.glb$/.test(o.u)) fail();
    if (typeof o.n !== 'string' || o.n.length > 60 || ![o.x, o.y, o.g, o.h, o.r].every(Number.isFinite)) fail();
    if (!position(o.x, o.y, o.g) || o.h < .05 || o.h > 30 || Math.abs(o.r) > 360) fail();
  }
  return data;
}
