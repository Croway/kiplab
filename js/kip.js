/* From the tracked body to the movement: which one it is, its reps, how the energy flows in each, the standards,
 * and checks. Pure: re-runs instantly when a setting changes (movement, height, bodyweight, facing).
 *
 * The physics. Hanging from a bar, only gravity and the bar act on the body, and the hands don't move, so the
 * bar does no work: every joule the body gains comes from its muscles, by changing shape. From the body's centre
 * of mass (segment model, js/body.js), every frame:
 *   force through the bar   F = m(a − g)                         (× bodyweight: no mass needed)
 *   body energy             E = m g h + ½ m v² + the segments' own motion   (J/kg, × bodyweight when given)
 *   muscle power            dE/dt
 *   angular momentum        about the bar: changes only by gravity's torque, unless the grip twists the bar.
 *                           What's left over is reported as tracking consistency.
 * Kip measures: when the hips snap vs when the arms bend; how much of each rep's energy is already there when the
 * arms start to pull (from the kip); the muscles' positive work over the rep against lifting the body that high
 * (work per rep: the cheapest rep is the model for the others); peak force; energy kept from one rep to the next.
 *
 * Coordinates: metres in the body's middle plane, the bar at 0, f forward (the way the athlete faces), u up.
 * The camera's angle to that plane, the scale and the bar's place come from the body (js/body.js); when the phone
 * moves, the bar's place (and the scale) are followed frame by frame. */
import { bodies, SEGMENTS, centreOfMass, facingOf, viewAngle, bodyScale, RIGID, camera, toPlane } from "./body.js";
import { median, quantile, resample, filtfilt, deriv, argmax, argmin, mean, clamp, angle, fmtSigned } from "./signal.js";

export const MOVES = { pullup: "Pull-up", c2b: "Chest-to-bar", t2b: "Toes-to-bar", bmu: "Bar muscle-up", swing: "Kip swing" };
export const STAGES = { swing: { name: "Swing", slot: 1 }, drive: { name: "Drive", slot: 2 }, top: { name: "Top", slot: 3 }, down: { name: "Down", slot: 4 } };
const G = 9.81;
const NAMES = ["sh", "el", "wr", "hip", "kn", "an", "heel", "toe", "ear", "nose", "mouth", "chin", "grip"];
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;

/** on the bar: hands above the shoulders (hanging), or above the hips with the body over them (support) */
const onBarNow = (B) => B.wr.y < B.hip.y;

/* ------------------------------------------------------------------ the analysis */
/**
 * samples: [{ t (video s), pose: 33 landmarks in video px or null }]
 * opts: { W (video width px), slowmo, move ("auto" or a MOVES key), heightCm, kg (bodyweight), facing (0 auto, ±1) }
 */
