// The weather-style timeline under the map: hourly rain bars, the water depth at your spot,
// and a cursor you can drag through the storm.
import { hourLabel } from './scenarios.js';

export function createTimeline(canvas, { onScrub = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  let data = null; // { hours, rain, depth, relative }
  let t = 0;
  let dragging = false;

  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return false;
    const w = Math.round(width * ratio);
    const h = Math.round(height * ratio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  function draw() {
    const size = resize();
    if (!size) return;
    const { width, height } = size;
    ctx.clearRect(0, 0, width, height);
    if (!data?.hours?.length) {
      ctx.fillStyle = css('--muted', '#8fa3b8');
      ctx.font = '500 12px Poppins, system-ui, sans-serif';
      ctx.fillText('Choose a scenario to see the storm hour by hour', 8, height / 2 + 4);
      return;
    }
    const n = data.hours.length;
    const top = 6;
    const axis = height - 16;
    const plotH = axis - top;
    const x = (i) => (i / Math.max(n - 1, 1)) * (width - 2) + 1;
    const barW = Math.max(1, (width / n) * 0.7);

    // Day stripes and hour ticks.
    ctx.font = '500 10px Poppins, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const every = n > 96 ? 12 : n > 48 ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const date = data.hours[i];
      const hour = data.relative ? i : date.getUTCHours();
      if (!data.relative && hour === 0) {
        ctx.fillStyle = css('--line-strong', 'rgba(255,255,255,.18)');
        ctx.fillRect(x(i), top, 1, plotH);
        ctx.fillStyle = css('--text', '#e8f1f8');
        ctx.fillText(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(date), x(i) + 3, height - 3);
      } else if (hour % every === 0) {
        ctx.fillStyle = css('--line', 'rgba(255,255,255,.08)');
        ctx.fillRect(x(i), axis - 4, 1, 4);
        if (data.relative || n <= 72) {
          ctx.fillStyle = css('--muted', '#8fa3b8');
          ctx.fillText(data.relative ? `+${i}h` : String(hour).padStart(2, '0'), x(i) - 6, height - 3);
        }
      }
    }

    // Rain bars (mm per hour).
    const maxRain = Math.max(8, ...data.rain);
    ctx.fillStyle = css('--rain', '#4fb3ff');
    data.rain.forEach((mm, i) => {
      if (!(mm > 0.05)) return;
      const h = Math.max(1.5, (mm / maxRain) * plotH * 0.9);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x(i) - barW / 2, axis - h, barW, h);
    });
    ctx.globalAlpha = 1;

    // Depth at your spot.
    const maxDepth = Math.max(0.5, ...data.depth);
    ctx.beginPath();
    data.depth.forEach((d, i) => {
      const y = axis - (Math.max(0, d) / maxDepth) * plotH * 0.95;
      if (i) ctx.lineTo(x(i), y); else ctx.moveTo(x(i), y);
    });
    ctx.lineTo(x(n - 1), axis);
    ctx.lineTo(x(0), axis);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, top, 0, axis);
    fill.addColorStop(0, 'rgba(255, 196, 77, .35)');
    fill.addColorStop(1, 'rgba(255, 196, 77, .02)');
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    data.depth.forEach((d, i) => {
      const y = axis - (Math.max(0, d) / maxDepth) * plotH * 0.95;
      if (i) ctx.lineTo(x(i), y); else ctx.moveTo(x(i), y);
    });
    ctx.strokeStyle = css('--accent', '#ffc44d');
    ctx.lineWidth = 2;
    ctx.stroke();

    // Cursor.
    const cx = x(Math.max(0, Math.min(n - 1, t)));
    ctx.fillStyle = css('--text', '#ffffff');
    ctx.fillRect(cx - 1, top - 2, 2, plotH + 4);
    ctx.beginPath();
    ctx.arc(cx, top + 1, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function timeAt(clientX) {
    const rect = canvas.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
    return k * Math.max((data?.hours.length ?? 1) - 1, 0);
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!data) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    onScrub(timeAt(event.clientX));
  });
  canvas.addEventListener('pointermove', (event) => { if (dragging) onScrub(timeAt(event.clientX)); });
  const end = () => { dragging = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (event) => {
    if (!data) return;
    const step = event.shiftKey ? 6 : 1;
    if (event.key === 'ArrowRight') onScrub(Math.min(data.hours.length - 1, Math.round(t) + step));
    else if (event.key === 'ArrowLeft') onScrub(Math.max(0, Math.round(t) - step));
    else return;
    event.preventDefault();
  });
  new ResizeObserver(draw).observe(canvas);

  return {
    set(next) { data = next; t = 0; draw(); },
    setTime(value) { t = value; draw(); },
    get t() { return t; },
    get length() { return data?.hours.length ?? 0; },
    label(i) {
      if (!data?.hours.length) return '';
      const k = Math.max(0, Math.min(data.hours.length - 1, Math.round(i)));
      return data.relative ? `+${k} h` : hourLabel(data.hours[k], true);
    },
    draw,
  };
}
