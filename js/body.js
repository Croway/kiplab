/* The body from MediaPipe's 33 landmarks: points in the body's middle plane, a segment model for the centre of
 * mass, which way the athlete faces, the camera's angle to the swing, and the scale.
 *
 * The middle plane. Hanging from a bar the body moves in one plane, the one through the middle of the two hands
 * (the sagittal plane). Every left/right pair is averaged into that plane: a shoulder point, an elbow point, …
 * That also makes left/right mix-ups by the tracker harmless, which are common in a side view.
 *
 * Camera angle. Filmed at an angle α from side-on (0° side-on, 90° from the front), with the phone level, up-down
 * distances in that plane appear true and forward-back distances shrink by c = cos α. Body segments keep their
 * length while they swing, so the c that makes every segment's length steadiest over the clip is the camera's:
 * an on-screen segment (dx, dy) is √((dx/c)² + dy²) long. When the body barely changes shape (a strict pull-up)
 * that can't tell, and MediaPipe's own depth estimate of the shoulder and hip lines decides instead.
 *
 * Segments (Winter, Biomechanics and Motor Control of Human Movement, table 4.1): fraction of body mass, centre
 * of mass from the proximal end, radius of gyration about it, length as a fraction of stature. */
import { median, clamp } from "./signal.js";

// MediaPipe pose landmark indices (Bar Path's LM, plus the face and hand points)
export const LM = {
  nose: 0, lEye: 2, rEye: 5, lEar: 7, rEar: 8, mouthL: 9, mouthR: 10,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};

const avg = (...ps) => {
  let x = 0, y = 0, z = 0, v = 1;
  for (const p of ps) { x += p.x; y += p.y; z += p.z ?? 0; v = Math.min(v, p.v ?? 1); }
  return { x: x / ps.length, y: y / ps.length, z: z / ps.length, v };
};
/** a left/right pair in the middle plane: their average, or, when one is hidden behind the body (filmed side-on,
 * MediaPipe guesses it, sometimes at the hip) and the other is clearly seen, the one that's seen. Side-on the two
 * fall in the same place on screen anyway. */
function pairOf(a, b, sideOn) {
  const va = a.v ?? 1, vb = b.v ?? 1;
  if (sideOn && va < 0.5 && vb >= 0.75) return { x: b.x, y: b.y, z: b.z ?? 0, v: vb };
  if (sideOn && vb < 0.5 && va >= 0.75) return { x: a.x, y: a.y, z: a.z ?? 0, v: va };
  return avg(a, b);
}
const PAIRS = ["Shoulder", "Elbow", "Wrist", "Hip", "Knee", "Ankle"];
/** filmed side-on: one side of the body is mostly hidden (its points' visibility low through the clip). Decided
 * once per clip, so a turned camera, where both sides show, always averages them. */
export function sideOnClip(frames) {
  const v = [];
  for (const P of frames) for (const n of PAIRS) v.push(Math.min(P[LM[`l${n}`]].v ?? 1, P[LM[`r${n}`]].v ?? 1));
  return median(v) < 0.6;
}
/** every frame's points, with the clip's side-on decision */
export function bodies(frames) {
  const side = sideOnClip(frames), out = frames.map((P) => points(P, side));
  out.sideOn = side;
  return out;
}
/** the body's points in its middle plane (image px), from one frame's landmarks */
export function points(P, sideOn = false) {
  const L = (n) => P[LM[n]], pair = (n) => pairOf(L(`l${n}`), L(`r${n}`), sideOn);
  const wr = pair("Wrist");
  const mouth = avg(L("mouthL"), L("mouthR")), nose = L("nose");
  return {
    sh: pair("Shoulder"), el: pair("Elbow"), wr, hip: pair("Hip"), kn: pair("Knee"), an: pair("Ankle"), heel: pair("Heel"), toe: pair("Toe"),
    ear: pair("Ear"), nose, mouth,
    // the chin, about one and a half nose-to-mouth gaps below the mouth
    chin: { x: mouth.x + 1.5 * (mouth.x - nose.x), y: mouth.y + 1.5 * (mouth.y - nose.y), v: Math.min(mouth.v ?? 1, nose.v ?? 1) },
    // where the hand closes on the bar: between the wrist and the knuckles
    grip: avg(wr, pair("Index"), pair("Pinky")),
  };
}