export function analyse(samples, opts = {}) {
  const slow = opts.slowmo > 0 ? opts.slowmo : 1;
  const heightM = (opts.heightCm > 100 && opts.heightCm < 250 ? opts.heightCm : 175) / 100;
  const posed = samples.filter((s) => s.pose);
  if (posed.length < 20 || posed.length < 0.5 * samples.length) return { error: "The athlete wasn't found on most frames. Film the whole body, in good light, with nobody passing in front." };
  const tv0 = samples[0].t, real = (tv) => (tv - tv0) / slow;
  const dts = [];
  for (let i = 1; i < posed.length; i++) { const d = real(posed[i].t) - real(posed[i - 1].t); if (d > 1e-5) dts.push(d); }
  const fs = clamp(Math.round(1 / median(dts)), 15, 480);
  const Bs = bodies(posed.map((s) => s.pose)), sideOn = Bs.sideOn;
  const fr = posed.map((s, j) => ({ t: real(s.t), P: s.pose, B: Bs[j] }));

  // the part chosen on the timeline is the set: the hands overhead give the bar
  const on = fr, onHang = fr.filter((f) => onBarNow(f.B));
  if (onHang.length < Math.max(5, 0.5 * fr.length)) return { error: "The hands are below the hips on most of this part. Choose the part where the athlete is on the bar." };
  const frames = on.map((f) => f.P);

  // which way, the camera's angle, the scale
  const fc0 = facingOf(on.map((f) => f.B));
  const facing = opts.facing === 1 || opts.facing === -1 ? opts.facing : fc0.facing;
  const view = viewAngle(frames, opts.W || 1000, { heightM, facing, Bs: on.map((f) => f.B) });
  const c = Math.max(0.3, view.c);
  const scale = bodyScale(on.map((f) => f.B), c, heightM);

  // the bar: where the hands close on it. A still phone: one place. A phone that moves (the hands' place drifts on
  // screen, slowly: the hands themselves only turn on the bar): followed frame by frame.
  const gmx = median(onHang.map((f) => f.B.grip.x)), gmy = median(onHang.map((f) => f.B.grip.y));
  const ft = on.map((f) => f.t);
  let wander;
  {
    const Tg = Float64Array.from({ length: Math.max(8, Math.floor((ft[ft.length - 1] - ft[0]) * fs)) }, (_, i) => ft[0] + i / fs);
    const sx = filtfilt(resample(ft, on.map((f) => f.B.grip.x), Tg), Math.min(0.4, fs / 4), fs), sy = filtfilt(resample(ft, on.map((f) => f.B.grip.y), Tg), Math.min(0.4, fs / 4), fs);
    const mx = median(sx), my = median(sy);
    wander = quantile(Array.from(sx, (v, i) => Math.hypot(v - mx, sy[i] - my)), 0.95) / scale.statPx;
  }
  const moving = wander > 0.08;
  const cam = camera(c, view.front, facing);

  // the grid: the span on the bar, in real seconds
  const t0 = on[0].t, t1 = on[on.length - 1].t;
  const n = Math.floor((t1 - t0) * fs) + 1;
  const T = Float64Array.from({ length: n }, (_, i) => t0 + i / fs);
  const fcPos = Math.min(6, fs / 4);
  const img = {};
  for (const k of NAMES) {
    img[k] = { x: filtfilt(resample(ft, on.map((f) => f.B[k].x), T), fcPos, fs), y: filtfilt(resample(ft, on.map((f) => f.B[k].y), T), fcPos, fs) };
  }
  // the bar, the scale per grid point
  const Bx = new Float64Array(n), By = new Float64Array(n), K = new Float64Array(n);
  if (moving) {
    const fcB = Math.min(1.5, fs / 4), bx = filtfilt(resample(ft, on.map((f) => f.B.grip.x), T), fcB, fs), by = filtfilt(resample(ft, on.map((f) => f.B.grip.y), T), fcB, fs);
    // the body's size on screen over a 1.5 s window: the phone may come closer or zoom
    const stat = on.map((f) => { let s = 0; for (const g of RIGID) { const a = f.B[g.from], b = f.B[g.to]; s += Math.hypot((b.x - a.x) / c, b.y - a.y); } return s / RIGID.reduce((q, g) => q + g.len, 0); });
    const half = 0.75;
    const rolled = ft.map((t) => median(stat.filter((_, j) => Math.abs(ft[j] - t) <= half)));
    const k = filtfilt(resample(ft, rolled, T), Math.min(0.5, fs / 4), fs);
    for (let i = 0; i < n; i++) { Bx[i] = bx[i]; By[i] = by[i]; K[i] = k[i] / heightM; }
  } else {
    Bx.fill(gmx); By.fill(gmy); K.fill(scale.pxPerM);
  }
  // into the plane: metres, bar at 0, f forward, u up
  const pl = {};
  for (const k of NAMES) {
    const f = new Float64Array(n), u = new Float64Array(n);
    for (let i = 0; i < n; i++) { const q = toPlane(img[k].x[i], img[k].y[i], cam, Bx[i], By[i], K[i]); f[i] = q[0]; u[i] = q[1]; }
    pl[k] = { f, u };
  }
  const at = (k, i) => ({ x: pl[k].f[i], y: pl[k].u[i] });

  // centre of mass, segments
  const comF = new Float64Array(n), comU = new Float64Array(n), comX = new Float64Array(n), comY = new Float64Array(n);
  const segF = SEGMENTS.map(() => new Float64Array(n)), segU = SEGMENTS.map(() => new Float64Array(n)), segA = SEGMENTS.map(() => new Float64Array(n)), segL = SEGMENTS.map(() => 0);
  for (let i = 0; i < n; i++) {
    const Bp = {}, Bi = {};
    for (const k of NAMES) { Bp[k] = at(k, i); Bi[k] = { x: img[k].x[i], y: img[k].y[i] }; }
    const cm = centreOfMass(Bp), ci = centreOfMass(Bi);
    comF[i] = cm.x; comU[i] = cm.y; comX[i] = ci.x; comY[i] = ci.y;
    SEGMENTS.forEach((s, j) => {
      const a = Bp[s.from], b = Bp[s.to];
      segF[j][i] = a.x + s.c * (b.x - a.x); segU[j][i] = a.y + s.c * (b.y - a.y);
      segA[j][i] = Math.atan2(b.x - a.x, -(b.y - a.y));
      segL[j] += Math.hypot(b.x - a.x, b.y - a.y) / n;
    });
  }
  for (const a of segA) for (let i = 1; i < n; i++) { while (a[i] - a[i - 1] > Math.PI) a[i] -= 2 * Math.PI; while (a[i] - a[i - 1] < -Math.PI) a[i] += 2 * Math.PI; }
  const vf = deriv(comF, fs), vu = deriv(comU, fs);
  const fcA = Math.min(5, fs / 4), af = filtfilt(deriv(vf, fs), fcA, fs), au = filtfilt(deriv(vu, fs), fcA, fs);

  // energy (per kg), force (× bodyweight), angular momentum about the bar (per kg)
  const E = new Float64Array(n), PE = new Float64Array(n), KE = new Float64Array(n), Fb = new Float64Array(n), Ff = new Float64Array(n), Fu = new Float64Array(n), Hb = new Float64Array(n), speed = new Float64Array(n);
  const sv = SEGMENTS.map((_, j) => [deriv(segF[j], fs), deriv(segU[j], fs), deriv(segA[j], fs)]);
  for (let i = 0; i < n; i++) {
    let ke = 0, h = 0;
    SEGMENTS.forEach((s, j) => {
      const [vx, vy, w] = [sv[j][0][i], sv[j][1][i], sv[j][2][i]];
      const I = s.k > 0 ? (s.k * segL[j]) ** 2 : 0;
      ke += s.m * (0.5 * (vx * vx + vy * vy) + 0.5 * I * w * w);
      h += s.m * (segF[j][i] * vy - segU[j][i] * vx + I * w);
    });
    PE[i] = G * comU[i]; KE[i] = ke; E[i] = PE[i] + ke; Hb[i] = h;
    Ff[i] = af[i] / G; Fu[i] = (au[i] + G) / G; Fb[i] = Math.hypot(Ff[i], Fu[i]);
    speed[i] = Math.hypot(vf[i], vu[i]);
  }
  const P = filtfilt(deriv(E, fs), fcA, fs);
  // what's left of dH/dt once gravity's torque is taken out: the grip's twist, plus tracking error
  // compared below 2 Hz, where tracking noise (differentiated twice) doesn't swamp it; the same filter both sides
  const fcH = Math.min(2, fs / 4), dH = filtfilt(deriv(Hb, fs), fcH, fs), tg = filtfilt(Float64Array.from(comF, (f) => -G * f), fcH, fs), resid = new Float64Array(n);
  for (let i = 0; i < n; i++) resid[i] = dH[i] - tg[i];
  const rms = (a) => Math.sqrt(mean(Array.from(a, (v) => v * v)));
  const consistency = 1 - clamp(rms(resid) / Math.max(G * 0.03, rms(tg)), 0, 1);

  // joint angles in the plane: elbow (interior), shoulder and hip as + hollow / − arch, knee bend
  const elbow = new Float64Array(n), shoulder = new Float64Array(n), hipA = new Float64Array(n), knee = new Float64Array(n);
  const signed = (d1, d2) => deg(Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y));
  for (let i = 0; i < n; i++) {
    const sh = at("sh", i), el = at("el", i), wr = at("wr", i), hp = at("hip", i), kn = at("kn", i), an = at("an", i);
    elbow[i] = angle(sh, el, wr);
    shoulder[i] = -signed({ x: sh.x - hp.x, y: sh.y - hp.y }, { x: el.x - sh.x, y: el.y - sh.y });
    hipA[i] = signed({ x: hp.x - sh.x, y: hp.y - sh.y }, { x: kn.x - hp.x, y: kn.y - hp.y });
    knee[i] = 180 - angle(hp, kn, an);
  }
  for (const a of [shoulder, hipA]) for (let i = 1; i < n; i++) { while (a[i] - a[i - 1] > 180) a[i] -= 360; while (a[i] - a[i - 1] < -180) a[i] += 360; }
  const dHip = deriv(filtfilt(hipA, Math.min(4, fs / 4), fs), fs);

  // rest: a still hang, straight arms, or the lowest the centre of mass sits with straight arms
  const straight = (i) => elbow[i] > 150;
  let uRest = null;
  {
    const run = Math.round(0.4 * fs);
    for (let i = 0, k = 0; i < n; i++) { if (speed[i] < 0.12 && straight(i)) { if (++k >= run) { uRest = median(comU.slice(i - run + 1, i + 1)); break; } } else k = 0; }
    if (uRest === null) uRest = quantile(Array.from(comU).filter((_, i) => straight(i)), 0.05);
    if (!Number.isFinite(uRest)) uRest = quantile(comU, 0.02);
  }
  const Erest = G * uRest;
  const Er = Float64Array.from(E, (v) => v - Erest), PEr = Float64Array.from(PE, (v) => v - Erest);

  // reps
  const R = { fs, n, T, t0, tv0, slow, facing, facingFrom: opts.facing ? "you" : fc0.sure ? "body" : "guess", view, c, scale, moving, wander, heightM, kg: opts.kg > 0 ? opts.kg : null,
    pl, img, Bx, By, K, comF, comU, comX, comY, vf, vu, speed, Ff, Fu, Fb, E, Er, PE, PEr, KE, P, Hb, resid, tg, consistency,
    elbow, shoulder, hip: hipA, knee, uRest, span: [0, n - 1], onBar: [t0, t1], frames: on.length,
    poseCover: on.length / Math.max(1, (t1 - t0) * fs + 1) };
  R.tVideo = (i) => tv0 + T[clamp(i, 0, n - 1)] * slow;
  R.indexAt = (tv) => clamp(Math.round((real(tv) - t0) * fs), 0, n - 1);
  findReps(R, opts, dHip);
  report(R, opts);
  return R;
}

