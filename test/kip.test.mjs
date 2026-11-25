/* The analysis against the simulator's truth (test/sim.mjs): camera angle, scale, centre of mass, energy, force
 * through the bar, physics consistency; filmed side-on and turned, with tracking noise.
 *   node test/kip.test.mjs [--verbose] */
import { simulate, film, PROGRAMS } from "./sim.mjs";
import { contactPath, where } from "../js/kipcharts.js";
import { analyse } from "../js/kip.js";

const verbose = process.argv.includes("--verbose");
let fails = 0;
const ok = (cond, msg) => { if (!cond) fails++; if (!cond || verbose) console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); };
const near = (got, want, tol, msg) => ok(Math.abs(got - want) <= tol, `${msg}: ${got.toFixed(3)} (want ${want.toFixed(3)} ± ${tol})`);
const rmsOf = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

function compare(name, sim, R) {
  // truth at the analysis grid's times
  const tr = (t) => sim.frames[Math.min(sim.frames.length - 1, Math.round(t * sim.fps))];
  const eF = [], eU = [], eE = [], eFu = [], eFf = [];
  const E0 = tr(R.T[0]).E - R.Er[0]; // the analysis's energy is relative to rest; line it up
  for (let i = 5; i < R.n - 5; i++) {
    const q = tr(R.T[i]);
    eF.push(R.comF[i] - q.com[0]); eU.push(R.comU[i] - q.com[1]);
    eE.push(R.E[i] - q.E / sim.M);
    eFu.push(R.Fu[i] - q.F[1] / (sim.M * 9.81)); eFf.push(R.Ff[i] - q.F[0] / (sim.M * 9.81));
  }
  const mE = eE.reduce((a, b) => a + b, 0) / eE.length;
  return { name, comF: rmsOf(eF), comU: rmsOf(eU), E: rmsOf(eE.map((v) => v - mE)), Fu: rmsOf(eFu), Ff: rmsOf(eFf), cons: R.consistency, alpha: R.view.alpha, from: R.view.from, k: R.scale.pxPerM };
}

// the swing: the physics (centre of mass, energy, force) and the camera angle, side-on to nearly front-on
const sim = simulate({ ...PROGRAMS.swing(), fps: 60 });
for (const alpha of [0, 30, 45, 60]) {
  for (const noise of [0, 4]) {
    const samples = film(sim, { alpha, noise, wobble: noise ? 3 : 0 });
    const R = analyse(samples, { W: 1080, heightCm: 178 });
    if (R.error) { ok(false, `swing α=${alpha} noise=${noise}: ${R.error}`); continue; }
    const c = compare(`swing α=${alpha} noise=${noise}`, sim, R);
    console.log(`${c.name}: view ${c.alpha.toFixed(1)}° (${c.from}) · com rms f ${(c.comF * 100).toFixed(1)} u ${(c.comU * 100).toFixed(1)} cm · E rms ${c.E.toFixed(2)} J/kg · F rms u ${c.Fu.toFixed(3)} f ${c.Ff.toFixed(3)} bw · consistency ${(c.cons * 100).toFixed(0)}%`);
    near(c.alpha, alpha, 8, `${c.name}: camera angle`);
    ok(c.comF < 0.03 && c.comU < 0.03, `${c.name}: centre of mass within 3 cm (rms)`);
    ok(c.E < 0.15, `${c.name}: energy within 0.15 J/kg (rms)`);
    ok(c.Fu < 0.08 && c.Ff < 0.12, `${c.name}: force through the bar within 0.08 / 0.12 bodyweights (rms)`);
    ok(c.cons > 0.5, `${c.name}: the swing explained by gravity (${(c.cons * 100).toFixed(0)}%)`);
  }
}

// kipping pull-ups: hips before arms, or arms first; reps, recognition, peak force against the truth
const timing = {};
for (const lag of [0.15, -0.15]) {
  const s = simulate({ ...PROGRAMS.kipping({ lag }), fps: 60 });
  const truthF = Math.max(...s.frames.map((q) => Math.hypot(...q.F) / (s.M * 9.81)));
  for (const alpha of [0, 40]) {
    const R = analyse(film(s, { alpha, noise: 3, wobble: 2 }), { W: 1080, heightCm: 178 });
    const name = `kipping, pull ${lag > 0 ? "after" : "before"} the hip snap, α=${alpha}`;
    if (R.error) { ok(false, `${name}: ${R.error}`); continue; }
    ok(R.move === "pullup" && R.kipping, `${name}: recognised as kipping pull-ups (${R.title})`);
    ok(R.reps.length === 3, `${name}: 3 reps (${R.reps.length})`);
    const hf = R.reps.map((r) => r.hipsFirst).sort((a, b) => a - b)[1];
    timing[`${lag}:${alpha}`] = hf;
    ok(lag > 0 ? hf > 0.1 : hf < 0.02, `${name}: hips before arms ${(hf * 1000).toFixed(0)} ms`);
    near(Math.max(...R.reps.map((r) => r.peakForce)), truthF, 0.35, `${name}: peak force through the bar (× bw)`);
  }
}
for (const alpha of [0, 40]) {
  const d = timing[`0.15:${alpha}`] - timing[`-0.15:${alpha}`];
  near(d, 0.3, 0.1, `α=${alpha}: the 0.3 s between pulling after and before the snap`);
}

