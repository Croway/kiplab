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
import { tr, num } from "./i18n.js";

/** the movements: key → name, in the current language (read when shown: the language is set after import) */
export const MOVES = {
  get pullup() { return tr("move.pullup"); },
  get c2b() { return tr("move.c2b"); },
  get t2b() { return tr("move.t2b"); },
  get bmu() { return tr("move.bmu"); },
  get swing() { return tr("move.swing"); },
};
export const STAGES = {
  swing: { get name() { return tr("stage.swing"); }, slot: 1 },
  drive: { get name() { return tr("stage.drive"); }, slot: 2 },
  top: { get name() { return tr("stage.top"); }, slot: 3 },
  down: { get name() { return tr("stage.down"); }, slot: 4 },
};
const G = 9.81;
const NAMES = ["sh", "el", "wr", "hip", "kn", "an", "heel", "toe", "ear", "nose", "mouth", "chin", "grip"];
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;

/** on the bar: hands above the shoulders (hanging), or above the hips with the body over them (support) */
const onBarNow = (B) => B.wr.y < B.hip.y;

// Follow the grip from an overhead hang. A moving camera changes the bar's image
// position gradually. A hand jumping away from that position cannot move the bar.
function contactSpans(frames) {
  const spans = [];
  let span, candidate, anchor, last, atBarHeight;
  for (const f of frames) {
    const { sh, hip, grip } = f.B;
    const torso = Math.hypot(hip.x - sh.x, hip.y - sh.y);
    const near = (a, radius) => Math.hypot(grip.x - a.x, grip.y - a.y) <= radius * torso;
    const overhead = sh.y - grip.y > 0.65 * torso;
    // As the arms bend, keep the last overhead grip as an independent reference.
    // The shoulders must actually reach that bar before a support can move the
    // anchor again. Slowly lowering the hands while standing cannot drag it down.
    if (span && f.t - last <= 0.70 && near(anchor, overhead || atBarHeight ? 0.70 : 0.45)) {
      if (overhead) atBarHeight = false;
      else if (sh.y < anchor.y + 0.15 * torso) atBarHeight = true;
      const w = 1 - Math.exp(-(f.t - last) / 0.18);
      // A horizontal pan can continue through a bent-arm hold. Keep the
      // independent bar height to distinguish a slow dismount.
      anchor.x += w * (grip.x - anchor.x);
      if (overhead || atBarHeight) anchor.y += w * (grip.y - anchor.y);
      span.grips.push(f);
      last = span.end = f.t;
      continue;
    }
    if (span && f.t - last <= 0.70) continue; // allow a few noisy hand observations
    span = null;
    if (torso <= 0 || sh.y - grip.y < 0.40 * torso) { candidate = null; continue; }
    if (!candidate || f.t - candidate.last > 0.20 || !near(candidate, 0.35)) {
      candidate = { x: grip.x, y: grip.y, t: f.t, last: f.t, rows: [] };
    }
    candidate.last = f.t;
    candidate.rows.push(f);
    if (f.t - candidate.t < 0.12) continue;
    spans.push(span = { start: candidate.t, end: f.t, grips: candidate.rows });
    atBarHeight = false;
    anchor = { x: grip.x, y: grip.y };
    last = f.t;
    candidate = null;
  }
  return spans;
}

/* ------------------------------------------------------------------ the analysis */
/**
 * samples: [{ t (video s), pose: 33 landmarks in video px or null }]
 * opts: { W (video width px), slowmo, move ("auto" or a MOVES key), heightCm, kg (bodyweight), facing (0 auto, ±1) }
 */