/* ------------------------------------------------------------------ reps and what each one did */
/** local maxima of a (indices) that rise `prom` above the lowest point on both sides before a higher one, ≥ gap apart */
function peaks(a, prom, gap) {
  const n = a.length, out = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(a[i] >= a[i - 1] && a[i] > a[i + 1])) continue;
    let l = a[i], r = a[i];
    for (let j = i - 1; j >= 0 && a[j] <= a[i]; j--) l = Math.min(l, a[j]);
    for (let j = i + 1; j < n && a[j] <= a[i]; j++) r = Math.min(r, a[j]);
    if (a[i] - Math.max(l, r) < prom) continue;
    if (out.length && i - out[out.length - 1] < gap) { if (a[i] > a[out[out.length - 1]]) out[out.length - 1] = i; continue; }
    out.push(i);
  }
  return out;
}

function findReps(R, opts, dHip) {
  const { n, fs, pl, elbow, hip, comU, comF, Fb, Er, PEr, P } = R;
  const H = R.heightM;
  const uSh = pl.sh.u, uToe = pl.toe.u;
  /* reach: the shoulders' distance from the bar. About an arm's length hanging, whether still or swinging; it
   * shrinks only when the arms pull. Side-on, an overhand pull bends the elbows out sideways, towards the camera,
   * where the elbow angle can't be seen, but the reach still shows the pull. */
  const reach = Float64Array.from(uSh, (u, i) => Math.hypot(pl.sh.f[i], u));
  const arm = quantile(reach, 0.95), dReach = deriv(reach, fs);
  R.reach = reach; R.arm = arm;
  const hangSh = quantile(Array.from(uSh).filter((_, i) => reach[i] > 0.9 * arm), 0.5);
  const hangToe = quantile(Array.from(uToe).filter((_, i) => reach[i] > 0.9 * arm && Math.abs(hip[i]) < 30), 0.5);
  const gap = Math.round(0.6 * fs);
  const lowBefore = (i) => { let j = i; while (j > 0 && uSh[j - 1] <= uSh[j] + 1e-9) j--; return j; };
  const minReach = (a, b) => { let m = Infinity; for (let j = Math.max(0, a); j <= Math.min(n - 1, b); j++) m = Math.min(m, reach[j]); return m; };
  const pulls = peaks(uSh, 0.12 * H, gap).filter((i) => uSh[i] - (Number.isFinite(hangSh) ? hangSh : uSh[i]) > 0.14 * H && minReach(lowBefore(i), i) < 0.78 * arm);
  const toeDist = (i) => Math.hypot(pl.toe.f[i], pl.toe.u[i]);
  const kicks = peaks(uToe, 0.4 * H, gap).filter((i) => hip[i] > 70 && uToe[i] - (Number.isFinite(hangToe) ? hangToe : -H) > 0.45 * H && toeDist(i) < 0.5);
  // the swing: the centre of mass's angle from below the bar
  const swingDeg = Float64Array.from(comF, (f, i) => deg(Math.atan2(f, -comU[i])));
  R.swingDeg = swingDeg;

  // the family: feet to the bar, or the body up to it, or neither (swings)
  const fam = kicks.length > pulls.length ? "feet" : pulls.length ? "pull" : "swing";
  const tops = fam === "feet" ? kicks : fam === "pull" ? pulls : [];
  const reps = [];
  for (let k = 0; k < tops.length; k++) {
    const top = tops[k];
    const prev = k ? tops[k - 1] : 0, next = k + 1 < tops.length ? tops[k + 1] : n - 1;
    const sig = fam === "feet" ? uToe : uSh;
    const bottom = argmin(sig, prev, top); // the lowest point before it
    const begin = k ? bottom : Math.max(0, Math.min(bottom, top - Math.round(1.5 * fs)));
    const end = k + 1 < tops.length ? argmin(sig, top, next) : Math.min(n - 1, top + Math.round(1.2 * fs));
    const w0 = Math.max(begin, top - Math.round(1.2 * fs));
    // the arms start to pull: going back from the fastest shortening of the reach (before the shortest reach: a
    // muscle-up straightens the arms again at the top), the moment it was still under a fifth of that speed
    const iBent = argmin(reach, w0, top);
    let iFast = w0;
    for (let i = w0; i <= iBent; i++) if (dReach[i] < dReach[iFast]) iFast = i;
    let onset = iFast;
    while (onset > w0 && dReach[onset] < 0.2 * dReach[iFast]) onset--;
    // the hip snap: the fastest the hip angle changes in the 0.6 s before the arms take over
    let snap = Math.max(w0, onset - Math.round(0.6 * fs));
    for (let i = snap; i <= Math.min(top, onset + Math.round(0.15 * fs)); i++) if (Math.abs(dHip[i]) > Math.abs(dHip[snap])) snap = i;
    const cTop = argmax(comU, Math.max(begin, top - Math.round(0.4 * fs)), Math.min(end, top + Math.round(0.4 * fs)));
    const eTop = Er[cTop];
    // the muscles' positive work over the rep's cycle (from the last top, or the start), against lifting the body that high
    const c0 = k ? reps[k - 1].cTop : 0;
    let wPos = 0;
    for (let i = c0; i <= cTop; i++) if (P[i] > 0) wPos += P[i] / fs;
    const iF = argmax(Fb, w0, top);
    const pPeak = argmax(P, w0, top);
    const kept = k + 1 < tops.length ? Math.max(0, Er[argmin(Er, cTop, tops[k + 1])]) / Math.max(1e-6, eTop) : null;
    reps.push({
      n: k + 1, begin, bottom, top, end, cTop, onset, snap,
      hipsFirst: (onset - snap) / fs, snapDir: Math.sign(dHip[snap]) || 1,
      fromKip: eTop > 0.3 ? clamp(Er[onset] / eTop, 0, 1) : null,
      work: wPos, workRatio: PEr[cTop] > 0.3 ? wPos / PEr[cTop] : null,
      rise: comU[cTop] - R.uRest, eTop,
      peakForce: Fb[iF], iF, peakPower: P[pPeak], meanPower: mean(P, bottom, top),
      kept, cycle: k ? (top - tops[k - 1]) / fs : null,
      kipping: rangeOf(hip, w0, top) > 30, // the kip is a hip action: a strict rep moves the body sideways too (the head has to clear the bar)
      hang: reach[argmax(reach, k ? tops[k - 1] : 0, Math.max(k ? tops[k - 1] : 0, onset))] / arm, // 1 = arms fully long
    });
  }
  R.fam = fam; R.reps = reps; R.tops = tops; R.hangSh = hangSh; R.hangToe = hangToe;
  const repOf = new Int16Array(n);
  for (const r of reps) for (let i = r.begin; i <= r.end; i++) if (!repOf[i]) repOf[i] = r.n;
  R.repOf = repOf;
}
const rangeOf = (a, i0, i1) => { let lo = Infinity, hi = -Infinity; for (let i = i0; i <= i1; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return hi - lo; };

/* ------------------------------------------------------------------ standards, recognition, checks, numbers */
const CHEST_FWD = 0.06, CHEST_DOWN = 0.04; // × stature: the front of the chest below the collarbone, from the shoulder points

function standardsOf(R, r) {
  const { pl, elbow, heightM: H } = R;
  const i = r.top;
  const chinU = Math.max(...range(r.top - 3, r.top + 3, R.n).map((j) => pl.chin.u[j]));
  // closest the chest comes to the bar around the top
  let chest = Infinity;
  for (const j of range(r.top - Math.round(0.3 * R.fs), r.top + Math.round(0.3 * R.fs), R.n)) {
    const sh = { f: pl.sh.f[j], u: pl.sh.u[j] }, hp = { f: pl.hip.f[j], u: pl.hip.u[j] };
    const L = Math.hypot(hp.f - sh.f, hp.u - sh.u) || 1, down = { f: (hp.f - sh.f) / L, u: (hp.u - sh.u) / L }, fwd = { f: -down.u, u: down.f };
    const sgn = fwd.f >= 0 ? 1 : -1; // the forward normal points the way the athlete faces
    const p = { f: sh.f + CHEST_DOWN * H * down.f + sgn * CHEST_FWD * H * fwd.f, u: sh.u + CHEST_DOWN * H * down.u + sgn * CHEST_FWD * H * fwd.u };
    chest = Math.min(chest, Math.hypot(p.f, p.u));
  }
  let feet = Infinity;
  for (const j of range(r.top - 3, r.top + 3, R.n)) feet = Math.min(feet, Math.hypot(pl.toe.f[j], pl.toe.u[j]));
  const shTop = pl.sh.u[i];
  // a muscle-up's lockout: the highest the shoulders get above the bar, arms straight there
  const lock = shTop > 0.08 * H ? R.reach[argmax(pl.sh.u, Math.max(0, i - 5), Math.min(R.n - 1, i + 5))] / R.arm : null; // arms' length in support, × hanging
  let heelsBack = null;
  if (R.fam === "feet") { heelsBack = Infinity; for (let j = Math.max(0, r.begin - Math.round(0.5 * R.fs)); j <= r.top; j++) heelsBack = Math.min(heelsBack, pl.heel.f[j]); }
  return { chinU, chest, feet, shTop, lock, heelsBack };
}
const range = (a, b, n) => { const o = []; for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) o.push(i); return o; };

