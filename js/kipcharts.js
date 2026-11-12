/* The results' charts: the centre of mass's path around the bar (side view, true scale), and time series (energy,
 * force through the bar, body shape) shaded by rep stage. All scrub the video. */
import { tok, clamp, rampStops, rampAt, setup, ticks, fmt, dot, label } from "./chartkit.js";

/** the point that has to reach the bar, by movement */
export const GOAL = { pullup: ["chin", "Chin"], c2b: ["sh", "Shoulders"], bmu: ["sh", "Shoulders"], t2b: ["toe", "Toes"], swing: ["toe", "Toes"] };
export const where = (R, i) => {
  const r = R.repOf[i];
  if (!r) return "Swing";
  const s = R.stages.find((q) => q.rep === r && i >= q.i0 && i <= q.i1);
  return `Rep ${r}${s ? ` · ${s.name}` : ""}`;
};

/* ------------------------------------------------------------------ path around the bar */
export function drawPath(canvas, R, cursor) {
  const w0 = canvas.parentElement.clientWidth;
  const [gk, gname] = GOAL[R.move] || GOAL.pullup;
  const G = R.pl[gk];
  let fl = -0.2, fr = 0.2, ub = 0.15, ul = -0.3, vTop = 0;
  for (let i = 0; i < R.n; i++) {
    for (const [f, u] of [[R.comF[i], R.comU[i]], [G.f[i], G.u[i]]]) { fl = Math.min(fl, f); fr = Math.max(fr, f); ul = Math.min(ul, u); ub = Math.max(ub, u); }
    vTop = Math.max(vTop, R.speed[i]);
  }
  fl -= 0.08; fr += 0.08; ub += 0.08; ul -= 0.08;
  vTop = Math.max(1, Math.ceil(vTop * 4) / 4);
  const m = { l: 38, r: 10, t: 22, b: 34 };
  // one scale both ways: the path's true shape
  const k = Math.min((w0 - m.l - m.r) / (fr - fl), 460 / (ub - ul));
  const h = Math.round(clamp(m.t + m.b + k * (ub - ul), 240, 520));
  const { ctx, w } = setup(canvas, h);
  const cx = m.l + (w - m.l - m.r - k * (fr - fl)) / 2;
  const px = (f) => cx + (f - fl) * k, py = (u) => m.t + (ub - u) * k;

  ctx.lineWidth = 1;
  for (const v of ticks(ul, ub, 6)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(fmt(v, 1), m.l - 6, py(v));
  }
  for (const v of ticks(fl, fr, 5)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(Math.round(px(v)) + 0.5, m.t); ctx.lineTo(Math.round(px(v)) + 0.5, h - m.b); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(v > 0 ? `+${fmt(v, 1)}` : fmt(v, 1), px(v), h - m.b + 5);
  }
  ctx.fillStyle = tok("--muted"); ctx.textBaseline = "top";
  ctx.textAlign = "left"; ctx.fillText("m from the bar", 4, 2);
  ctx.fillText("← back", m.l, h - 13);
  ctx.textAlign = "right"; ctx.fillText("forward →", w - m.r, h - 13);

  // the goal point's path, thin; the centre of mass's, coloured by speed
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = tok("--ink-2"); ctx.globalAlpha = 0.45; ctx.lineWidth = 1.25;
  ctx.beginPath(); for (let i = 0; i < R.n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, px(G.f[i]), py(G.u[i])); ctx.stroke();
  ctx.globalAlpha = 1;
  const stops = rampStops();
  ctx.lineWidth = 2.5;
  for (let i = 1; i < R.n; i++) {
    ctx.strokeStyle = rampAt(stops, R.speed[i] / vTop);
    ctx.beginPath(); ctx.moveTo(px(R.comF[i - 1]), py(R.comU[i - 1])); ctx.lineTo(px(R.comF[i]), py(R.comU[i])); ctx.stroke();
  }
  // the bar, end-on
  ctx.beginPath(); ctx.arc(px(0), py(0), 5, 0, 7); ctx.fillStyle = tok("--surface"); ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = tok("--ink"); ctx.stroke();
  label(ctx, "bar", px(0), py(0), "right", w);
  // each rep's top
  const ink = tok("--ink");
  for (const r of R.reps) { dot(ctx, px(R.comF[r.cTop]), py(R.comU[r.cTop]), 3.5, ink); label(ctx, String(r.n), px(R.comF[r.cTop]), py(R.comU[r.cTop]), "right", w); }
  if (cursor !== null) {
    dot(ctx, px(G.f[cursor]), py(G.u[cursor]), 3.5, tok("--ink-2"));
    dot(ctx, px(R.comF[cursor]), py(R.comU[cursor]), 5, tok("--accent"));
  }
  return { px, py, vTop, stops, gname };
}
export function pathHit(geo, R, x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < R.n; i++) { const d = (geo.px(R.comF[i]) - x) ** 2 + (geo.py(R.comU[i]) - y) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}