// strict pull-ups: no kip
{
  const s = simulate({ ...PROGRAMS.kipping({ lag: 0.3, depth: 0.05, damp: 400 }), fps: 60 });
  const R = analyse(film(s, { alpha: 20, noise: 3, wobble: 2 }), { W: 1080, heightCm: 178 });
  ok(!R.error && R.move === "pullup" && !R.kipping && R.reps.length === 3, `strict pull-ups recognised (${R.error || R.title})`);
}
// Release, lower the hands to hip height, then remount. The two bouts must
// retain separate rep boundaries and cannot accumulate work during the break.
{
  const set = film(simulate({ ...PROGRAMS.kipping({ lag: 0.15 }), fps: 60 }), { alpha: 20 });
  const end = set.at(-1).t, dt = 1 / 60;
  const floor = Array.from({ length: 180 }, (_, i) => {
    const pose = set.at(-1).pose.map(p => ({ ...p, x: p.x + 150, y: p.y + 160 }));
    for (let j = 15; j <= 22; j++) pose[j].y = pose[23].y + 60;
    return { t: end + (i + 1) * dt, pose };
  });
  const remount = floor.at(-1).t + dt;
  const sets = [...set, ...floor, ...set.map(s => ({ ...s, t: s.t + remount }))];
  const r = analyse(sets, { W: 1080, heightCm: 178 });
  ok(r.reps?.length === 6 && r.reps[3].cycle === null && r.reps[2].kept === null,
    "release and remount start a fresh three-rep set");
  ok(r.reps?.every(q => r.tVideo(q.end) <= end + dt || r.tVideo(q.begin) >= remount - dt),
    "rep windows exclude time spent off the bar");
  const single = analyse(set, { W: 1080, heightCm: 178 });
  near(r.consistency, single.consistency, 0.025, "standing away from the bar does not distort the physics check");
  const drawn = [], starts = [];
  contactPath({ moveTo(i) { starts.push(i); drawn.push(i); }, lineTo(i) { drawn.push(i); } }, r, i => i, () => 0);
  ok(starts.length === 2 && drawn.every(i => r.held[i]) && where(r, r.indexAt(end + 1)) === "Off the bar",
    "chart paths restart after remount and the cursor identifies the break");
  const duration = r.metrics.find(m => m.label === "Analysed").value;
  near(duration, 2 * single.onBar[1], 0.1, "analysed duration counts both bouts and excludes the break");
  near(r.arm, single.arm, 0.03, "standing between bouts does not inflate hanging arm length");
  const lowered = floor.map((s, i) => {
    const w = Math.min(1, (i + 1) / 60), pose = set.at(-1).pose.map((p, j) => ({ ...p, y: p.y + w * (s.pose[j].y - p.y) }));
    return { t: s.t, pose };
  });
  const release = analyse([...set, ...lowered], { W: 1080, heightCm: 178 });
  ok(release.reps?.length === 3 && release.onBar[1] < end + 0.85, "slow dismount does not turn into support on the floor");
  const lost = set.map(s => s.t > 5.75 && s.t < 6.08 ? { ...s, pose: null } : s);
  const dropout = analyse(lost, { W: 1080, heightCm: 178 });
  ok(dropout.reps?.length === 3 && dropout.reps[1].cycle > 0, "a short pose dropout does not split a pull");
  const strict = PROGRAMS.kipping({ lag: 0.3, depth: 0.05, damp: 400 });
  const filmed = film(simulate({ ...strict, fps: 60 }), { alpha: 20 });
  const top = filmed.findIndex(s => s.t >= strict.tops[0]);
  const hold = Array.from({ length: 120 }, () => filmed[top]);
  const panned = [...filmed.slice(0, top), ...hold, ...filmed.slice(top)].map((s, i) => ({
    t: i / 60, pose: s.pose.map(p => ({ ...p, x: p.x + 80 * i / 60 })),
  }));
  const heldTop = analyse(panned, { W: 1080, heightCm: 178 });
  ok(heldTop.bouts.length === 1 && heldTop.reps.length === 3, "horizontal camera pan through a two-second bent-arm hold");
  const pan = set.map(s => ({ ...s, pose: s.pose.map(p => ({ ...p, x: p.x + 100 * Math.sin(s.t) })) }));
  const moving = analyse(pan, { W: 1080, heightCm: 178 });
  ok(moving.moving && moving.reps?.length === 3, "camera pan preserves contact and rep count");
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