/** a rep's movement from where it got to */
function kindOf(R, s) {
  const H = R.heightM;
  if (R.fam === "feet") return "t2b";
  if (s.shTop > 0.12 * H) return "bmu";
  if (s.chest < 0.1) return "c2b";
  return "pullup";
}
/** pass / no / unsure, with the standard's words */
function judge(kind, s, r) {
  const v = (ok, near, txt) => ({ result: ok ? "pass" : near ? "unsure" : "no", text: txt });
  const out = [];
  if (kind !== "t2b" && kind !== "swing") out.push({ id: "hang", ...v(r.hang >= 0.93, r.hang >= 0.88, `arms ${r.hang >= 0.93 ? "long" : "short"} before it (${Math.round(100 * r.hang)}% of the full hang)`) });
  if (kind === "pullup") out.push({ id: "chin", ...v(s.chinU > 0.03, s.chinU > -0.06, `chin ${fmtSigned(s.chinU * 100)} cm vs the bar`) });
  if (kind === "c2b") out.push({ id: "chest", ...v(s.chest <= 0.05, s.chest <= 0.09, `chest ${Math.round(s.chest * 100)} cm from the bar at its closest`) });
  if (kind === "t2b") {
    out.push({ id: "feet", ...v(s.feet <= 0.12, s.feet <= 0.22, `toes ${Math.round(s.feet * 100)} cm from the bar at their closest`) });
    out.push({ id: "heels", ...v(s.heelsBack < -0.03, s.heelsBack < 0.03, `heels ${s.heelsBack < 0 ? "behind" : "in front of"} the bar before it`) });
  }
  if (kind === "bmu") out.push({ id: "lock", ...v(s.lock >= 0.88, s.lock >= 0.82, `arms ${s.lock >= 0.88 ? "locked out" : "bent"} above the bar (${Math.round(100 * s.lock)}% of their length)`) });
  return out;
}

