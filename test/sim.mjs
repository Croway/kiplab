/* A simulated athlete hanging from a bar, for testing the analysis against a known truth.
 *
 * The body is a planar chain from the bar: hand+forearm, upper arm, trunk (with the head), thigh, shank (with the
 * foot), with the masses, centres of mass and radii of gyration of js/body.js. Its shape (elbow, shoulder, hip,
 * knee angles) is prescribed over time; how it swings is not: it follows from the physics. Hanging from a bar,
 * only gravity and the bar act on the body, and the grip can't twist the bar (or only as much as a `grip` torque
 * says), so the angular momentum about the bar changes only by gravity's torque:
 *     dH/dt = −g Σ mᵢ xᵢ + τ_grip,      H = I_bar(shape) φ̇ + h(shape, shape rate)
 * φ (the forearm's angle) is integrated from that (RK4, 0.5 ms steps). Truth: every point, the centre of mass,
 * the body's energy, the force through the bar, the grip torque.
 *
 * The camera: a level phone D m from the bar's middle, turned α degrees from side-on, perspective projection;
 * landmarks come out like MediaPipe's (x, y px; z depth in x's scale relative to the hips; visibility), with
 * jitter and a slow wobble.
 *
 *   import { simulate, keys, PROGRAMS } from "./sim.mjs"
 *   node test/sim.mjs <program> [--alpha 40] [--noise 4] [--fps 60] > out.samples.json
 */
import { SEGMENTS, LM } from "../js/body.js";

const G = 9.81;
const rad = (d) => (d * Math.PI) / 180;
const d = (th) => [Math.sin(th), -Math.cos(th)]; // pointing from the bar end of a segment to its far end
const n = (th) => [Math.cos(th), Math.sin(th)]; // forward of it
const add = (p, ...vs) => { let x = p[0], y = p[1]; for (const [k, v] of vs) { x += k * v[0]; y += k * v[1]; } return [x, y]; };

/** the body's points (metres, bar at the origin, x forward, y up) for forearm angle phi and shape q (radians) */
export function chain(H, phi, q) {
  const t0 = phi, t1 = t0 - q.e, t2 = t1 + q.s, t3 = t2 + q.h, t4 = t3 - q.k;
  const bar = [0, 0];
  const wr = add(bar, [0.028 * H, d(t0)]), el = add(bar, [0.174 * H, d(t0)]);
  const sh = add(el, [0.186 * H, d(t1)]), hip = add(sh, [0.288 * H, d(t2)]);
  const kn = add(hip, [0.245 * H, d(t3)]), an = add(kn, [0.246 * H, d(t4)]);
  const up = d(t2).map((v) => -v), fw = n(t2);
  const ear = add(sh, [0.11 * H, up]);
  return {
    bar, wr, el, sh, hip, kn, an, ear,
    index: add(bar, [-0.03 * H, d(t0)], [0.01 * H, n(t0)]), pinky: add(bar, [-0.025 * H, d(t0)], [-0.005 * H, n(t0)]),
    toe: add(an, [0.1 * H, d(t4)], [0.03 * H, n(t4)]), heel: add(an, [-0.03 * H, n(t4)], [0.01 * H, d(t4)]),
    nose: add(ear, [0.055 * H, fw], [-0.005 * H, up]), eye: add(ear, [0.045 * H, fw], [0.01 * H, up]),
    mouth: add(ear, [0.05 * H, fw], [-0.03 * H, up]), chin: add(ear, [0.045 * H, fw], [-0.06 * H, up]),
    theta: { forearm: t0, upperArm: t1, trunk: t2, thigh: t3, shank: t4, foot: t4 },
  };
}
const asB = (c) => ({ sh: c.sh, el: c.el, wr: c.wr, hip: c.hip, kn: c.kn, an: c.an, heel: c.heel, toe: c.toe, ear: c.ear });
/** segment centres of mass, masses, inertias */
function segs(c, M) {
  const B = asB(c);
  return SEGMENTS.map((s) => {
    const a = B[s.from], b = B[s.to], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { id: s.id, m: s.m * M, I: s.m * M * (s.k * L) ** 2, x: a[0] + s.c * (b[0] - a[0]), y: a[1] + s.c * (b[1] - a[1]), th: c.theta[s.id] ?? null };
  });
}

