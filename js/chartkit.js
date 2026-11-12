/* Canvas chart basics, shared by every chart: crisp HiDPI setup, nice ticks, labels that keep inside the canvas,
 * dots with a surface ring, and the sequential ramp. Colours are read from the CSS tokens at draw time, so both
 * themes stay in step. The same helpers as the top of Bar Path's charts.js (and compare.js), in one file. */
export const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hex = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** the sequential ramp, faint (low) to strong (high), for this theme */
export const rampStops = () => tok("--ramp").split(",").map((s) => hex(s.trim()));
export function rampAt(stops, k) {
  k = clamp(k, 0, 1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k)), f = k - i, a = stops[i], b = stops[i + 1];
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(",")})`;
}
export const rampCss = (stops) => `linear-gradient(90deg, ${stops.map((s) => `rgb(${s.join(",")})`).join(", ")})`;

export function setup(canvas, h) {
  const dpr = Math.min(3, window.devicePixelRatio || 1), w = Math.max(200, canvas.parentElement.clientWidth);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  return { ctx, w, h };
}
export function ticks(lo, hi, n) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
export const fmt = (v, d) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d).replace("-", "−");
export function dot(ctx, x, y, r, fill) {
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.fillStyle = tok("--surface"); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill();
}
export function label(ctx, text, x, y, side, w) {
  ctx.fillStyle = tok("--ink-2");
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width;
  if (side === "left" && x - 9 - tw < 2) side = "right";
  if (side === "right" && x + 9 + tw > w - 2) side = "left";
  ctx.textAlign = side === "left" ? "right" : "left";
  ctx.fillText(text, side === "left" ? x - 9 : x + 9, y);
}