function report(R, opts) {
  const { reps, fs } = R;
  const H = R.heightM;
  const kgW = R.kg; // bodyweight: watts and joules; otherwise per kg
  const fmtE = (j) => (kgW ? `${Math.round(j * kgW)} J` : `${j.toFixed(1)} J/kg`);
  const fmtP = (w) => (kgW ? `${Math.round(w * kgW)} W` : `${w.toFixed(1)} W/kg`);
  for (const r of reps) { r.std = standardsOf(R, r); r.kind = kindOf(R, r.std); }
  const counts = {};
  for (const r of reps) counts[r.kind] = (counts[r.kind] || 0) + 1;
  let move = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "swing";
  R.moveFrom = "body";
  if (opts.move && MOVES[opts.move]) { move = opts.move; R.moveFrom = "you"; }
  R.move = move;
  for (const r of reps) { r.checks = judge(move, r.std, r); r.valid = r.checks.every((c) => c.result === "pass") ? "pass" : r.checks.some((c) => c.result === "no") ? "no" : "unsure"; }
  const kipping = reps.length ? reps.filter((r) => r.kipping).length >= reps.length / 2 : true;
  R.kipping = kipping;

  const metrics = [], put = (group, label, value, unit, note) => metrics.push({ group, label, value, unit, note });
  const tiles = [], checks = [], notes = [], film = [];
  const valid = reps.filter((r) => r.valid === "pass").length, unsure = reps.filter((r) => r.valid === "unsure").length;
  const pct = (x) => `${Math.round(100 * x)}%`;

  // the swing alone
  const sw = R.swingDeg, ext = peaks(Float64Array.from(sw, Math.abs), 4, Math.round(0.4 * fs));
  R.swingExt = ext;
  const amp = ext.length ? Math.max(...ext.map((i) => Math.abs(sw[i]))) : rangeOf(sw, 0, R.n - 1) / 2;

  if (move === "swing" || !reps.length) {
    const ePer = [];
    for (let k = 1; k < ext.length; k++) ePer.push(R.Er[ext[k]] - R.Er[ext[k - 1]]);
    const hs = quantile(R.hip, 0.97) - quantile(R.hip, 0.03), shs = quantile(R.shoulder, 0.97) - quantile(R.shoulder, 0.03);
    tiles.push({ label: "Swings", value: String(Math.floor(ext.length / 2)), unit: "", note: "front and back = one" });
    tiles.push({ label: "Swing size", value: amp.toFixed(0), unit: "°", note: "centre of mass, from below the bar" });
    tiles.push({ label: "Hip range", value: hs.toFixed(0), unit: "°", note: "hollow to arch" });
    tiles.push({ label: "Shoulder range", value: shs.toFixed(0), unit: "°", note: "hollow to arch" });
    put("Swing", "Largest swing", amp, "°", "the centre of mass's angle from straight below the bar");
    put("Swing", "Height gained at the ends", Math.max(0, quantile(R.comU, 0.98) - R.uRest) * 100, "cm", "centre of mass, above the still hang");
    if (ePer.length) put("Swing", "Energy added per half swing", median(ePer) * (kgW || 1), kgW ? "J" : "J/kg", "median");
    put("Body shape", "Hip: most hollow", quantile(R.hip, 0.98), "°", "+ flexed (hollow), − extended (arch)");
    put("Body shape", "Hip: most arched", quantile(R.hip, 0.02), "°");
    put("Body shape", "Shoulders: most hollow", quantile(R.shoulder, 0.98), "°", "+ arms ahead of the body line");
    put("Body shape", "Shoulders: most arched", quantile(R.shoulder, 0.02), "°");
    if (hs < 25) checks.push({ status: "warning", basis: "Coaching", title: "Small hollow and arch", text: `The hips moved ${Math.round(hs)}° between hollow and arch. A kip comes from a big, active hollow–arch: press the bar down in the hollow, chest through in the arch.` });
    else checks.push({ status: "good", basis: "Coaching", title: "Hollow and arch", text: `${Math.round(hs)}° at the hips, ${Math.round(shs)}° at the shoulders between hollow and arch.` });
    if (ePer.length >= 2) {
      const gain = median(ePer);
      checks.push(gain > 0.05
        ? { status: "good", basis: "Physics", title: "Each swing adds energy", text: `About ${fmtE(gain)} per half swing: the shape changes are timed with the swing.` }
        : { status: "warning", basis: "Physics", title: "The swing isn't growing", text: "Energy stays flat from one swing to the next. Snap into the hollow as you pass under the bar, and open into the arch at the back: that's when it pumps." });
    }
  } else {
    const rel = move === "t2b" ? "toes" : move === "bmu" ? "shoulders" : move === "c2b" ? "chest" : "chin";
    const hf = reps.map((r) => r.hipsFirst), pf = reps.map((r) => r.peakForce);
    const fk = reps.map((r) => r.fromKip).filter((v) => v !== null), wr = reps.map((r) => r.workRatio).filter((v) => v !== null);
    const kept = reps.map((r) => r.kept).filter((v) => v !== null);
    // the best rep: the most height for the least muscle work (the cheapest valid rep)
    const ranked = reps.filter((r) => r.workRatio !== null && r.valid !== "no");
    const best = ranked.length ? ranked.reduce((a, b) => (b.workRatio < a.workRatio ? b : a)) : null;
    R.best = best?.n ?? null;
    tiles.push({ label: "Reps", value: `${valid}`, unit: `/ ${reps.length}`, note: unsure ? `${unsure} too close to call` : "meet the standard" });
    if (kipping && fk.length) tiles.push({ label: "From the kip", value: String(Math.round(100 * median(fk))), unit: "%", note: "of each rep's energy, before the arms pull" });
    if (kipping && move !== "t2b") tiles.push({ label: "Hips before arms", value: (median(hf) * 1000).toFixed(0), unit: "ms", note: median(hf) >= 0 ? "hip snap, then the pull" : "arms bend first" });
    tiles.push({ label: "Peak bar force", value: Math.max(...pf).toFixed(1), unit: "× bw", note: `median rep ${median(pf).toFixed(1)}×` });
    if (!kipping || move === "t2b") tiles.push({ label: "Work per rep", value: wr.length ? String(Math.round(100 * median(wr))) : "–", unit: "%", note: "of lifting the body that high" });

    put("Set", "Reps", reps.length, "", `${valid} meet the standard${unsure ? `, ${unsure} too close to call` : ""}`);
    if (reps.length > 1) put("Set", "Time per rep", median(reps.slice(1).map((r) => r.cycle)), "s", "median, top to top");
    put("Set", "Style", kipping ? 1 : 0, "", kipping ? "kipping" : "strict");
    put("Energy", "Centre of mass rise", median(reps.map((r) => r.rise)) * 100, "cm", "median, above the still hang");
    put("Energy", "Energy at the top", median(reps.map((r) => r.eTop)) * (kgW || 1), kgW ? "J" : "J/kg", "median, above the still hang");
    if (fk.length) put("Energy", "From the kip", median(fk) * 100, "%", "median: the share of the rep's energy already there when the elbows start to bend");
    if (wr.length) put("Energy", "Work per rep", median(wr) * 100, "%", "median: the muscles' positive work over the rep, against lifting the body that high (under 100%: the swing paid for some)");
    if (kept.length) put("Energy", "Energy kept between reps", median(kept) * 100, "%", "median: carried from one rep's top into the next");
    put("Force", "Peak bar force", Math.max(...pf), "× bw", "approx. (smoothing softens short spikes)");
    put("Force", "Peak bar force, median rep", median(pf), "× bw");
    put("Power", "Peak muscle power", Math.max(...reps.map((r) => r.peakPower)) * (kgW || 1), kgW ? "W" : "W/kg", kgW ? `${kgW} kg` : "enter bodyweight for watts");
    put("Power", "Mean power, drive", median(reps.map((r) => r.meanPower)) * (kgW || 1), kgW ? "W" : "W/kg", "median rep, bottom to top");
    if (kipping) {
      put("Timing", "Hips before arms", median(hf) * 1000, "ms", "+ the hip snap peaks before the elbows bend");
      const closing = reps.filter((r) => r.snapDir > 0).length >= reps.length / 2;
      put("Timing", "Hip snap", closing ? 1 : -1, "", closing ? "closing (to the hollow)" : "opening (hips up)");
    }
    put("Standard", "Reps meeting it", valid, "", `${MOVES[move]}: ${rel}`);

    // checks: standards first, then physics, then coaching; each against your own best rep where it can
    const bad = reps.filter((r) => r.valid === "no"), close = reps.filter((r) => r.valid === "unsure");
    if (bad.length) checks.push({ status: "serious", basis: "Standard", title: `${bad.length} likely no-rep${bad.length > 1 ? "s" : ""}`, text: bad.map((r) => `rep ${r.n}: ${r.checks.filter((c) => c.result === "no").map((c) => c.text).join(", ")}`).join("; ") + "." });
    if (close.length) checks.push({ status: "warning", basis: "Standard", title: `${close.length} too close to call`, text: close.map((r) => `rep ${r.n}: ${r.checks.filter((c) => c.result !== "pass").map((c) => c.text).join(", ")}`).join("; ") + ". From one video the body points are good to a few cm." });
    if (!bad.length && !close.length) checks.push({ status: "good", basis: "Standard", title: `Every rep meets the ${MOVES[move].toLowerCase()} standard`, text: `${reps[0].checks.map((c) => c.text).join(", ")}${reps.length > 1 ? " (rep 1), and the rest alike" : ""}.` });
    if (kipping && fk.length) {
      const m = median(fk);
      checks.push(m >= 0.2
        ? { status: "good", basis: "Physics", title: "The kip carries the rep", text: `${pct(m)} of each rep's energy is already there when the arms start to pull: the swing brought it, the arms finish.` }
        : { status: "warning", basis: "Physics", title: "The arms do most of the work", text: `Only ${pct(m)} of each rep's energy comes from the kip; the arms supply the rest. A bigger hollow–arch, with the hip snap as you pass under the bar, hands more of it to the swing.` });
    }
    if (kipping && move !== "t2b") {
      // timing to a frame or two: at 30 fps a frame is 33 ms, so only clear leads count. A muscle-up's pull rides
      // the hip pop by design: judged more gently.
      const m = median(hf), lim = move === "bmu" ? -0.15 : -0.1, early = reps.filter((r) => r.hipsFirst < lim);
      const frame = `${Math.round(1000 / (R.fs * R.slow))} ms a frame`;
      if (m < lim) checks.push({ status: move === "bmu" ? "warning" : "serious", basis: "Coaching", title: "Pulling before the hips", text: `The elbows start ${Math.round(-m * 1000)} ms before the hip snap peaks (median; ${frame}). Let the hips drive first, then pull: the big muscles start the rep.` });
      else if (early.length) checks.push({ status: "warning", basis: "Coaching", title: "Some reps pull early", text: `Rep${early.length > 1 ? "s" : ""} ${early.map((r) => r.n).join(", ")}: the arms start before the hips (${frame}).` });
      else if (m < 0.03) checks.push({ status: "good", basis: "Coaching", title: "Hips and arms together", text: `The pull starts with the hip snap (${fmtSigned(m * 1000)} ms median; ${frame}). Letting the hips lead a little more puts the big muscles first.` });
      else checks.push({ status: "good", basis: "Coaching", title: "Hips before arms", text: `The hip snap leads the pull by ${Math.round(m * 1000)} ms (median; ${frame}).` });
    }
    if (best && ranked.length >= 3) {
      // what the best rep did differently: timing and kip share, against the others
      const others = ranked.filter((r) => r !== best), dt = median(others.map((r) => r.hipsFirst)), fo = median(others.map((r) => r.fromKip ?? 0));
      const bits = [];
      if (kipping && Math.abs(best.hipsFirst - dt) >= 0.05) bits.push(`its pull started ${Math.round(Math.abs(best.hipsFirst - dt) * 1000)} ms ${best.hipsFirst > dt ? "later" : "earlier"} after the hip snap`);
      if (kipping && best.fromKip !== null && Math.abs(best.fromKip - fo) >= 0.08) bits.push(`${pct(best.fromKip)} came from the kip (others ${pct(fo)})`);
      checks.push({ status: "good", basis: "Physics", title: `Rep ${best.n} cost the least`, text: `It took ${pct(best.workRatio)} of the work of lifting the body that high (median rep ${pct(median(wr))})${bits.length ? `: ${bits.join("; ")}` : ""}. Use it as the model for the others.` });
    }
    if (kept.length >= 2) {
      const first = kept[0], last = kept[kept.length - 1];
      if (last < first - 0.2) checks.push({ status: "warning", basis: "Physics", title: "Losing the rhythm", text: `Energy carried into the next rep fell from ${pct(first)} to ${pct(last)}: later reps restart the swing instead of riding it.` });
    }
    const hard = reps.filter((r) => r.peakForce > 2.6);
    if (hard.length) checks.push({ status: "warning", basis: "Physics", title: "Sharp pulls", text: `Rep${hard.length > 1 ? "s" : ""} ${hard.map((r) => r.n).join(", ")} peaked above 2.6× bodyweight through the bar. A smoother kip reaches the same height with less: easier on the shoulders.` });
  }

  // filming: how far the numbers can be trusted
  const a = R.view.alpha;
  film.push(a <= 50
    ? { status: "good", title: `Camera angle about ${Math.round(a)}°`, text: `${a < 15 ? "Side-on" : "Turned from side-on"} (${Math.round(R.view.band[0])}–${Math.round(R.view.band[1])}°)${R.view.from === "swing" ? ", measured from the body's swing" : R.view.from === "depth" ? ", from the tracker's depth (the body didn't turn enough to measure it)" : ", assumed"}. Forward–back distances are corrected for it.` }
    : a <= 62
      ? { status: "warning", title: `Camera angle ${Math.round(a)}°`, text: "Far from side-on: forward–back numbers (swing, hollow/arch) are rough. Heights, timing and the standards hold." }
      : { status: "serious", title: `Camera angle ${Math.round(a)}°: nearly front-on`, text: "Forward–back numbers aren't reliable from here; heights, timing and reps are. Film more from the side." });
  film.push(R.moving
    ? { status: "warning", title: "The phone moved", text: "The bar and the scale were followed frame by frame. Lean the phone on something: the numbers get steadier." }
    : { status: "good", title: "Phone still", text: "The bar stayed put on screen." });
  const fps = Math.round(fs * R.slow);
  film.push(fps >= 50 ? { status: "good", title: `${fps} fps`, text: "Enough frames for the fast hip snap." } : { status: "warning", title: `${fps} fps`, text: "60 fps catches the hip snap and the peak force better (Record films at 60)." });
  const cons = R.consistency;
  // the gravity check: validated on simulated swings (63–93% with tracking noise); on handheld 30 fps clips it reads
  // 10–50% even when the rest holds, so it's a measurement, and a warning only when it's clearly broken
  if (cons < 0.1) film.push({ status: "warning", title: "Physics doesn't add up", text: "The swing isn't explained by gravity at all: the tracking slipped, or the phone moved a lot. Force and timing are rough." });
  if (!opts.heightCm) notes.push("Height not entered: 175 cm assumed. Enter yours for metres and energy (it sets the scale).");
  if (!kgW) notes.push("Enter bodyweight to see joules and watts (the rest doesn't need it).");
  put("Filming", "Camera angle from side-on", a, "°", R.view.from === "swing" ? "from the body's swing" : R.view.from === "depth" ? "from the tracker's depth" : "assumed");
  put("Filming", "Physics consistency", cons * 100, "%", "how much of the swing gravity alone explains (a grip that twists the bar, tracking error and a moving phone lower it)");
  put("Filming", "Frame rate", fps, "fps");
  put("Filming", "Analysed", R.onBar[1] - R.onBar[0], "s", "the part analysed");

  const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  R.title = move === "swing" || !reps.length ? `Kip swing · ${plural(Math.floor(ext.length / 2), "swing")}` : `${MOVES[move]}${kipping && move !== "bmu" && move !== "t2b" ? " (kipping)" : !kipping && move !== "t2b" ? " (strict)" : ""} · ${plural(reps.length, "rep")}`;
  R.tiles = tiles; R.checks = checks; R.film = film; R.notes = notes; R.metrics = metrics;
  // stages for the timing bar: per rep, drive (bottom → top) and down (top → next bottom)
  const stages = [];
  for (const r of reps) {
    if (r.top > r.bottom) stages.push({ id: "drive", rep: r.n, name: "Drive", slot: 2, i0: r.bottom, i1: r.top, dur: (r.top - r.bottom) / fs });
    if (r.end > r.top) stages.push({ id: "down", rep: r.n, name: "Down", slot: 4, i0: r.top, i1: r.end, dur: (r.end - r.top) / fs });
  }
  R.stages = stages;
}

/** a measurement as shown */
export function fmtMetric(m) {
  if (m.label === "Style" || m.label === "Hip snap") return m.note;
  const d = ["°", "%", "", "W", "J", "ms", "fps", "cm"].includes(m.unit) ? 0 : m.unit === "× bw" ? 2 : 1;
  return m.value.toFixed(d);
}
