// The homepage hero: a flooded car drawn on a canvas that shatters into glassy shards as you scroll.
// Original code; the idea of a picture breaking apart on scroll is the only thing borrowed.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A seeded random generator, so the shards fall the same way every time. */
function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * @param {object} o
 * @param {HTMLElement} o.scroller  element that scrolls (the homepage)
 * @param {HTMLElement} o.stage     positioned box the canvas fills
 * @param {HTMLCanvasElement} o.canvas
 * @param {HTMLImageElement} o.art  the picture, already laid out by CSS (its box is where the car sits)
 */
export function shatterOnScroll({ scroller, stage, canvas, art }) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let picture = null, shards = [], frame = 0, dpr = 1;

  function compose() {
    const box = stage.getBoundingClientRect();
    const car = art.getBoundingClientRect();
    if (!box.width || !box.height || !car.width || !art.naturalWidth) return false;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    picture = document.createElement('canvas');
    picture.width = canvas.width;
    picture.height = canvas.height;
    const p = picture.getContext('2d');
    const x = (car.left - box.left) * dpr, y = (car.top - box.top) * dpr, w = car.width * dpr, h = car.height * dpr;
    p.shadowColor = 'rgba(13, 79, 116, .3)';
    p.shadowBlur = 30 * dpr;
    p.shadowOffsetY = 24 * dpr;
    p.drawImage(art, x, y, w, h);
    p.shadowColor = 'transparent';
    // Floodwater up to the windows: a wavy pool over the lower part of the car, fading at its edges.
    const top = y + h * 0.6, left = x - w * 0.22, right = x + w * 1.22, bottom = y + h * 0.98;
    const pool = document.createElement('canvas');
    pool.width = picture.width;
    pool.height = picture.height;
    const q = pool.getContext('2d');
    const water = q.createLinearGradient(0, top, 0, bottom);
    water.addColorStop(0, 'rgba(160, 220, 246, .85)');
    water.addColorStop(0.55, 'rgba(79, 176, 228, .8)');
    water.addColorStop(1, 'rgba(47, 159, 219, 0)');
    q.fillStyle = water;
    const wave = (t) => top + Math.sin(t * 7.5) * h * 0.012 + Math.sin(t * 17 + 1) * h * 0.006;
    q.beginPath();
    q.moveTo(left, bottom);
    for (let i = 0; i <= 48; i++) q.lineTo(left + (right - left) * (i / 48), wave(i / 48));
    q.lineTo(right, bottom);
    q.closePath();
    q.fill();
    q.strokeStyle = 'rgba(255, 255, 255, .95)';
    q.lineWidth = 2.5 * dpr;
    q.beginPath();
    for (let i = 0; i <= 48; i++) { const px = left + (right - left) * (i / 48); if (i) q.lineTo(px, wave(i / 48)); else q.moveTo(px, wave(i / 48)); }
    q.stroke();
    const sides = q.createLinearGradient(left, 0, right, 0);
    sides.addColorStop(0, 'rgba(0, 0, 0, 0)');
    sides.addColorStop(0.2, 'rgba(0, 0, 0, 1)');
    sides.addColorStop(0.8, 'rgba(0, 0, 0, 1)');
    sides.addColorStop(1, 'rgba(0, 0, 0, 0)');
    q.globalCompositeOperation = 'destination-in';
    q.fillStyle = sides;
    q.fillRect(0, 0, pool.width, pool.height);
    p.drawImage(pool, 0, 0);

    // Cut the picture into triangles on a jittered grid; keep the ones with something in them.
    const rand = random(7);
    const cols = box.width < 600 ? 10 : 18;
    const rows = Math.max(6, Math.round(cols * (h * 1.1) / (w * 1.2)));
    const gx0 = left, gy0 = y, gw = right - left, gh = bottom - y;
    const pts = [];
    for (let r = 0; r <= rows; r++) {
      pts.push([]);
      for (let c = 0; c <= cols; c++) {
        const edge = r === 0 || c === 0 || r === rows || c === cols;
        pts[r].push([gx0 + gw * (c / cols) + (edge ? 0 : (rand() - 0.5) * gw / cols * 0.7), gy0 + gh * (r / rows) + (edge ? 0 : (rand() - 0.5) * gh / rows * 0.7)]);
      }
    }
    const data = p.getImageData(0, 0, picture.width, picture.height).data;
    const solid = (px, py) => {
      const ix = clamp(Math.round(px), 0, picture.width - 1), iy = clamp(Math.round(py), 0, picture.height - 1);
      return data[(iy * picture.width + ix) * 4 + 3] > 24;
    };
    const cx0 = x + w / 2, cy0 = y + h / 2;
    shards = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = pts[r][c], b = pts[r][c + 1], d = pts[r + 1][c], e = pts[r + 1][c + 1];
        const tris = (r + c) % 2 ? [[a, b, e], [a, e, d]] : [[a, b, d], [b, e, d]];
        for (const tri of tris) {
          const mx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, my = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
          if (!solid(mx, my) && !tri.some(([px, py]) => solid(px * 0.7 + mx * 0.3, py * 0.7 + my * 0.3))) continue;
          const angle = Math.atan2(my - cy0, mx - cx0) + (rand() - 0.5) * 0.9;
          const reach = (0.35 + rand() * 0.9) * canvas.width * 0.55;
          const xs = tri.map((t) => t[0]), ys = tri.map((t) => t[1]);
          shards.push({
            tri, mx, my,
            bx: Math.floor(Math.min(...xs)) - 1, by: Math.floor(Math.min(...ys)) - 1,
            bw: Math.ceil(Math.max(...xs) - Math.min(...xs)) + 2, bh: Math.ceil(Math.max(...ys) - Math.min(...ys)) + 2,
            dx: Math.cos(angle) * reach, dy: Math.sin(angle) * reach * 0.8 - canvas.height * 0.08,
            spin: (rand() - 0.5) * 5,
            delay: clamp(Math.hypot(mx - cx0, my - cy0) / Math.max(w, 1) * 0.35 + rand() * 0.15, 0, 0.55),
          });
        }
      }
    }
    return true;
  }

  function progress() {
    const range = stage.getBoundingClientRect().height * 0.7;
    return clamp(scroller.scrollTop / Math.max(range, 1), 0, 1);
  }

  function draw() {
    frame = 0;
    if (!picture) return;
    const p = progress();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (p <= 0.002 || reduce) {
      ctx.globalAlpha = reduce ? 1 - p : 1;
      ctx.drawImage(picture, 0, 0);
      ctx.globalAlpha = 1;
      return;
    }
    for (const s of shards) {
      const k = clamp((p - s.delay) / (1 - s.delay), 0, 1);
      const e = k * k;
      ctx.save();
      ctx.globalAlpha = 1 - clamp((k - 0.55) / 0.45, 0, 1);
      ctx.translate(s.mx + s.dx * e, s.my + s.dy * e + canvas.height * 0.35 * e * e);
      ctx.rotate(s.spin * e);
      ctx.translate(-s.mx, -s.my);
      ctx.beginPath();
      ctx.moveTo(s.tri[0][0], s.tri[0][1]);
      ctx.lineTo(s.tri[1][0], s.tri[1][1]);
      ctx.lineTo(s.tri[2][0], s.tri[2][1]);
      ctx.closePath();
      ctx.save();
      ctx.clip();
      ctx.drawImage(picture, s.bx, s.by, s.bw, s.bh, s.bx, s.by, s.bw, s.bh);
      ctx.restore();
      if (k > 0) {
        // A glint on each edge once it has broken off.
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.65 * Math.min(1, k * 4)})`;
        ctx.lineWidth = dpr;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  const rebuild = () => { if (compose()) { stage.classList.add('ready'); schedule(); } };
  if (art.complete && art.naturalWidth) rebuild(); else art.addEventListener('load', rebuild, { once: true });
  document.fonts?.ready.then(rebuild);
  new ResizeObserver(rebuild).observe(stage);
  scroller.addEventListener('scroll', schedule, { passive: true });
}
