/* Signal helpers: resampling onto a time grid, zero-lag low-pass filtering, derivatives, extremes.
 * The same functions as the top of Bar Path's analysis.js (copied, not changed), exported here so both apps can
 * share one file when they merge. */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function median(a) {
  const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2])) : NaN;
}
/** the q-quantile (0..1) of the finite values */
export function quantile(a, q) {
  const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const k = clamp(q, 0, 1) * (s.length - 1), i = Math.floor(k), f = k - i;
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * f : s[i];
}
/** linear interpolation of (t, v) samples onto the grid T; holds the ends */
export function resample(t, v, T) {
  const out = new Float64Array(T.length);
  let j = 0;
  for (let i = 0; i < T.length; i++) {
    const x = T[i];
    while (j < t.length - 2 && t[j + 1] < x) j++;
    if (x <= t[0]) out[i] = v[0];
    else if (x >= t[t.length - 1]) out[i] = v[t.length - 1];
    else { const u = (x - t[j]) / (t[j + 1] - t[j] || 1); out[i] = v[j] + (v[j + 1] - v[j]) * u; }
  }
  return out;
}
/** 2nd-order Butterworth low-pass, run forwards and backwards (no lag; 4th-order response) */
export function filtfilt(x, fc, fs) {
  const n = x.length;
  if (n < 8 || fc >= fs / 2.2) return Float64Array.from(x);
  const K = Math.tan((Math.PI * fc) / fs), Q = Math.SQRT1_2, nrm = 1 / (1 + K / Q + K * K);
  const b0 = K * K * nrm, b1 = 2 * b0, b2 = b0, a1 = 2 * (K * K - 1) * nrm, a2 = (1 - K / Q + K * K) * nrm;
  const pad = Math.min(n - 1, Math.round(fs / fc) * 2);
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) { ext[i] = 2 * x[0] - x[pad - i]; ext[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i]; }
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  const run = (a) => {
    const y = new Float64Array(a.length);
    y[0] = y[1] = a[0];
    for (let i = 2; i < a.length; i++) y[i] = b0 * a[i] + b1 * a[i - 1] + b2 * a[i - 2] - a1 * y[i - 1] - a2 * y[i - 2];
    return y;
  };
  const f = run(ext).reverse(), g = run(f).reverse();
  return g.slice(pad, pad + n);
}
export function deriv(x, fs) {
  const n = x.length, d = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) d[i] = ((x[i + 1] - x[i - 1]) * fs) / 2;
  if (n > 1) { d[0] = (x[1] - x[0]) * fs; d[n - 1] = (x[n - 1] - x[n - 2]) * fs; }
  return d;
}
export function argmax(a, i0, i1) { let b = i0; for (let i = i0; i <= i1; i++) if (a[i] > a[b]) b = i; return b; }
export function argmin(a, i0, i1) { let b = i0; for (let i = i0; i <= i1; i++) if (a[i] < a[b]) b = i; return b; }
export function mean(a, i0 = 0, i1 = a.length - 1) { let s = 0; for (let i = i0; i <= i1; i++) s += a[i]; return s / Math.max(1, i1 - i0 + 1); }
/** angle at b, degrees */
export const angle = (a, b, c) => {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  return (Math.acos(clamp((v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1), -1, 1)) * 180) / Math.PI;
};
/** a value as shown with its sign (a difference); zero has none */
export function fmtSigned(v, d = 0) { const s = v.toFixed(d); return Number(s) === 0 ? (0).toFixed(d) : v > 0 ? `+${s}` : s.replace("-", "−"); }