/* ------------------------------------------------------------------ over time */
/**
 * lines: [{ v: Float64Array, color: "--token", width, dash? }], unit, d (decimals), ref (a level to draw, e.g. 1×
 * bodyweight), lo/hi minimums; rep stages shaded; tops marked.
 */
export function drawSeries(canvas, R, cursor, { lines, unit, d = 1, ref = null, lo = Infinity, hi = -Infinity, h = 200 }) {
  const { ctx, w } = setup(canvas, h);
  const t = (i) => i / R.fs;
  for (const L of lines) for (let i = 0; i < R.n; i++) { lo = Math.min(lo, L.v[i]); hi = Math.max(hi, L.v[i]); }
  if (ref !== null) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); }
  const pad = 0.08 * (hi - lo || 1);
  lo -= pad; hi += pad;
  const m = { l: 38, r: 10, t: 20, b: 24 };
  const px = (s) => m.l + (s / Math.max(1e-6, t(R.n - 1))) * (w - m.l - m.r);
  const py = (v) => h - m.b - ((v - lo) / (hi - lo)) * (h - m.t - m.b);
  ctx.globalAlpha = 0.14;
  for (const s of R.stages) {
    const a = px(t(s.i0)) + 1, b = px(t(s.i1)) - 1;
    if (b > a) { ctx.fillStyle = tok(`--s${s.slot}`); ctx.fillRect(a, m.t, b - a, h - m.t - m.b); }
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  for (const v of ticks(lo, hi, 5)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(fmt(v, d), m.l - 6, py(v));
  }
  for (const v of ticks(0, t(R.n - 1), 6)) {
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(fmt(v, 1), px(v), h - m.b + 5);
  }
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(unit, 4, 0);
  ctx.textAlign = "right"; ctx.fillText("s", w - m.r, h - m.b + 5);
  if (ref !== null) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = tok("--axis"); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(m.l, py(ref)); ctx.lineTo(w - m.r, py(ref)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const L of lines) {
    ctx.strokeStyle = tok(L.color); ctx.lineWidth = L.width || 2;
    if (L.dash) ctx.setLineDash(L.dash);
    ctx.beginPath();
    for (let i = 0; i < R.n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, px(t(i)), py(L.v[i]));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const r of R.reps) { ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(String(r.n), px(t(r.top)), m.t - 14); }
  if (cursor !== null) {
    ctx.strokeStyle = tok("--ink-2"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(px(t(cursor))) + 0.5, m.t); ctx.lineTo(Math.round(px(t(cursor))) + 0.5, h - m.b); ctx.stroke();
    for (const L of lines) dot(ctx, px(t(cursor)), py(L.v[cursor]), 3.5, tok(L.color));
  }
  return { m, w, n: R.n };
}
export function seriesHit(geo, x) {
  const frac = clamp((x - geo.m.l) / (geo.w - geo.m.l - geo.m.r), 0, 1);
  return Math.round(frac * (geo.n - 1));
}

/** tooltip for sample i: built with textContent */
export function fillTip(tip, R, i) {
  tip.replaceChildren();
  const b = document.createElement("b");
  b.textContent = `${R.Fb[i].toFixed(2)}× bodyweight`;
  tip.append(b);
  const E = R.kg ? `${Math.round(R.Er[i] * R.kg)} J` : `${R.Er[i].toFixed(1)} J/kg`;
  for (const text of [`energy ${E} · ${R.speed[i].toFixed(2)} m/s`, `hips ${Math.round(R.hip[i])}° · shoulders ${Math.round(R.shoulder[i])}°`, `${(i / R.fs).toFixed(2)} s · ${where(R, i)}`]) {
    const r = document.createElement("div");
    r.className = "row";
    r.textContent = text;
    tip.append(r);
  }
}