/** keyframes [[t, e, s, h, k], …] in degrees → q(t) in radians, eased (cosine) between keys */
export function keys(K) {
  return (t) => {
    if (t <= K[0][0]) return toQ(K[0]);
    if (t >= K[K.length - 1][0]) return toQ(K[K.length - 1]);
    let i = 0;
    while (t > K[i + 1][0]) i++;
    const a = K[i], b = K[i + 1], u = (1 - Math.cos((Math.PI * (t - a[0])) / (b[0] - a[0]))) / 2;
    return toQ(a.map((v, j) => v + (b[j] - v) * u));
  };
}
const toQ = (k) => ({ e: rad(k[1]), s: rad(k[2]), h: rad(k[3]), k: rad(k[4]) });

/** simulate. spec: { H, M, dur, phi0 (deg), shape(t) → q, grip?(t, phi, dphi) → N·m, fps } */
export function simulate(spec) {
  const { H = 1.78, M = 80, dur = 8, fps = 60, shape } = spec;
  const grip = spec.grip || (() => 0);
  const dt = 0.0005, h = 1e-4;
  const state = (phi, t) => segs(chain(H, phi, shape(t)), M);
  // angular momentum about the bar for (phi, dphi) at t; velocities by central differences
  const Hb = (phi, dphi, t) => {
    const a = state(phi - dphi * h, t - h), b = state(phi + dphi * h, t + h);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const x = (a[i].x + b[i].x) / 2, y = (a[i].y + b[i].y) / 2, vx = (b[i].x - a[i].x) / (2 * h), vy = (b[i].y - a[i].y) / (2 * h);
      s += a[i].m * (x * vy - y * vx);
      if (a[i].th !== null) s += a[i].I * (b[i].th - a[i].th) / (2 * h);
    }
    return s;
  };
  const rate = (phi, Hm, t) => {
    const h0 = Hb(phi, 0, t), A = Hb(phi, 1, t) - h0, dphi = (Hm - h0) / A;
    let tg = 0;
    for (const s of state(phi, t)) tg += -G * s.m * s.x;
    return [dphi, tg + grip(t, phi, dphi)];
  };
  let phi = rad(spec.phi0 || 0), t = 0;
  let Hm = Hb(phi, rad(spec.dphi0 || 0), 0);
  const fine = []; // every step: t, phi
  while (t <= dur + 1e-9) {
    fine.push([t, phi, Hm]);
    const k1 = rate(phi, Hm, t), k2 = rate(phi + (dt / 2) * k1[0], Hm + (dt / 2) * k1[1], t + dt / 2);
    const k3 = rate(phi + (dt / 2) * k2[0], Hm + (dt / 2) * k2[1], t + dt / 2), k4 = rate(phi + dt * k3[0], Hm + dt * k3[1], t + dt);
    phi += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    Hm += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    t += dt;
  }
  const phiAt = (tt) => { const i = Math.min(fine.length - 2, Math.max(0, Math.floor(tt / dt))), u = (tt - fine[i][0]) / dt; return fine[i][1] + (fine[i + 1][1] - fine[i][1]) * u; };
  const bodyAt = (tt) => chain(H, phiAt(tt), shape(tt));
  const comAt = (tt) => { let x = 0, y = 0; for (const s of state(phiAt(tt), tt)) { x += s.m * s.x; y += s.m * s.y; } return [x / M, y / M]; };
  // truth at each video frame
  const T = [], frames = [];
  const e = 1 / 240; // differencing step for the truth's velocities and accelerations
  for (let i = 0; ; i++) {
    const tt = i / fps;
    if (tt > dur - 2 * e) break;
    T.push(tt);
    const a = state(phiAt(tt - e), tt - e), b = state(phiAt(tt + e), tt + e), m = state(phiAt(tt), tt);
    let ke = 0, pe = 0, hb = 0;
    for (let j = 0; j < m.length; j++) {
      const vx = (b[j].x - a[j].x) / (2 * e), vy = (b[j].y - a[j].y) / (2 * e);
      ke += 0.5 * m[j].m * (vx * vx + vy * vy);
      pe += m[j].m * G * m[j].y;
      hb += m[j].m * (m[j].x * vy - m[j].y * vx);
      if (m[j].th !== null) { const w = (b[j].th - a[j].th) / (2 * e); ke += 0.5 * m[j].I * w * w; hb += m[j].I * w; }
    }
    const c0 = comAt(tt - e), c1 = comAt(tt), c2 = comAt(tt + e);
    const ax = (c2[0] - 2 * c1[0] + c0[0]) / (e * e), ay = (c2[1] - 2 * c1[1] + c0[1]) / (e * e);
    frames.push({ t: tt, body: bodyAt(tt), com: c1, v: [(c2[0] - c0[0]) / (2 * e), (c2[1] - c0[1]) / (2 * e)], ke, pe, E: ke + pe, H: hb, F: [M * ax, M * (ay + G)], grip: grip(tt, phiAt(tt), 0) });
  }
  return { H, M, fps, frames };
}