/** segments: mass fraction m, centre of mass at c along from→to, radius of gyration k (× length), length × stature */
export const SEGMENTS = [
  { id: "head", m: 0.081, from: "ear", to: "ear", c: 0, k: 0, len: 0 },
  { id: "trunk", m: 0.497, from: "sh", to: "hip", c: 0.5, k: 0.29, len: 0.288 },
  { id: "upperArm", m: 0.056, from: "sh", to: "el", c: 0.436, k: 0.322, len: 0.186 },
  { id: "forearm", m: 0.044, from: "el", to: "wr", c: 0.682, k: 0.468, len: 0.146 }, // forearm and hand
  { id: "thigh", m: 0.2, from: "hip", to: "kn", c: 0.433, k: 0.323, len: 0.245 },
  { id: "shank", m: 0.093, from: "kn", to: "an", c: 0.433, k: 0.302, len: 0.246 },
  { id: "foot", m: 0.029, from: "heel", to: "toe", c: 0.5, k: 0.475, len: 0.152 },
];
/** the segments whose length gives the camera angle and the scale (they're rigid and well tracked) */
export const RIGID = SEGMENTS.filter((s) => ["trunk", "upperArm", "forearm", "thigh", "shank"].includes(s.id));
const RIGID_STATURE = RIGID.reduce((a, s) => a + s.len, 0);

/** the whole body's centre of mass from points in any one frame of reference (image or plane) */
export function centreOfMass(B) {
  let x = 0, y = 0;
  for (const s of SEGMENTS) {
    const a = B[s.from], b = B[s.to];
    x += s.m * (a.x + s.c * (b.x - a.x));
    y += s.m * (a.y + s.c * (b.y - a.y));
  }
  return { x, y };
}

/** which way the athlete faces in the picture: +1 right, −1 left (the nose is ahead of the ears) */
export function facingOf(Bs) {
  const d = [];
  for (const B of Bs) {
    if (B.nose.v > 0.3 && B.ear.v > 0.3) d.push(B.nose.x - B.ear.x);
  }
  const m = median(d);
  return { facing: m >= 0 ? 1 : -1, sure: d.length >= 5 && Math.abs(m) > 2 };
}

/* The camera. A level phone D metres from the bar, turned α from side-on, lens yc metres from the bar's height
 * (negative: below it). A point X forward and Y up in the body's plane (bar at 0) is at depth D − X·s from the
 * lens (s = ±sin α: + when the camera sees the face), so on screen, in metres at the bar's depth:
 *     ξ = X·c·D / (D − X·s)          υ = (Y − yc)·D / (D − X·s) + yc
 * Turned around, that's toPlane. D and yc aren't measured: the filming guide asks for about 4 m, phone at chest
 * height (about 1.2 m below the bar), and errors in them matter much less than α (the near side of a body 4 m away
 * looks ~10% bigger than its far side, enough to read 30° as 40° when ignored). */
export const CAMERA = { D: 4, yc: -1.2 };
export function camera(c, front, facing) {
  const s = (front ? 1 : -1) * Math.sqrt(Math.max(0, 1 - c * c));
  return { c, s, facing, D: CAMERA.D, yc: CAMERA.yc };
}
/** image px → metres in the body's plane (bar at 0, X forward, Y up); k0 = px per metre at the bar's depth */
export function toPlane(x, y, cam, Bx, By, k0) {
  const xi = (cam.facing * (x - Bx)) / k0, up = (By - y) / k0;
  const X = (xi * cam.D) / (cam.c * cam.D + xi * cam.s);
  return [X, (up - cam.yc) * (1 - (X * cam.s) / cam.D) + cam.yc];
}
/** does the camera see the face (in front of the shoulder line) rather than the back of the head? MediaPipe's
 * depth: the nose is nearer than the ears when the face is towards the camera */
export function seesFace(frames) {
  const d = [];
  for (const P of frames) { const n = P[LM.nose], a = P[LM.lEar], b = P[LM.rEar]; if (n.z !== undefined && n.v > 0.3) d.push(n.z - (a.z + b.z) / 2); }
  return d.length < 5 || median(d) <= 0;
}

/**
 * The camera's angle to the plane of the swing, from how steady the body's segments stay in length (median
 * polish of log lengths: frame × segment), with the perspective of CAMERA. frames: landmarks in image px (z in
 * MediaPipe's units). Returns { c = cos α, alpha (deg), band [lo, hi] (deg), from, spread, depth, front, curve }.
 */