export function analyse(samples, opts = {}) {
  const slow = opts.slowmo > 0 ? opts.slowmo : 1;
  const heightM = (opts.heightCm > 100 && opts.heightCm < 250 ? opts.heightCm : 175) / 100;
  const posed = samples.filter((s) => s.pose);
  if (posed.length < 20 || posed.length < 0.5 * samples.length) return { error: tr("kip.noAthlete") };
  const tv0 = samples[0].t, real = (tv) => (tv - tv0) / slow;
  const dts = [];
  for (let i = 1; i < posed.length; i++) { const d = real(posed[i].t) - real(posed[i - 1].t); if (d > 1e-5) dts.push(d); }
  const fs = clamp(Math.round(1 / median(dts)), 15, 480);
  const Bs = bodies(posed.map((s) => s.pose));
  const fr = posed.map((s, j) => ({ t: real(s.t), P: s.pose, B: Bs[j] }));

  const contacts = contactSpans(fr);
  const attached = contacts.flatMap(s => s.grips);
  const onHang = attached.filter(f => onBarNow(f.B));
  if (attached.length < 20 || attached.at(-1).t - attached[0].t < 0.3 || onHang.length < 5) return { error: tr("kip.notOnBar") };
  // Only contact observations enter the filters. The time grid still spans the
  // video so each bout can be scrubbed at its original timestamps.
  const frames = attached.map((f) => f.P);
  const heldBodies = attached.map(f => f.B);

  // which way, the camera's angle, the scale
  const fc0 = facingOf(heldBodies);
  const facing = opts.facing === 1 || opts.facing === -1 ? opts.facing : fc0.facing;
  const view = viewAngle(frames, opts.W || 1000, { heightM, facing, Bs: heldBodies });
  const c = Math.max(0.3, view.c);
  const scale = bodyScale(heldBodies, c, heightM);

  // the bar: where the hands close on it. A still phone: one place. A phone that moves (the hands' place drifts on
  // screen, slowly: the hands themselves only turn on the bar): followed frame by frame.
  const gmx = median(onHang.map((f) => f.B.grip.x)), gmy = median(onHang.map((f) => f.B.grip.y));
  const ft = attached.map((f) => f.t);
  let wander;
  {
    const Tg = Float64Array.from({ length: Math.max(8, Math.floor((ft[ft.length - 1] - ft[0]) * fs)) }, (_, i) => ft[0] + i / fs);
    const sx = filtfilt(resample(ft, attached.map((f) => f.B.grip.x), Tg), Math.min(0.4, fs / 4), fs), sy = filtfilt(resample(ft, attached.map((f) => f.B.grip.y), Tg), Math.min(0.4, fs / 4), fs);
    const mx = median(sx), my = median(sy);
    wander = quantile(Array.from(sx, (v, i) => Math.hypot(v - mx, sy[i] - my)), 0.95) / scale.statPx;
  }
  const moving = wander > 0.08;
  const cam = camera(c, view.front, facing);

  // the grid: the span on the bar, in real seconds
  const t0 = attached[0].t, t1 = attached.at(-1).t;
  const n = Math.floor((t1 - t0) * fs) + 1;
  const T = Float64Array.from({ length: n }, (_, i) => t0 + i / fs);
  const bouts = contacts.map(s => ({
    first: clamp(Math.ceil((s.start - t0) * fs), 0, n - 1),
    last: clamp(Math.floor((s.end - t0) * fs), 0, n - 1),
  }));
  const held = new Uint8Array(n);
  for (const b of bouts) held.fill(1, b.first, b.last + 1);
  const heldCount = held.reduce((sum, v) => sum + v, 0);
  const fcPos = Math.min(6, fs / 4);
  const img = {};
  for (const k of NAMES) {
    img[k] = { x: filtfilt(resample(ft, attached.map((f) => f.B[k].x), T), fcPos, fs), y: filtfilt(resample(ft, attached.map((f) => f.B[k].y), T), fcPos, fs) };
  }
  // the bar, the scale per grid point
  const Bx = new Float64Array(n), By = new Float64Array(n), K = new Float64Array(n);
  if (moving) {
    const fcB = Math.min(1.5, fs / 4), bx = filtfilt(resample(ft, attached.map((f) => f.B.grip.x), T), fcB, fs), by = filtfilt(resample(ft, attached.map((f) => f.B.grip.y), T), fcB, fs);
    // the body's size on screen over a 1.5 s window: the phone may come closer or zoom
    const stat = attached.map((f) => { let s = 0; for (const g of RIGID) { const a = f.B[g.from], b = f.B[g.to]; s += Math.hypot((b.x - a.x) / c, b.y - a.y); } return s / RIGID.reduce((q, g) => q + g.len, 0); });
    const half = 0.75;
    const rolled = ft.map(t => median(stat.filter((_, j) => Math.abs(ft[j] - t) <= half)));
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
      if (held[i]) segL[j] += Math.hypot(b.x - a.x, b.y - a.y) / heldCount;
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
  // Derivatives across a release have no bar-force interpretation. Leave half
  // a filter cycle at each contact edge, keeping the centre of short bouts.
  let residualSum = 0, torqueSum = 0, count = 0;
  for (const { first, last } of bouts) {
    const pad = Math.min(Math.ceil(fs / (2 * fcH)), Math.floor((last - first) / 4));
    for (let i = first + pad; i <= last - pad; i++) {
      residualSum += resid[i] ** 2;
      torqueSum += tg[i] ** 2;
      count++;
    }
  }
  const consistency = 1 - clamp(Math.sqrt(residualSum / Math.max(count * (G * 0.03) ** 2, torqueSum)), 0, 1);

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
    for (let i = 0, k = 0; i < n; i++) { if (held[i] && speed[i] < 0.12 && straight(i)) { if (++k >= run) { uRest = median(comU.slice(i - run + 1, i + 1)); break; } } else k = 0; }
    if (uRest === null) uRest = quantile(Array.from(comU).filter((_, i) => held[i] && straight(i)), 0.05);
    if (!Number.isFinite(uRest)) uRest = quantile(comU.filter((_, i) => held[i]), 0.02);
  }
  const Erest = G * uRest;
  const Er = Float64Array.from(E, (v) => v - Erest), PEr = Float64Array.from(PE, (v) => v - Erest);

  // reps
  const R = { fs, n, T, t0, tv0, slow, held, bouts, facing, facingFrom: opts.facing ? "you" : fc0.sure ? "body" : "guess", view, c, scale, moving, wander, heightM, kg: opts.kg > 0 ? opts.kg : null,
    pl, img, Bx, By, K, comF, comU, comX, comY, vf, vu, speed, Ff, Fu, Fb, E, Er, PE, PEr, KE, P, Hb, resid, tg, consistency,
    elbow, shoulder, hip: hipA, knee, uRest, span: [0, n - 1], onBar: [t0, t1], frames: attached.length,
    poseCover: Math.min(1, attached.length / heldCount) };
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
  const arm = quantile(reach.filter((_, i) => R.held[i]), 0.95), dReach = deriv(reach, fs);
  R.reach = reach; R.arm = arm;
  const hangSh = quantile(Array.from(uSh).filter((_, i) => R.held[i] && reach[i] > 0.9 * arm), 0.5);
  const hangToe = quantile(Array.from(uToe).filter((_, i) => R.held[i] && reach[i] > 0.9 * arm && Math.abs(hip[i]) < 30), 0.5);
  const gap = Math.round(0.6 * fs);
  const lowBefore = (i, first) => { let j = i; while (j > first && uSh[j - 1] <= uSh[j] + 1e-9) j--; return j; };
  const minReach = (a, b) => { let m = Infinity; for (let j = Math.max(0, a); j <= Math.min(n - 1, b); j++) m = Math.min(m, reach[j]); return m; };
  const pulls = [], kicks = [];
  const toeDist = (i) => Math.hypot(pl.toe.f[i], pl.toe.u[i]);
  for (const { first, last } of R.bouts) {
    let previous = first;
    for (const peak of peaks(uSh.subarray(first, last + 1), 0.12 * H, gap)) {
      const i = first + peak;
      if (!(uSh[i] - hangSh > 0.14 * H && minReach(lowBefore(i, first), i) < 0.78 * arm)) continue;
      // A preparatory swing can raise the shoulders while the face stays far below the bar.
      if (pl.chin.u[i] < -0.15 * H) continue;
      // An ascent into support must start below the bar, including after a long lockout.
      if (uSh[i] > 0.12 * H && uSh[argmin(uSh, previous, i)] > -0.12 * H) continue;
      pulls.push({ i, first, last });
      previous = i;
    }
    for (const peak of peaks(uToe.subarray(first, last + 1), 0.4 * H, gap)) {
      const i = first + peak;
      if (hip[i] > 70 && uToe[i] - (Number.isFinite(hangToe) ? hangToe : -H) > 0.45 * H && toeDist(i) < 0.5)
        kicks.push({ i, first, last });
    }
  }
  // the swing: the centre of mass's angle from below the bar
  const swingDeg = Float64Array.from(comF, (f, i) => deg(Math.atan2(f, -comU[i])));
  R.swingDeg = swingDeg;

  // the family: feet to the bar, or the body up to it, or neither (swings)
  const fam = kicks.length > pulls.length ? "feet" : pulls.length ? "pull" : "swing";
  const selected = fam === "feet" ? kicks : pulls;
  const tops = selected.map(p => p.i);
  const reps = [];
  for (let k = 0; k < tops.length; k++) {
    const top = tops[k];
    const { first, last } = selected[k];
    const hasPrev = k > 0 && selected[k - 1].first === first, hasNext = selected[k + 1]?.first === first;
    const prev = hasPrev ? tops[k - 1] : first, next = hasNext ? tops[k + 1] : last;
    const sig = fam === "feet" ? uToe : uSh;
    const bottom = argmin(sig, prev, top); // the lowest point before it
    const begin = hasPrev ? bottom : Math.max(first, Math.min(bottom, top - Math.round(1.5 * fs)));
    const end = hasNext ? argmin(sig, top, next) : Math.min(last, top + Math.round(1.2 * fs));
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
    const c0 = hasPrev ? reps[k - 1].cTop : first;
    let wPos = 0;
    for (let i = c0; i <= cTop; i++) if (P[i] > 0) wPos += P[i] / fs;
    const iF = argmax(Fb, w0, top);
    const pPeak = argmax(P, w0, top);
    const kept = hasNext ? Math.max(0, Er[argmin(Er, cTop, tops[k + 1])]) / Math.max(1e-6, eTop) : null;
    reps.push({
      n: k + 1, begin, bottom, top, end, cTop, onset, snap, first, last,
      hipsFirst: (onset - snap) / fs, snapDir: Math.sign(dHip[snap]) || 1,
      fromKip: eTop > 0.3 ? clamp(Er[onset] / eTop, 0, 1) : null,
      work: wPos, workRatio: PEr[cTop] > 0.3 ? wPos / PEr[cTop] : null,
      rise: comU[cTop] - R.uRest, eTop,
      peakForce: Fb[iF], iF, peakPower: P[pPeak], meanPower: mean(P, bottom, top),
      kept, cycle: hasPrev ? (top - tops[k - 1]) / fs : null,
      kipping: rangeOf(hip, w0, top) > 30, // the kip is a hip action: a strict rep moves the body sideways too (the head has to clear the bar)
      hang: reach[argmax(reach, prev, Math.max(prev, onset))] / arm, // 1 = arms fully long
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
  const chinU = Math.max(...range(Math.max(r.first, r.top - 3), Math.min(r.last, r.top + 3), R.n).map((j) => pl.chin.u[j]));
  // closest the chest comes to the bar around the top
  let chest = Infinity;
  for (const j of range(Math.max(r.first, r.top - Math.round(0.3 * R.fs)), Math.min(r.last, r.top + Math.round(0.3 * R.fs)), R.n)) {
    const sh = { f: pl.sh.f[j], u: pl.sh.u[j] }, hp = { f: pl.hip.f[j], u: pl.hip.u[j] };
    const L = Math.hypot(hp.f - sh.f, hp.u - sh.u) || 1, down = { f: (hp.f - sh.f) / L, u: (hp.u - sh.u) / L }, fwd = { f: -down.u, u: down.f };
    const sgn = fwd.f >= 0 ? 1 : -1; // the forward normal points the way the athlete faces
    const p = { f: sh.f + CHEST_DOWN * H * down.f + sgn * CHEST_FWD * H * fwd.f, u: sh.u + CHEST_DOWN * H * down.u + sgn * CHEST_FWD * H * fwd.u };
    chest = Math.min(chest, Math.hypot(p.f, p.u));
  }
  let feet = Infinity;
  for (const j of range(Math.max(r.first, r.top - 3), Math.min(r.last, r.top + 3), R.n)) feet = Math.min(feet, Math.hypot(pl.toe.f[j], pl.toe.u[j]));
  const shTop = pl.sh.u[i];
  // a muscle-up's lockout: the highest the shoulders get above the bar, arms straight there
  const lock = shTop > 0.08 * H ? R.reach[argmax(pl.sh.u, Math.max(r.first, i - 5), Math.min(r.last, i + 5))] / R.arm : null; // arms' length in support, × hanging
  let heelsBack = null;
  if (R.fam === "feet") { heelsBack = Infinity; for (let j = Math.max(r.first, r.begin - Math.round(0.5 * R.fs)); j <= r.top; j++) heelsBack = Math.min(heelsBack, pl.heel.f[j]); }
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
  if (kind !== "t2b" && kind !== "swing") out.push({ id: "hang", ...v(r.hang >= 0.93, r.hang >= 0.88, tr(r.hang >= 0.93 ? "std.hangLong" : "std.hangShort", { pct: Math.round(100 * r.hang) })) });
  if (kind === "pullup") out.push({ id: "chin", ...v(s.chinU > 0.03, s.chinU > -0.06, tr("std.chin", { cm: fmtSigned(s.chinU * 100) })) });
  if (kind === "c2b") out.push({ id: "chest", ...v(s.chest <= 0.05, s.chest <= 0.09, tr("std.chest", { cm: Math.round(s.chest * 100) })) });
  if (kind === "t2b") {
    out.push({ id: "feet", ...v(s.feet <= 0.12, s.feet <= 0.22, tr("std.toes", { cm: Math.round(s.feet * 100) })) });
    out.push({ id: "heels", ...v(s.heelsBack < -0.03, s.heelsBack < 0.03, tr(s.heelsBack < 0 ? "std.heelsBehind" : "std.heelsFront")) });
  }
  if (kind === "bmu") out.push({ id: "lock", ...v(s.lock >= 0.88, s.lock >= 0.82, tr(s.lock >= 0.88 ? "std.lockedOut" : "std.lockBent", { pct: Math.round(100 * s.lock) })) });
  return out;
}

function report(R, opts) {
  const { reps, fs } = R;
  const H = R.heightM;
  const kgW = R.kg; // bodyweight: watts and joules; otherwise per kg
  const fmtE = (j) => (kgW ? `${Math.round(j * kgW)} J` : `${num(j, 1)} J/kg`);
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

  // a measurement: its group and label by key (metric.group.<g>, metric.<k>.label), the note already in words
  const metrics = [], put = (g, k, value, unit, note) => metrics.push({ group: tr(`metric.group.${g}`), label: tr(`metric.${k}.label`), value, unit, note });
  const tile = (k, value, unit, note = tr(`tile.${k}.note`)) => tiles.push({ label: tr(`tile.${k}.label`), value, unit, note });
  const check = (status, basis, k, vars, text = tr(`check.${k}.text`, vars)) => checks.push({ status, basis, title: tr(`check.${k}.title`, vars), text });
  const tiles = [], checks = [], notes = [], film = [];
  const valid = reps.filter((r) => r.valid === "pass").length, unsure = reps.filter((r) => r.valid === "unsure").length;
  const pct = (x) => `${Math.round(100 * x)}%`;
  const bw = tr("unit.bw");

  // the swing alone
  const sw = R.swingDeg, amplitude = Float64Array.from(sw, Math.abs);
  const turns = R.bouts.map(b => peaks(amplitude.subarray(b.first, b.last + 1), 4, Math.round(0.4 * fs)).map(i => b.first + i));
  const ext = turns.flat(), swingsCount = turns.reduce((sum, p) => sum + Math.floor(p.length / 2), 0);
  R.swingExt = ext;
  const amp = ext.length ? Math.max(...ext.map((i) => Math.abs(sw[i]))) : Math.max(...R.bouts.map(b => rangeOf(sw, b.first, b.last))) / 2;

  if (move === "swing" || !reps.length) {
    const ePer = [];
    for (let k = 1; k < ext.length; k++) if (R.bouts.some(b => b.first <= ext[k - 1] && ext[k] <= b.last)) ePer.push(R.Er[ext[k]] - R.Er[ext[k - 1]]);
    const hip = R.hip.filter((_, i) => R.held[i]), shoulder = R.shoulder.filter((_, i) => R.held[i]);
    const hs = quantile(hip, 0.97) - quantile(hip, 0.03), shs = quantile(shoulder, 0.97) - quantile(shoulder, 0.03);
    tile("swings", String(swingsCount), "");
    tile("swingSize", num(amp, 0), "°");
    tile("hipRange", num(hs, 0), "°");
    tile("shoulderRange", num(shs, 0), "°");
    put("swing", "largestSwing", amp, "°", tr("metric.largestSwing.note"));
    put("swing", "heightGained", Math.max(0, quantile(R.comU.filter((_, i) => R.held[i]), 0.98) - R.uRest) * 100, "cm", tr("metric.heightGained.note"));
    if (ePer.length) put("swing", "halfSwing", median(ePer) * (kgW || 1), kgW ? "J" : "J/kg", tr("metric.halfSwing.note"));
    put("shape", "hipHollow", quantile(hip, 0.98), "°", tr("metric.hipHollow.note"));
    put("shape", "hipArch", quantile(hip, 0.02), "°");
    put("shape", "shHollow", quantile(shoulder, 0.98), "°", tr("metric.shHollow.note"));
    put("shape", "shArch", quantile(shoulder, 0.02), "°");
    if (hs < 25) check("warning", "coaching", "smallHollow", { deg: Math.round(hs) });
    else check("good", "coaching", "hollowArch", { hip: Math.round(hs), sh: Math.round(shs) });
    if (ePer.length >= 2) {
      const gain = median(ePer);
      if (gain > 0.05) check("good", "physics", "swingGrows", { energy: fmtE(gain) });
      else check("warning", "physics", "swingFlat");
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
    tile("reps", `${valid}`, `/ ${reps.length}`, unsure ? tr("tile.reps.noteUnsure", { n: unsure }) : tr("tile.reps.note", { n: valid }));
    if (kipping && fk.length) tile("fromKip", String(Math.round(100 * median(fk))), "%");
    if (kipping && move !== "t2b") tile("hipsArms", num(median(hf) * 1000, 0), "ms", median(hf) >= 0 ? tr("tile.hipsArms.note") : tr("tile.hipsArms.noteArms"));
    tile("peakForce", num(Math.max(...pf), 1), bw, tr("tile.peakForce.note", { f: num(median(pf), 1) }));
    if (!kipping || move === "t2b") tile("work", wr.length ? String(Math.round(100 * median(wr))) : "–", "%");

    put("set", "reps", reps.length, "", unsure ? tr("metric.reps.noteUnsure", { n: valid, unsure }) : tr("metric.reps.note", { n: valid }));
    const cycles = reps.map(r => r.cycle).filter(Number.isFinite);
    if (cycles.length) put("set", "timePerRep", median(cycles), "s", tr("metric.timePerRep.note"));
    put("set", "style", kipping ? 1 : 0, "", tr(kipping ? "metric.style.kipping" : "metric.style.strict"));
    put("energy", "comRise", median(reps.map((r) => r.rise)) * 100, "cm", tr("metric.comRise.note"));
    put("energy", "energyTop", median(reps.map((r) => r.eTop)) * (kgW || 1), kgW ? "J" : "J/kg", tr("metric.energyTop.note"));
    if (fk.length) put("energy", "fromKip", median(fk) * 100, "%", tr("metric.fromKip.note"));
    if (wr.length) put("energy", "work", median(wr) * 100, "%", tr("metric.work.note"));
    if (kept.length) put("energy", "kept", median(kept) * 100, "%", tr("metric.kept.note"));
    put("force", "peakForce", Math.max(...pf), bw, tr("metric.peakForce.note"));
    put("force", "peakForceMedian", median(pf), bw);
    put("power", "peakPower", Math.max(...reps.map((r) => r.peakPower)) * (kgW || 1), kgW ? "W" : "W/kg", kgW ? tr("metric.peakPower.noteKg", { kg: plain(kgW) }) : tr("metric.peakPower.note"));
    put("power", "meanPower", median(reps.map((r) => r.meanPower)) * (kgW || 1), kgW ? "W" : "W/kg", tr("metric.meanPower.note"));
    if (kipping) {
      put("timing", "hipsArms", median(hf) * 1000, "ms", tr("metric.hipsArms.note"));
      const closing = reps.filter((r) => r.snapDir > 0).length >= reps.length / 2;
      put("timing", "hipSnap", closing ? 1 : -1, "", tr(closing ? "metric.hipSnap.closing" : "metric.hipSnap.opening"));
    }
    put("standard", "meeting", valid, "", tr("metric.meeting.note", { move: MOVES[move], part: tr(`metric.meeting.${rel}`) }));

    // checks: standards first, then physics, then coaching; each against your own best rep where it can
    const bad = reps.filter((r) => r.valid === "no"), close = reps.filter((r) => r.valid === "unsure");
    const items = (list, keep) => list.map((r) => tr("check.repItem", { n: r.n, what: r.checks.filter(keep).map((c) => c.text).join(", ") })).join("; ");
    if (bad.length) check("serious", "standard", "noRep", { n: bad.length, list: items(bad, (c) => c.result === "no") });
    if (close.length) check("warning", "standard", "close", { n: close.length, list: items(close, (c) => c.result !== "pass") });
    if (!bad.length && !close.length) check("good", "standard", "allPass", { move: MOVES[move].toLowerCase(), what: reps[0].checks.map((c) => c.text).join(", ") }, tr(reps.length > 1 ? "check.allPass.textMany" : "check.allPass.text", { what: reps[0].checks.map((c) => c.text).join(", ") }));
    if (kipping && fk.length) {
      const m = median(fk);
      check(m >= 0.2 ? "good" : "warning", "physics", m >= 0.2 ? "kipCarries" : "armsWork", { pct: pct(m) });
    }
    if (kipping && move !== "t2b") {
      // timing to a frame or two: at 30 fps a frame is 33 ms, so only clear leads count. A muscle-up's pull rides
      // the hip pop by design: judged more gently.
      const m = median(hf), lim = move === "bmu" ? -0.15 : -0.1, early = reps.filter((r) => r.hipsFirst < lim);
      const frame = tr("check.frame", { ms: Math.round(1000 / (R.fs * R.slow)) });
      if (m < lim) check(move === "bmu" ? "warning" : "serious", "coaching", "pullFirst", { ms: Math.round(-m * 1000), frame });
      else if (early.length) check("warning", "coaching", "someEarly", { n: early.length, reps: early.map((r) => r.n).join(", "), frame });
      else if (m < 0.03) check("good", "coaching", "together", { ms: fmtSigned(m * 1000), frame });
      else check("good", "coaching", "hipsFirst", { ms: Math.round(m * 1000), frame });
    }
    if (best && ranked.length >= 3) {
      // what the best rep did differently: timing and kip share, against the others
      const others = ranked.filter((r) => r !== best), dt = median(others.map((r) => r.hipsFirst)), fo = median(others.map((r) => r.fromKip ?? 0));
      const bits = [];
      if (kipping && Math.abs(best.hipsFirst - dt) >= 0.05) bits.push(tr(best.hipsFirst > dt ? "check.best.later" : "check.best.earlier", { ms: Math.round(Math.abs(best.hipsFirst - dt) * 1000) }));
      if (kipping && best.fromKip !== null && Math.abs(best.fromKip - fo) >= 0.08) bits.push(tr("check.best.kip", { pct: pct(best.fromKip), others: pct(fo) }));
      const vars = { n: best.n, work: pct(best.workRatio), median: pct(median(wr)), why: bits.join("; ") };
      check("good", "physics", "best", vars, tr(bits.length ? "check.best.textWhy" : "check.best.text", vars));
    }
    if (kept.length >= 2) {
      const first = kept[0], last = kept[kept.length - 1];
      if (last < first - 0.2) check("warning", "physics", "rhythm", { first: pct(first), last: pct(last) });
    }
    const hard = reps.filter((r) => r.peakForce > 2.6);
    if (hard.length) check("warning", "physics", "sharp", { n: hard.length, reps: hard.map((r) => r.n).join(", "), x: num(2.6, 1) });
  }

  // filming: how far the numbers can be trusted
  const a = R.view.alpha, aDeg = Math.round(a);
  const how = R.view.from === "swing" ? "swing" : R.view.from === "depth" ? "depth" : "assumed";
  film.push(a <= 50
    ? { status: "good", title: tr("film.angle.title", { deg: aDeg }), text: tr("film.angle.text", { side: tr(a < 15 ? "film.angle.sideOn" : "film.angle.turned"), lo: Math.round(R.view.band[0]), hi: Math.round(R.view.band[1]), how: tr(`film.angle.${how}`) }) }
    : a <= 62
      ? { status: "warning", title: tr("film.angleFar.title", { deg: aDeg }), text: tr("film.angleFar.text") }
      : { status: "serious", title: tr("film.angleFront.title", { deg: aDeg }), text: tr("film.angleFront.text") });
  film.push(R.moving
    ? { status: "warning", title: tr("film.moved.title"), text: tr("film.moved.text") }
    : { status: "good", title: tr("film.still.title"), text: tr("film.still.text") });
  const fps = Math.round(fs * R.slow);
  film.push({ status: fps >= 50 ? "good" : "warning", title: tr("film.fps.title", { fps }), text: tr(fps >= 50 ? "film.fps.ok" : "film.fps.low") });
  const cons = R.consistency;
  // the gravity check: validated on simulated swings (63–93% with tracking noise); on handheld 30 fps clips it reads
  // 10–50% even when the rest holds, so it's a measurement, and a warning only when it's clearly broken
  if (cons < 0.1) film.push({ status: "warning", title: tr("film.physics.title"), text: tr("film.physics.text") });
  if (!opts.heightCm) notes.push(tr("note.noHeight"));
  if (!kgW) notes.push(tr("note.noKg"));
  put("filming", "camera", a, "°", tr(`metric.camera.${how}`));
  put("filming", "consistency", cons * 100, "%", tr("metric.consistency.note"));
  put("filming", "frameRate", fps, "fps");
  put("filming", "analysed", R.bouts.reduce((seconds, b) => seconds + (b.last - b.first) / fs, 0), "s", tr("metric.analysed.note"));

  // the title: the movement, then the count (the gallery splits them at " · ")
  const swings = move === "swing" || !reps.length;
  const name = swings ? MOVES.swing
    : kipping && move !== "bmu" && move !== "t2b" ? tr("title.kipping", { move: MOVES[move] })
      : !kipping && move !== "t2b" ? tr("title.strict", { move: MOVES[move] }) : MOVES[move];
  R.title = `${name} · ${swings ? tr("count.swings", { n: swingsCount }) : tr("count.reps", { n: reps.length })}`;
  R.tiles = tiles; R.checks = checks; R.film = film; R.notes = notes; R.metrics = metrics;
  // stages for the timing bar: per rep, drive (bottom → top) and down (top → next bottom)
  const stages = [];
  for (const r of reps) {
    if (r.top > r.bottom) stages.push({ id: "drive", rep: r.n, name: STAGES.drive.name, slot: 2, i0: r.bottom, i1: r.top, dur: (r.top - r.bottom) / fs });
    if (r.end > r.top) stages.push({ id: "down", rep: r.n, name: STAGES.down.name, slot: 4, i0: r.top, i1: r.end, dur: (r.end - r.top) / fs });
  }
  R.stages = stages;
}

/** a number as String() writes it (no fixed decimals: 72.5, 80), with the language's decimal mark */
const plain = (v) => num(v, (String(v).split(".")[1] || "").length);

/** a measurement shown in words, not as its value (the style, the hip snap's direction) */
export const inWords = (m) => m.label === tr("metric.style.label") || m.label === tr("metric.hipSnap.label");

/** a measurement as shown */
export function fmtMetric(m) {
  if (inWords(m)) return m.note;
  const d = ["°", "%", "", "W", "J", "ms", "fps", "cm"].includes(m.unit) ? 0 : m.unit === tr("unit.bw") ? 2 : 1;
  return num(m.value, d);
}