/* ------------------------------------------------------------------ the camera */
// left/right half-widths (m) of each landmark pair, for a 1.78 m athlete
const HALF = { Shoulder: 0.19, Elbow: 0.27, Wrist: 0.33, Index: 0.34, Pinky: 0.32, Hip: 0.1, Knee: 0.09, Ankle: 0.07, Heel: 0.07, Toe: 0.07, Ear: 0.075, Eye: 0.035, mouth: 0.025 };
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

/**
 * Film a simulation. view: { alpha (deg from side-on), D (m), camY (m, relative to the bar), W, Hpx, f (px),
 * facing (+1 the athlete faces the picture's right), noise (px jitter), wobble (px, slow), seed }
 * → MediaPipe-style samples [{ t, pose: 33 × {x, y, z, v} }]
 */
export function film(sim, view = {}) {
  const { alpha = 0, D = 4.5, camY = -1.25, W = 1080, Hpx = 1920, f = 2100, facing = 1, noise = 4, wobble = 3, seed = 7 } = view;
  const k = sim.H / 1.78, a = rad(alpha);
  const C = [D * Math.sin(a), camY, D * Math.cos(a)], fwd = [-Math.sin(a), 0, -Math.cos(a)], right = [Math.cos(a), 0, -Math.sin(a)];
  const rnd = rng(seed), gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const wob = new Map(); // slow wobble per landmark coordinate (AR(1), ~0.3 s)
  const slow = (key) => { const w = 0.95 * (wob.get(key) || 0) + Math.sqrt(1 - 0.95 ** 2) * wobble * gauss(); wob.set(key, w); return w; };
  const project = ([x, y, z]) => {
    const r = [x - C[0], y - C[1], z - C[2]], zr = r[0] * fwd[0] + r[2] * fwd[2];
    return { u: W / 2 + (f * (r[0] * right[0] + r[2] * right[2])) / zr, v: Hpx / 2 - (f * r[1]) / zr, depth: zr };
  };
  return sim.frames.map((fr) => {
    const b = fr.body, P = new Array(33);
    const put = (idx, p, lat) => { P[idx] = { p3: [facing * p[0], p[1], lat * k] }; };
    for (const [name, key, hw] of [["Shoulder", "sh"], ["Elbow", "el"], ["Wrist", "wr"], ["Index", "index"], ["Pinky", "pinky"], ["Hip", "hip"], ["Knee", "kn"], ["Ankle", "an"], ["Heel", "heel"], ["Toe", "toe"], ["Ear", "ear"]].map((x) => [...x, HALF[x[0]]])) {
      put(LM[`l${name}`], b[key], hw);
      put(LM[`r${name}`], b[key], -hw);
    }
    put(LM.nose, b.nose, 0);
    for (const [i, s] of [[1, 1], [2, 1], [3, 1], [4, -1], [5, -1], [6, -1]]) put(i, b.eye, s * HALF.Eye);
    put(LM.mouthL, b.mouth, HALF.mouth);
    put(LM.mouthR, b.mouth, -HALF.mouth);
    put(21, b.index, 0.33); put(22, b.index, -0.33); // thumbs
    const hipDepth = (project(P[LM.lHip].p3).depth + project(P[LM.rHip].p3).depth) / 2;
    const pose = P.map((q, i) => {
      const pr = project(q.p3);
      return { x: pr.u + noise * gauss() + slow(`${i}x`), y: pr.v + noise * gauss() + slow(`${i}y`), z: ((pr.depth - hipDepth) * f) / hipDepth / W + 0.02 * gauss(), v: 0.95 };
    });
    return { t: fr.t, pose };
  });
}