export function viewAngle(frames, W, { heightM = 1.75, facing = 1, Bs = bodies(frames) } = {}) {
  const used = Bs.map((B) => RIGID.every((s) => B[s.from].v > 0.3 && B[s.to].v > 0.3));
  const rowsB = Bs.filter((_, t) => used[t]), nT = rowsB.length;
  const hang = rowsB.filter((B) => B.wr.y < B.sh.y);
  const gx = median((hang.length > 5 ? hang : rowsB).map((B) => B.grip.x)), gy = median((hang.length > 5 ? hang : rowsB).map((B) => B.grip.y));
  const front = seesFace(frames);
  // how far the segments turn: the spread of each one's direction around its own middle (circular)
  let spread = 0;
  for (const s of RIGID) {
    if (nT < 10) break;
    const a = rowsB.map((B) => Math.atan2(B[s.to].x - B[s.from].x, B[s.to].y - B[s.from].y)), m = Math.atan2(mean(a.map(Math.sin)), mean(a.map(Math.cos)));
    const dv = a.map((x) => Math.atan2(Math.sin(x - m), Math.cos(x - m)));
    spread = Math.max(spread, deg(quantileOf(dv, 0.95) - quantileOf(dv, 0.05)));
  }
  const cost = (c) => {
    if (nT < 10) return 0;
    const k0 = weakScale(rowsB, c) / heightM, cam = camera(c, front, facing);
    const P = (p) => toPlane(p.x, p.y, cam, gx, gy, k0);
    const x = RIGID.map((s) => rowsB.map((B) => { const a = P(B[s.from]), b = P(B[s.to]); return Math.log(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6); }));
    const A = new Float64Array(nT), Bk = new Float64Array(RIGID.length);
    for (let it = 0; it < 3; it++) {
      for (let t = 0; t < nT; t++) A[t] = median(x.map((r, k) => r[t] - Bk[k]));
      for (let k = 0; k < RIGID.length; k++) Bk[k] = median(x[k].map((v, t) => v - A[t]));
    }
    const res = [];
    for (let k = 0; k < RIGID.length; k++) for (let t = 0; t < nT; t++) res.push(Math.abs(x[k][t] - A[t] - Bk[k]));
    return mean(res);
  };
  const curve = [];
  let best = 1, bestCost = Infinity;
  for (let c = 1; c >= 0.3 - 1e-9; c -= 0.02) {
    const k = cost(c);
    curve.push([+c.toFixed(2), k]);
    if (k < bestCost) { bestCost = k; best = c; }
  }
  for (let c = Math.min(1, best + 0.02); c >= Math.max(0.3, best - 0.02); c -= 0.004) { const k = cost(c); if (k < bestCost) { bestCost = k; best = c; } }
  // the angles that fit about as well (within 2%): how sure the number is
  const ok = curve.filter((q) => q[1] <= bestCost * 1.02).map((q) => deg(Math.acos(clamp(q[0], 0, 1))));
  const band = [Math.min(deg(Math.acos(clamp(best, 0, 1))), ...ok), Math.max(deg(Math.acos(clamp(best, 0, 1))), ...ok)];
  const fromDepth = depthAngle(frames, W);
  if (nT >= 20 && spread >= 30) return { c: best, alpha: deg(Math.acos(clamp(best, 0, 1))), band, from: "swing", spread, depth: fromDepth, front, curve };
  if (fromDepth !== null) return { c: Math.cos(rad(fromDepth)), alpha: fromDepth, band: [Math.max(0, fromDepth - 20), Math.min(75, fromDepth + 20)], from: "depth", spread, depth: fromDepth, front, curve };
  return { c: 1, alpha: 0, band: [0, 45], from: "assumed", spread, depth: null, front, curve };
}
/** stature on screen (px) from the rigid segments, forward-back stretched by 1/c (no perspective) */
function weakScale(rows, c) {
  let sum = 0;
  for (const s of RIGID) sum += median(rows.map((B) => Math.hypot((B[s.to].x - B[s.from].x) / c, B[s.to].y - B[s.from].y)));
  return sum / RIGID_STATURE;
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
function quantileOf(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.round(clamp(q, 0, 1) * (s.length - 1))]; }

/** the angle from MediaPipe's depth: the shoulder and hip lines point at the camera when filmed side-on */
function depthAngle(frames, W) {
  const a = [];
  for (const P of frames) {
    for (const [l, r] of [[LM.lShoulder, LM.rShoulder], [LM.lHip, LM.rHip]]) {
      const p = P[l], q = P[r];
      if (p.v < 0.3 || q.v < 0.3 || p.z === undefined) continue;
      const dx = Math.abs(q.x - p.x), dz = Math.abs((q.z - p.z) * W);
      if (dx + dz > 1) a.push(deg(Math.atan2(dx, dz)));
    }
  }
  return a.length >= 10 ? median(a) : null;
}

/** pixels per metre, from the rigid segments' lengths (corrected for the camera angle) and the athlete's height */
export function bodyScale(Bs, c, heightM) {
  const lens = {};
  let sum = 0;
  for (const s of RIGID) {
    const l = [];
    for (const B of Bs) { const a = B[s.from], b = B[s.to]; if (a.v > 0.3 && b.v > 0.3) l.push(Math.hypot((b.x - a.x) / c, b.y - a.y)); }
    lens[s.id] = median(l);
    sum += lens[s.id];
  }
  const statPx = sum / RIGID_STATURE;
  return { pxPerM: statPx / heightM, statPx, lens };
}
