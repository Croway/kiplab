/* Drawing on top of the video: the skeleton, the bar's place, the centre of mass's trail coloured by speed, and the
 * force through the bar. Colours here sit on camera footage, not the page, so each mark carries a dark halo.
 * Bar Path's overlay.js with the plate swapped for the bar and the body's centre of mass. */
import { LM } from "./body.js";

const TRAIL = [[205, 226, 251], [134, 182, 239], [57, 135, 229], [28, 92, 171]]; // slow → fast
const trailColor = (k) => {
  k = Math.max(0, Math.min(1, k)) * (TRAIL.length - 1);
  const i = Math.min(TRAIL.length - 2, Math.floor(k)), f = k - i, a = TRAIL[i], b = TRAIL[i + 1];
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(",")})`;
};
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32], [0, 7], [0, 8]];

/** size the viewer to the video's shape, within the height budget */
export function fitViewer(viewer, W, H) {
  viewer.style.aspectRatio = `${W} / ${H}`;
  viewer.style.width = `min(100%, calc(var(--viewer-max-h) * ${(W / H).toFixed(4)}))`;
}

export function prepare(canvas) {
  const dpr = Math.min(3, window.devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function halo(ctx, draw, width, color) {
  ctx.lineWidth = width + 3; ctx.strokeStyle = "rgba(0,0,0,0.55)"; draw(); ctx.stroke();
  ctx.lineWidth = width; ctx.strokeStyle = color; draw(); ctx.stroke();
}

/**
 * scene: { W, H, pose?: landmarks in video px, bar?: {x, y}, com?: {x, y}, trail?: [{x, y, k}] (k = speed 0..1),
 *          force?: {x, y} (the bar's pull on the body, video px per bodyweight already applied) }
 */
export function draw(canvas, scene) {
  const { ctx, w } = prepare(canvas);
  const s = w / scene.W, X = (v) => v * s;
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  if (scene.pose) {
    const P = scene.pose;
    for (const [a, b] of BONES) {
      if (P[a].v < 0.3 || P[b].v < 0.3) continue;
      halo(ctx, () => { ctx.beginPath(); ctx.moveTo(X(P[a].x), X(P[a].y)); ctx.lineTo(X(P[b].x), X(P[b].y)); }, 1.75, "rgba(255,255,255,0.8)");
    }
    for (const j of [LM.lHip, LM.rHip, LM.lKnee, LM.rKnee, LM.lShoulder, LM.rShoulder, LM.lElbow, LM.rElbow]) {
      if (P[j].v < 0.3) continue;
      ctx.beginPath(); ctx.arc(X(P[j].x), X(P[j].y), 3, 0, 7); ctx.fillStyle = "#fff"; ctx.fill();
    }
  }

  const T = scene.trail;
  if (T && T.length > 1) {
    ctx.lineWidth = 6; ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath(); T.forEach((p, i) => (i ? ctx.lineTo(X(p.x), X(p.y)) : ctx.moveTo(X(p.x), X(p.y)))); ctx.stroke();
    ctx.lineWidth = 3;
    for (let i = 1; i < T.length; i++) {
      ctx.strokeStyle = trailColor(T[i].k);
      ctx.beginPath(); ctx.moveTo(X(T[i - 1].x), X(T[i - 1].y)); ctx.lineTo(X(T[i].x), X(T[i].y)); ctx.stroke();
    }
  }

  const b = scene.bar;
  if (b) {
    const col = "#3987e5";
    halo(ctx, () => { ctx.beginPath(); ctx.arc(X(b.x), X(b.y), 7, 0, 7); }, 2.5, col);
    if (scene.force) {
      // the bar's pull on the body, from the hands
      const fx = X(b.x) + scene.force.x * s, fy = X(b.y) + scene.force.y * s, ang = Math.atan2(fy - X(b.y), fx - X(b.x));
      halo(ctx, () => {
        ctx.beginPath(); ctx.moveTo(X(b.x), X(b.y)); ctx.lineTo(fx, fy);
        ctx.moveTo(fx, fy); ctx.lineTo(fx - 9 * Math.cos(ang - 0.45), fy - 9 * Math.sin(ang - 0.45));
        ctx.moveTo(fx, fy); ctx.lineTo(fx - 9 * Math.cos(ang + 0.45), fy - 9 * Math.sin(ang + 0.45));
      }, 3, "#eda100");
    }
  }
  const c = scene.com;
  if (c) {
    ctx.beginPath(); ctx.arc(X(c.x), X(c.y), 7, 0, 7); ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fill();
    ctx.beginPath(); ctx.arc(X(c.x), X(c.y), 5, 0, 7); ctx.fillStyle = "#3987e5"; ctx.fill();
    ctx.beginPath(); ctx.arc(X(c.x), X(c.y), 2, 0, 7); ctx.fillStyle = "#fff"; ctx.fill();
  }
}