/* ------------------------------------------------------------------ movements */
// shape keys: [t, elbow flexion, shoulder (+ hollow / − arch, on top of following the elbow), hip (+ flexed), knee]
const kipCycle = (t0, T, depth = 1) => [
  [t0, 0, -18 * depth, -22 * depth, 8], [t0 + T / 2, 0, 22 * depth, 30 * depth, 0],
];
export const PROGRAMS = {
  /** a still hang, then kip swings that grow */
  swing: () => {
    const K = [[0, 0, 0, 0, 0], [1.5, 0, 0, 0, 0]];
    for (let i = 0; i < 6; i++) K.push(...kipCycle(2.2 + i * 1.7, 1.7, Math.min(1, 0.5 + i * 0.15)));
    K.push([2.2 + 6 * 1.7, 0, 0, 0, 0], [13, 0, 0, 0, 0]);
    return { dur: 12.5, shape: shoulderFollowsElbow(keys(K)) };
  },
  /** kipping pull-ups: a still hang, a kip swing, then reps. Each rep snaps the hips into the hollow (fastest at
   * `snap` s into the rep) and starts the elbows `lag` s after that (negative: the arms first). Without a kip
   * (depth ≈ 0), give `damp`: pulling and lowering with a free grip pumps the swing, which strict reps hold still */
  kipping: ({ reps = 3, lag = 0.15, elbow = 135, depth = 0.55, damp = 0 } = {}) => {
    const HS = [[0, 0, 0, 0, 0], [1.2, 0, 0, 0, 0]], EL = [[0, 0], [1.2, 0]];
    let t = 1.5;
    HS.push([t, 0, -16 * depth, -18 * depth, 6 * depth], [t + 0.8, 0, 16 * depth, 22 * depth, 0]);
    t += 1.6;
    const tops = [];
    for (let r = 0; r < reps; r++) {
      const snap = t + 0.25; // the middle of the 0.5 s snap
      HS.push([t, 0, -20 * depth, -26 * depth, 6 * depth], [t + 0.5, 0, 26 * depth, 50 * depth, 0], [t + 1.2, 0, 15 * depth, 22 * depth, 0], [t + 1.9, 0, -14 * depth, -14 * depth, 4 * depth]);
      const e0 = snap + lag; // the elbows start here and are bent at e0 + 0.45
      EL.push([e0 - 0.05, 0], [e0 + 0.45, elbow], [e0 + 0.7, elbow], [e0 + 1.25, 0]);
      tops.push(e0 + 0.55);
      t += 2.1;
    }
    HS.push([t + 0.2, 0, 0, 0, 0], [t + 1, 0, 0, 0, 0]);
    EL.push([t + 1, 0]);
    const hs = keys(HS), el = keys(EL.map(([tt, e]) => [tt, e, 0, 0, 0]));
    // damp: a grip that resists swinging (N·m per rad/s), as in strict reps
    return { dur: t + 0.8, tops, shape: shoulderFollowsElbow((tt) => ({ ...hs(tt), e: el(tt).e })), grip: damp ? (tt, phi, dphi) => -damp * dphi : undefined };
  },
};
/** the trunk keeps hanging while the elbow bends: the shoulder angle follows the elbow, plus hollow/arch */
function shoulderFollowsElbow(q) { return (t) => { const r = q(t); return { ...r, s: r.s + r.e }; }; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const [prog] = process.argv.slice(2);
  const arg = (k, dflt) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? Number(process.argv[i + 1]) : dflt; };
  const sim = simulate({ ...PROGRAMS[prog || "swing"](), fps: arg("fps", 60) });
  const samples = film(sim, { alpha: arg("alpha", 0), noise: arg("noise", 4) });
  process.stdout.write(JSON.stringify({ samples, truth: sim.frames.map((f) => ({ t: f.t, com: f.com, E: f.E, F: f.F, grip: f.grip })) }));
}
