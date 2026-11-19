/* Canvas chart basics, shared by every chart: crisp HiDPI setup, nice ticks, labels that keep inside the canvas
 * and clear of each other, dots with a surface ring, the sequential ramp, and scrubbing by touch. Colours are read from the CSS tokens at draw time, so both
 * themes stay in step. The same helpers as the top of Bar Path's charts.js (and compare.js), in one file. */
import { num } from "./i18n.js";

export const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hex = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'; // --fs-xs

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
/** a tick label: the language's decimal mark, a real minus */
export const fmt = (v, d) => num(Math.abs(v) < 1e-9 ? 0 : v, d).replace("-", "−");
export function dot(ctx, x, y, r, fill) {
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.fillStyle = tok("--surface"); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill();
}
/** a label beside the point (x, y): on the side asked if it fits the canvas and misses what's in `placed` (labels
 * and dots already drawn), else the other side, else nudged up or down; over a surface halo, so lines running
 * under it don't strike it through. Its box is added to `placed`. */
export function label(ctx, text, x, y, side, w, placed = []) {
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width, other = side === "left" ? "right" : "left";
  const box = (s, dy) => { const x0 = s === "left" ? x - 9 - tw : x + 9; return { x0, x1: x0 + tw, y0: y + dy - 8, y1: y + dy + 8, dy }; };
  const inside = (b) => b.x0 >= 2 && b.x1 <= w - 2;
  const free = (b) => inside(b) && !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  const tries = [box(side, 0), box(other, 0), box(side, -14), box(side, 14), box(other, -14), box(other, 14)];
  const b = tries.find(free) || tries.find(inside) || tries[0];
  placed.push(b);
  ctx.textAlign = "left";
  ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = tok("--surface");
  ctx.strokeText(text, b.x0, y + b.dy);
  ctx.fillStyle = tok("--ink-2");
  ctx.fillText(text, b.x0, y + b.dy);
}
export const dotBox = (x, y, r) => ({ x0: x - r - 2, x1: x + r + 2, y0: y - r - 2, y1: y + r + 2 });

/**
 * Scrubbing a chart: a finger scrubs only once it moves sideways, or with a tap; moving up or down is left to the
 * page, which scrolls (the canvas has touch-action: pan-y). A mouse or pen scrubs from the press, and a mouse
 * also on hover when `hover`. `at({x, y})` gets canvas CSS px.
 */
export function scrub(canvas, at, { hover = false } = {}) {
  let start = null, axis = null; // a finger: where it went down; "x" once it moves sideways, "y" if up or down
  const xy = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") { at(xy(e)); return; }
    start = { x: e.clientX, y: e.clientY }; axis = null;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") { if (e.buttons || (hover && e.pointerType === "mouse")) at(xy(e)); return; }
    if (!start) return;
    if (!axis) {
      const dx = Math.abs(e.clientX - start.x), dy = Math.abs(e.clientY - start.y);
      if (Math.max(dx, dy) < 6) return;
      axis = dx > dy ? "x" : "y";
    }
    if (axis === "x") at(xy(e));
  });
  canvas.addEventListener("pointerup", (e) => { if (e.pointerType === "touch" && start && !axis) at(xy(e)); start = null; });
  canvas.addEventListener("pointercancel", () => { start = null; axis = null; });
}
